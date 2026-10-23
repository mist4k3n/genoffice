import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHttpTransport } from '../src/host/transport'

/**
 * What a host passes to the transport reaches the wire.
 *
 * Three of these came from Papan's integration: a relative `apiBase` built no
 * socket at all, because `new URL()` without a base throws on a relative URL
 * (D7); there was no way to send the host's own headers; and no way to send a
 * cookie to an API on another origin of the same site.
 */

/** A WebSocket that records the URL it was asked for and never connects. */
function recordingSocket(urls: string[]): typeof WebSocket {
  return class {
    constructor(url: string) {
      urls.push(url)
    }
    addEventListener(): void {}
    close(): void {}
  } as unknown as typeof WebSocket
}

/** Runs `body` with a page location, the way a browser has one. */
async function atPage<T>(href: string, body: () => Promise<T> | T): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: new URL(href), configurable: true })
  try {
    return await body()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else delete (globalThis as { location?: unknown }).location
  }
}

test('a relative apiBase opens the push socket on the page’s own host', async () => {
  const urls: string[] = []
  await atPage('https://app.example.com/files/123', () => {
    const transport = createHttpTransport({
      baseUrl: '/sheets-api',
      documentId: 'doc-1',
      webSocketImpl: recordingSocket(urls),
    })
    transport.subscribe('any', () => {})
    transport.dispose()
  })
  assert.deepEqual(urls, ['wss://app.example.com/sheets-api/events?doc=doc-1'])
})

test('an absolute apiBase is used as it stands', async () => {
  const urls: string[] = []
  await atPage('https://app.example.com/', () => {
    const transport = createHttpTransport({
      baseUrl: 'http://api.example.com/sheets/',
      webSocketImpl: recordingSocket(urls),
    })
    transport.subscribe('any', () => {})
    transport.dispose()
  })
  assert.deepEqual(urls, ['ws://api.example.com/sheets/events'])
})

test('a base no URL can be made from is reported, not swallowed', async () => {
  const problems: string[] = []
  // No page location: a relative base has nothing to resolve against.
  const transport = createHttpTransport({
    baseUrl: '/sheets-api',
    webSocketImpl: recordingSocket([]),
    onConnectionProblem: (error) => void problems.push(error.message),
  })
  transport.subscribe('any', () => {})
  transport.dispose()
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /push socket/)
})

test('credentials and host headers reach every request', async () => {
  const seen: RequestInit[] = []
  const transport = createHttpTransport({
    baseUrl: 'https://api.example.com/sheets',
    documentId: 'doc-1',
    credentials: 'include',
    headers: () => ({ 'x-tenant': 't-42' }),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push(init)
      return new Response(JSON.stringify({ result: null }), { status: 200 })
    }) as typeof fetch,
    webSocketImpl: recordingSocket([]),
  })
  await transport.invoke('app:get-language')
  transport.dispose()

  assert.equal(seen[0]?.credentials, 'include')
  const headers = seen[0]?.headers as Record<string, string>
  assert.equal(headers['x-tenant'], 't-42')
  assert.equal(
    headers['x-document-id'],
    'doc-1',
    'the host’s headers add to ours, not replace them',
  )
})

test('without a credentials option, fetch keeps its own default', async () => {
  const seen: RequestInit[] = []
  const transport = createHttpTransport({
    baseUrl: 'https://api.example.com/sheets',
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push(init)
      return new Response(JSON.stringify({ result: null }), { status: 200 })
    }) as typeof fetch,
    webSocketImpl: recordingSocket([]),
  })
  await transport.invoke('app:get-language')
  transport.dispose()
  assert.equal('credentials' in (seen[0] ?? {}), false)
})
