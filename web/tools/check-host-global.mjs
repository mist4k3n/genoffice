#!/usr/bin/env node
/**
 * Fail on a `window.desktopApi` read that has not been threaded.
 *
 * The fork gives each editor its own host bridge so one page can hold several
 * documents (see UPSTREAM-CHANGES.md). A stray global read reintroduces the
 * exact bug that change exists to remove — an editor addressing whichever
 * document claimed the global last — and it does so silently, because the
 * global is real and the call succeeds.
 *
 * Typecheck cannot see this: `window.desktopApi` is declared and valid
 * everywhere. So it is checked by name, and the small number of legitimate
 * uses are listed rather than pattern-matched, so adding one is deliberate.
 *
 * Each allowed file carries **how many** reads are legitimate, not just that
 * some are. A file-level pass hid eight of them: the 2026-10 upstream merge
 * added new `window.desktopApi` calls to `App.tsx`, which is allowed one (the
 * default for its `api` prop), and the check stayed green while the embedded
 * editor crashed on `getUserDisplayName` of undefined -- the global does not
 * exist in a browser, which is the entire point of the change this check
 * protects. A count turns that into a failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const rendererRoot = join(repoRoot, 'apps/sheets/src/renderer')

/** Reads that are correct: how many each file may have, and why. */
const ALLOWED = new Map([
  [
    'main.tsx',
    { reads: null, why: 'the desktop entry point, which has exactly one editor by construction' },
  ],
  [
    'host-api.ts',
    { reads: 4, why: 'the fallback that makes every other site default to desktop behaviour' },
  ],
  ['App.tsx', { reads: 1, why: 'the default for the `api` prop' }],
  ['csv-export.ts', { reads: 1, why: 'fallback when no workbook is open' }],
  ['page-layout-actions.ts', { reads: 2, why: 'fallback when no workbook is open' }],
  ['ai/create-document.ts', { reads: 2, why: 'fallback when no workbook is open' }],
  ['univer-state.ts', { reads: 1, why: 'a doc comment naming the global it replaces' }],
])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(path)) out.push(path)
  }
  return out
}

const offenders = []
const overruns = []
let allowedCount = 0

for (const file of walk(rendererRoot)) {
  const rel = relative(rendererRoot, file)
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  const hits = lines.flatMap((line, index) =>
    line.includes('window.desktopApi') ? [index + 1] : [],
  )
  if (hits.length === 0) continue

  const allowance = ALLOWED.get(rel)
  if (allowance === undefined) {
    for (const line of hits) offenders.push(`${rel}:${line}`)
    continue
  }
  allowedCount += hits.length
  // `null` means "as many as it likes": main.tsx is the desktop entry and has
  // one editor by construction, so a count there would be churn with no
  // meaning. Every other allowance is exact.
  if (allowance.reads !== null && hits.length !== allowance.reads) {
    overruns.push(
      `${rel} has ${hits.length} global read(s), and ${allowance.reads} ${
        allowance.reads === 1 ? 'is' : 'are'
      } allowed (${allowance.why}) -- lines ${hits.join(', ')}`,
    )
  }
}

console.log(
  `scanned the renderer: ${allowedCount} allowed global read(s), ` + `${offenders.length} stray`,
)
if (offenders.length === 0 && overruns.length === 0) {
  console.log('\n  OK — every host call resolves a per-instance bridge')
  process.exit(0)
}
console.log('')
for (const where of offenders) console.log(`  STRAY  ${where}`)
for (const line of overruns) console.log(`  COUNT  ${line}`)
console.log(
  '\n  Resolve the bridge the way its neighbours do — `hostApi`, `state.api`,\n' +
    '  `useHostApi()`, `ctx.api`, or an `api` parameter. See UPSTREAM-CHANGES.md.',
)
process.exit(1)
