#!/usr/bin/env node
/**
 * Phase-01 mock host server.
 *
 * Implements only the boot surface — the 17 channels the renderer reaches
 * before the shell is interactive — plus the WebSocket push endpoint. Enough to
 * prove the HTTP host works end to end without waiting for phase 02's real Hono
 * kernel.
 *
 * Deliberately dependency-free (node:http + a hand-rolled WebSocket handshake)
 * so `web/` stays installable with three devDependencies.
 *
 * Run: npm run mock        # http://127.0.0.1:5274
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import { loadChannelConstants } from './upstream-channels.mjs'

/**
 * Read upstream's channel names instead of retyping them. Two of the handlers
 * below used to be spelled by hand and both were wrong; the app still booted,
 * because the coverage table was wrong in exactly the same way. Deriving both
 * from the same source removes that failure mode.
 */
const CH = loadChannelConstants()
const channel = (name) => {
  const value = CH.get(name)
  if (!value) throw new Error(`IPC_CHANNELS.${name} not found — upstream renamed it`)
  return value
}

const PORT = Number(process.env.SHEETS_MOCK_PORT) || 5274
const VERBOSE = process.argv.includes('--verbose')

/**
 * channel → handler. Keys are upstream's real channels: `app:*` and the two
 * `sheets:*` queue probes are string literals in the preload too, so they are
 * literals here; the rest resolve through IPC_CHANNELS.
 */
const handlers = {
  'app:get-language': () => 'en',
  'app:get-theme': () => 'system',
  'app:get-auto-save-default': () => false,
  'app:get-ai-panel-prefs': () => ({}),
  [channel('pendingEditsChanged')]: () => undefined,
  [channel('aiGskStatus')]: () => ({ loggedIn: false }),
  [channel('aiGetSettings')]: () => ({
    provider: 'none',
    model: '',
    spellcheck: true,
  }),
  'sheets:consume-new-blank': () => false,
  'sheets:has-queued-workbook': () => false,
  [channel('openExternal')]: ([url]) => {
    console.log(`  [mock] openExternal ${String(url).slice(0, 120)}`)
    return undefined
  },
}

const sockets = new Set()

/** Push a frame to every connected client, in the transport's envelope shape. */
export function broadcast(channel, ...args) {
  const frame = encodeFrame(JSON.stringify({ channel, args }))
  for (const socket of sockets) socket.write(frame)
}

// ── minimal WebSocket (RFC 6455) — text frames, server→client only ──────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin
  const cors = {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-headers': 'content-type, x-document-id, authorization',
    'access-control-allow-methods': 'POST, OPTIONS',
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  const match = url.pathname.match(/^\/invoke\/(.+)$/)
  if (request.method !== 'POST' || !match) {
    response.writeHead(404, { ...cors, 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }))
    return
  }

  const channel = decodeURIComponent(match[1])
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let args = []
  try {
    args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').args ?? []
  } catch {
    /* empty body is fine */
  }

  const handler = handlers[channel]
  if (!handler) {
    if (VERBOSE) console.log(`  [mock] 501 ${channel}`)
    response.writeHead(501, { ...cors, 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        error: {
          code: 'not_implemented',
          message: `mock server has no handler for ${channel} (phase 02)`,
        },
      }),
    )
    return
  }

  if (VERBOSE) console.log(`  [mock] 200 ${channel}`)
  const result = await handler(args)
  response.writeHead(200, { ...cors, 'content-type': 'application/json' })
  response.end(JSON.stringify({ result: result ?? null }))
})

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  sockets.add(socket)
  console.log(`  [mock] websocket connected (${sockets.size} open)`)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => sockets.delete(socket))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Sheets host on http://127.0.0.1:${PORT}`)
  console.log(`  ${Object.keys(handlers).length} channels implemented; everything else returns 501`)
  console.log(`  push endpoint: ws://127.0.0.1:${PORT}/events`)
  console.log('\nDemonstrate a push (theme change) at any time:')
  console.log('  type "dark" or "light" here and press enter\n')
})

// Typing a theme name pushes it, which exercises the WebSocket path the same
// way the shell's theme switch does in Electron.
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line) => {
  const theme = line.trim()
  if (theme === 'dark' || theme === 'light' || theme === 'system') {
    broadcast('app:theme-changed', theme)
    console.log(`  [mock] pushed app:theme-changed ${theme} to ${sockets.size} client(s)`)
  }
})
