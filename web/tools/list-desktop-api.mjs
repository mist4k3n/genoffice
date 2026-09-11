#!/usr/bin/env node
/**
 * Extracts the DesktopApi method list from upstream's contract and diffs it
 * against the boot surface the phase-00 probe recorded.
 *
 * Reads upstream; never writes to it. Run: npm run api:list
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contract = resolve(here, '../../apps/sheets/src/shared/desktop-api.ts')

const source = readFileSync(contract, 'utf8')
const start = source.indexOf('export interface DesktopApi {')
if (start === -1) {
  console.error('DesktopApi interface not found — upstream moved it. Update this tool.')
  process.exit(1)
}

// Walk braces from the opening one so nested object types do not end the block early.
let depth = 0
let end = start
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1
  else if (source[i] === '}') {
    depth -= 1
    if (depth === 0) {
      end = i
      break
    }
  }
}

const body = source.slice(start, end)
const methods = [...body.matchAll(/^ {2}(\w+)\s*[(<]/gm)].map((m) => m[1])
const unique = [...new Set(methods)].sort()

/** Recorded by the phase-00 browser probe; see FINDINGS-00.md */
const bootSurface = new Set([
  'getLanguage',
  'getTheme',
  'getAiPanelPrefs',
  'getAutoSaveDefault',
  'onThemeChanged',
  'onAiPanelPrefsChanged',
  'onAutoSaveDefaultChanged',
  'onRecoveryPrompt',
  'onWorkbookRenamed',
  'onMenuAction',
  'onCloseSaveRequest',
  'onLanguageChanged',
  'notifyPendingEdits',
  'aiGskStatus',
  'getAiSettings',
  'consumeNewBlankWorkbook',
  'hasQueuedWorkbook',
])

const boot = unique.filter((m) => bootSurface.has(m))
const deferred = unique.filter((m) => !bootSurface.has(m))
const stale = [...bootSurface].filter((m) => !unique.includes(m))

console.log(`DesktopApi: ${unique.length} methods\n`)
console.log(`Boot surface (${boot.length}) — needed before the shell renders:`)
for (const m of boot) console.log(`  ${m}`)
console.log(`\nDeferred (${deferred.length}) — reached only on user action:`)
for (const m of deferred) console.log(`  ${m}`)

if (stale.length) {
  console.log(`\nWARNING: recorded in the boot surface but no longer on the interface:`)
  for (const m of stale) console.log(`  ${m}`)
  console.log('Upstream renamed or removed these. Re-run the probe.')
  process.exitCode = 1
}
