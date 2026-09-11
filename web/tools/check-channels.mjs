#!/usr/bin/env node
/**
 * Verify that every channel name in web/src/host/coverage.ts is a channel the
 * upstream preload actually passes to ipcRenderer, for that same method.
 *
 * This closes the one drift class the TypeScript detector cannot see. The
 * coverage table is typed `Record<keyof DesktopApi, Entry>`, so a renamed or
 * removed *method* is a compile error. A channel is just a string: if upstream
 * renames `workbook:read-pivot-definition`, or if we simply guessed the name
 * wrong, everything still compiles and the call 404s at runtime.
 *
 * So instead of trusting the literals, extract method -> channel from the
 * preload itself (see upstream-channels.mjs) and diff. Run it in CI and after
 * every rebase.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadChannelConstants, loadPreloadChannels } from './upstream-channels.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const read = (p) => readFileSync(resolve(repoRoot, p), 'utf8')

/**
 * Our table: method -> declared channel + status.
 *
 * `channel` is written three ways and all three must resolve, or an entry is
 * silently skipped and this whole check passes vacuously: `IPC_CHANNELS.foo`
 * (the normal case), a bare string literal (the channels the preload also
 * hardcodes), and `null` (methods the preload answers without IPC).
 */
function loadCoverage(constants) {
  const source = read('web/src/host/coverage.ts')
  const start = source.indexOf('export const COVERAGE')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const map = new Map()
  for (const [, method, entry] of body.matchAll(/^ {2}(\w+):\s*(\{[^}]*\})/gm)) {
    const status = /status:\s*'(\w+)'/.exec(entry)?.[1]
    const raw = /channel:\s*(IPC_CHANNELS\.(\w+)|'[^']*'|null)/.exec(entry)
    if (!status || !raw) throw new Error(`COVERAGE entry ${method} is not parseable`)
    const [, expr, constName] = raw
    let channel
    if (expr === 'null') channel = null
    else if (constName) {
      channel = constants.get(constName)
      if (!channel) throw new Error(`COVERAGE.${method} uses IPC_CHANNELS.${constName}, undefined`)
    } else channel = expr.slice(1, -1)
    map.set(method, { channel, status })
  }
  if (map.size === 0) throw new Error('COVERAGE parsed empty')
  return map
}

const constants = loadChannelConstants()
const preload = loadPreloadChannels(constants)
const coverage = loadCoverage(constants)

const problems = []
for (const [method, { channel, status }] of coverage) {
  const actual = preload.get(method)
  const usesNoIpc = !actual || actual.size === 0
  if (channel === null) {
    // Declaring null is a claim about upstream, so verify it: if the preload
    // grows an ipcRenderer call here, we want to know.
    if (!usesNoIpc) {
      problems.push({ kind: 'mismatch', method, declared: 'null', actual: [...actual], status })
    }
    continue
  }
  if (usesNoIpc) {
    problems.push({ kind: 'mismatch', method, declared: channel, actual: ['(no IPC call)'], status })
    continue
  }
  if (!actual.has(channel)) {
    problems.push({ kind: 'mismatch', method, declared: channel, actual: [...actual], status })
  }
}
for (const method of preload.keys()) {
  if (!coverage.has(method)) problems.push({ kind: 'unknown-method', method })
}

const width = Math.max(...coverage.keys().map((k) => k.length))
console.log(`checked ${coverage.size} coverage entries against ${preload.size} preload methods\n`)

const mismatches = problems.filter((p) => p.kind === 'mismatch')
for (const p of mismatches) {
  console.log(
    `  WRONG  ${p.method.padEnd(width)}  declared ${p.declared}  actual ${p.actual.join(', ')}`,
  )
}
for (const p of problems.filter((p) => p.kind === 'unknown-method')) {
  console.log(`  EXTRA  ${p.method.padEnd(width)}  in preload, missing from COVERAGE`)
}

if (mismatches.length === 0) {
  console.log('\n  OK — every declared channel matches the preload')
  process.exit(0)
}
console.log(`\n  ${mismatches.length} channel name(s) do not match upstream`)
process.exit(1)
