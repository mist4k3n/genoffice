#!/usr/bin/env node
/**
 * Two invariants for web/server/ that the compiler cannot enforce here.
 *
 * 1. No browser globals. The server and the browser build share one tsconfig
 *    (see the comment in tsconfig.json for why a DOM-free server config is not
 *    possible without drift), so DOM declarations are in scope on the server.
 *    That is not theoretical: the first draft of the router kept a
 *    `Set<WebSocket>` and compiled cleanly against a global Node does not have.
 *
 * 2. The coverage table and the channel handlers agree, in BOTH directions.
 *    A channel marked 'http' with no handler is a promise the app discovers at
 *    runtime as a 501. A handler whose channel is still marked 'todo' is worse
 *    and quieter: the work is done, the server answers it, and the browser
 *    never calls it -- it rejects locally with NotImplementedError instead.
 *    That is exactly what happened to open/read-range/close, and only checking
 *    the first direction would not have caught it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadChannelConstants } from './upstream-channels.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const serverRoot = join(webRoot, 'server')

/** Globals that exist in a browser and not in Node. */
const BROWSER_GLOBALS = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'WebSocket',
  'XMLHttpRequest',
  'requestAnimationFrame',
  'HTMLElement',
  'CustomEvent',
  'MessageEvent',
  'alert',
]

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

/** Strip comments and string literals so a global named in prose is not a hit. */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

const files = walk(serverRoot)
const globalHits = []
for (const file of files) {
  const code = stripNonCode(readFileSync(file, 'utf8'))
  const lines = code.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const name of BROWSER_GLOBALS) {
      // Skip property access (`foo.window`) and declarations of our own names.
      if (new RegExp(`(?<![.\\w$])${name}\\b`).test(line)) {
        globalHits.push({ file: file.slice(webRoot.length + 1), line: index + 1, name })
      }
    }
  }
}

/** Every COVERAGE entry, with its resolved channel and status. */
function coverageEntries() {
  const constants = loadChannelConstants()
  const source = readFileSync(join(webRoot, 'src/host/coverage.ts'), 'utf8')
  const start = source.indexOf('export const COVERAGE')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const out = []
  for (const [, method, entry] of body.matchAll(/^ {2}(\w+):\s*(\{[^}]*\})/gm)) {
    const status = /status:\s*'(\w+)'/.exec(entry)?.[1]
    const raw = /channel:\s*(IPC_CHANNELS\.(\w+)|'[^']*'|null)/.exec(entry)
    if (!status || !raw) throw new Error(`COVERAGE.${method} is not parseable`)
    const [, expr, constName] = raw
    const channel = expr === 'null' ? null : constName ? constants.get(constName) : expr.slice(1, -1)
    out.push({ method, channel, status })
  }
  return out
}

/** Channels with a handler registered anywhere under server/channels/. */
function servedChannels() {
  const constants = loadChannelConstants()
  const served = new Set()
  for (const file of files.filter((f) => f.includes(`${'channels'}/`))) {
    const code = readFileSync(file, 'utf8')
    const table = code.slice(code.indexOf('ChannelTable = {'))
    for (const [, constName] of table.matchAll(/\[IPC_CHANNELS\.(\w+)\]/g)) {
      const value = constants.get(constName)
      if (value) served.add(value)
    }
    for (const [, literal] of table.matchAll(/^\s*'([^']+)':/gm)) served.add(literal)
  }
  return served
}

const served = servedChannels()
const entries = coverageEntries()

const unserved = entries.filter((entry) => entry.status === 'http' && !served.has(entry.channel))
// The reverse: a handler exists, but the browser still refuses to call it.
const unclaimed = entries.filter(
  (entry) => entry.status === 'todo' && entry.channel !== null && served.has(entry.channel),
)

console.log(`scanned ${files.length} server files; ${served.size} channel(s) served\n`)

for (const hit of globalHits) {
  console.log(`  BROWSER GLOBAL  ${hit.file}:${hit.line}  ${hit.name}`)
}
for (const entry of unserved) {
  console.log(`  UNSERVED        ${entry.method} → ${entry.channel} is 'http' with no handler`)
}
for (const entry of unclaimed) {
  console.log(
    `  UNCLAIMED       ${entry.method} → ${entry.channel} is served, but COVERAGE says 'todo'`,
  )
}

if (globalHits.length === 0 && unserved.length === 0 && unclaimed.length === 0) {
  console.log('  OK — no browser globals, and coverage matches the handlers both ways')
  process.exit(0)
}
process.exit(1)
