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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const rendererRoot = join(repoRoot, 'apps/sheets/src/renderer')

/** Reads that are correct, with the reason each one is. */
const ALLOWED = new Map([
  ['main.tsx', 'the desktop entry point, which has exactly one editor by construction'],
  ['host-api.ts', 'the fallback that makes every other site default to desktop behaviour'],
  ['App.tsx', 'the default for the `api` prop'],
  ['csv-export.ts', 'fallback when no workbook is open'],
  ['page-layout-actions.ts', 'fallback when no workbook is open'],
  ['ai/create-document.ts', 'fallback when no workbook is open'],
  ['univer-state.ts', 'a doc comment naming the global it replaces'],
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
let allowedCount = 0

for (const file of walk(rendererRoot)) {
  const rel = relative(rendererRoot, file)
  const source = readFileSync(file, 'utf8')
  const hits = source.split('\n').reduce((count, line, index) => {
    if (!line.includes('window.desktopApi')) return count
    if (ALLOWED.has(rel)) {
      allowedCount += 1
      return count
    }
    offenders.push(`${rel}:${index + 1}`)
    return count + 1
  }, 0)
  void hits
}

console.log(
  `scanned the renderer: ${allowedCount} allowed global read(s), ` +
    `${offenders.length} stray`,
)
if (offenders.length === 0) {
  console.log('\n  OK — every host call resolves a per-instance bridge')
  process.exit(0)
}
console.log('')
for (const where of offenders) console.log(`  STRAY  ${where}`)
console.log(
  '\n  Resolve the bridge the way its neighbours do — `hostApi`, `state.api`,\n' +
    '  `useHostApi()`, `ctx.api`, or an `api` parameter. See UPSTREAM-CHANGES.md.',
)
process.exit(1)
