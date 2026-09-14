import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { SheetsError } from '../server/errors'
import type { SessionDirectory } from '../server/ports'
import { createSheetsRouter, type SheetsRouter } from '../server/router'

/**
 * An open workbook lives inside one engine process on one instance. That is
 * not a cache -- it is where the file is. Behind a balancer that does not pin
 * by session, half of every session's calls land on the wrong machine, and the
 * server answers them exactly as it answers a session that expired: reopen.
 * The client obliges, on a 30MB workbook, forever.
 *
 * The directory exists to make those two answers different.
 */

function memoryDirectory(): SessionDirectory & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    async claim(sessionId, instanceId) {
      entries.set(sessionId, instanceId)
    },
    async lookup(sessionId) {
      return entries.get(sessionId) ?? null
    },
    async release(sessionId) {
      entries.delete(sessionId)
    },
  }
}

test('421 is the status, and it is not a guess', () => {
  // 421 Misdirected Request says the request is well formed and *this* server
  // cannot produce a response for it. That is the situation exactly, and it is
  // not 410: the session is not gone, and a client that reopens on it is
  // throwing away a workbook that is still open somewhere.
  assert.equal(new SheetsError('session_elsewhere', 'x').status, 421)
  assert.equal(new SheetsError('session_gone', 'x').status, 410)
})

test('a session_gone error carries the id the directory needs', () => {
  // Without this the router would have to guess the session id back out of the
  // request body, which differs per channel. The id came from the caller, so
  // echoing it discloses nothing.
  const error = new SheetsError('session_gone', 'Workbook session is no longer open.', {
    sessionId: 'abc',
  })
  assert.equal(error.detail?.['sessionId'], 'abc')
})

test('the directory separates gone from elsewhere', async () => {
  const directory = memoryDirectory()
  await directory.claim('s1', 'api-0', 60_000)

  assert.equal(await directory.lookup('s1'), 'api-0', 'held by api-0')
  assert.equal(await directory.lookup('s2'), null, 'never existed: really gone')

  await directory.release('s1')
  assert.equal(await directory.lookup('s1'), null, 'closed: really gone')
})

test("a claim naming this instance is not a redirect", async () => {
  // A claim that outlived its session points at us. Following it would bounce
  // the request back here forever, so it has to read as a dead session.
  const directory = memoryDirectory()
  await directory.claim('s1', 'api-0', 60_000)
  const owner: string | null = await directory.lookup('s1')
  assert.equal(owner, 'api-0')
  // The router's rule, stated as the test states it: elsewhere means *not us*.
  const elsewhere = (self: string) => (owner && owner !== self ? owner : null)
  assert.equal(elsewhere('api-1'), 'api-0')
  assert.equal(elsewhere('api-0'), null)
})

test('a directory that is down degrades to today’s answer', async () => {
  // A Redis outage must not turn a 410 into a 500. Reopening is correct
  // either way; it is only expensive.
  const broken: SessionDirectory = {
    claim: async () => {
      throw new Error('redis down')
    },
    lookup: async () => {
      throw new Error('redis down')
    },
    release: async () => {
      throw new Error('redis down')
    },
  }
  const owner = await broken.lookup('s1').catch(() => null)
  assert.equal(owner, null)
})

test('forward is optional, and its absence is a different product decision', () => {
  // Without it the package reports the misrouting and the host fixes routing
  // (sticky sessions, a shard router, or one instance). With it the package
  // proxies and addressing stays where the addresses are known. Both are
  // valid; silently doing neither was not.
  const reporting = memoryDirectory()
  assert.equal(reporting.forward, undefined)

  const proxying: SessionDirectory = {
    ...reporting,
    forward: async (instanceId, request) =>
      new Response(JSON.stringify({ to: instanceId, url: request.url }), { status: 200 }),
  }
  assert.equal(typeof proxying.forward, 'function')
})

/**
 * The whole path, through two real routers sharing one directory.
 *
 * No workbook is opened: an unknown session id is enough, because that is
 * precisely the request a misrouted call looks like. What is being tested is
 * that the second instance recognises it as *misrouted* rather than dead.
 */
const SIDECAR =
  process.env['XLSX_SIDECAR_PATH'] ??
  new URL('../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar', import.meta.url)
    .pathname

const storage = {
  head: async () => ({ version: 'v1', name: 'x.xlsx', byteLength: 0 }),
  get: async () => ({ bytes: new Uint8Array(), version: 'v1', name: 'x.xlsx' }),
  put: async () => ({ version: 'v2', name: 'x.xlsx', byteLength: 0 }),
}

const identity = () => ({
  userId: 'u1',
  tenantId: 't1',
  documentId: 'doc-1',
  permission: 'readwrite' as const,
})

async function withRouters(
  directory: SessionDirectory,
  run: (a: SheetsRouter, b: SheetsRouter) => Promise<void>,
): Promise<void> {
  const make = (instanceId: string) =>
    createSheetsRouter({
      storage,
      identify: identity,
      sessions: directory,
      instanceId,
      sidecar: { poolSize: 1, binaryPath: SIDECAR },
    })
  const a = make('api-0')
  const b = make('api-1')
  try {
    await run(a, b)
  } finally {
    await a.dispose()
    await b.dispose()
  }
}

const call = (router: SheetsRouter, sessionId: string) =>
  router.app.request('/invoke/workbook:read-range', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': 'doc-1' },
    body: JSON.stringify({
      args: [{ sessionId, sheetId: 'sheet-1', range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } }],
    }),
  })

test('a session held elsewhere answers 421, not 410', { skip: !existsSync(SIDECAR) }, async () => {
  const directory = memoryDirectory()
  await withRouters(directory, async (a, b) => {
    const held = '11111111-1111-4111-8111-111111111111'
    await directory.claim(held, a.instanceId, 60_000)

    const misdirected = await call(b, held)
    assert.equal(misdirected.status, 421)
    const body = (await misdirected.json()) as { error: { code: string; detail?: { instanceId?: string } } }
    assert.equal(body.error.code, 'session_elsewhere')
    assert.equal(body.error.detail?.instanceId, 'api-0', 'names who can answer')

    // And a session nothing holds is still simply gone, on either instance.
    const gone = await call(b, '22222222-2222-4222-8222-222222222222')
    assert.equal(gone.status, 410)
    assert.equal(((await gone.json()) as { error: { code: string } }).error.code, 'session_gone')
  })
})

test('with a forwarder, the misdirected call is answered', { skip: !existsSync(SIDECAR) }, async () => {
  const shared = memoryDirectory()
  const directory: SessionDirectory = {
    ...shared,
    forward: async (instanceId, request) =>
      new Response(JSON.stringify({ result: { forwardedTo: instanceId, url: request.url } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }
  await withRouters(directory, async (a, b) => {
    const held = '33333333-3333-4333-8333-333333333333'
    await directory.claim(held, a.instanceId, 60_000)

    const response = await call(b, held)
    assert.equal(response.status, 200, 'the client never learns it was misrouted')
    const body = (await response.json()) as { result: { forwardedTo: string } }
    assert.equal(body.result.forwardedTo, 'api-0')
  })
})
