#!/usr/bin/env node
/**
 * Guard the one piece of upstream implementation this fork copies.
 *
 * `web/server/channels/save-plan.ts` mirrors `writeWorkbookTo` from
 * `apps/sheets/src/main/sheets-main.ts` verbatim, because it is a pure
 * function that upstream does not export (see that file's header for why
 * copying beat rewriting). A copy is only safe if divergence is detected, so
 * this hashes upstream's function text and compares it against the recorded
 * baseline.
 *
 * When it fails, the fix is to re-copy upstream's version wholesale and update
 * MIRROR_SHA -- not to reconcile the two by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const baselineFile = resolve(here, '../mirror-baseline.json')

const MIRRORS = [
  {
    name: 'writeWorkbookTo',
    upstream: 'apps/sheets/src/main/sheets-main.ts',
    copy: 'web/server/channels/save-plan.ts',
    // Located by name rather than line number so ordinary edits elsewhere in
    // the 4000-line file do not produce a false alarm.
    start: 'async function writeWorkbookTo(',
    end: '\n}\n',
  },
]

/** Upstream's function text, from its signature to its closing brace. */
function extract(mirror) {
  const source = readFileSync(resolve(repoRoot, mirror.upstream), 'utf8')
  const from = source.indexOf(mirror.start)
  if (from < 0) {
    throw new Error(`${mirror.name} no longer exists in ${mirror.upstream} — it may have moved`)
  }
  const to = source.indexOf(mirror.end, from)
  if (to < 0) throw new Error(`could not find the end of ${mirror.name}`)
  return source.slice(from, to + 2)
}

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
const update = process.argv.includes('--update')
const problems = []

for (const mirror of MIRRORS) {
  const text = extract(mirror)
  const sha = createHash('sha256').update(text).digest('hex')
  const recorded = baseline[mirror.name]

  if (update) {
    baseline[mirror.name] = { sha, lines: text.split('\n').length, upstream: mirror.upstream }
    console.log(`  UPDATED ${mirror.name} → ${sha.slice(0, 12)}`)
    continue
  }

  if (!recorded) {
    problems.push(`${mirror.name} has no recorded baseline`)
    continue
  }
  if (recorded.sha !== sha) {
    problems.push(
      `${mirror.name} changed upstream\n` +
        `      recorded ${recorded.sha.slice(0, 16)} (${recorded.lines} lines)\n` +
        `      current  ${sha.slice(0, 16)} (${text.split('\n').length} lines)\n` +
        `      re-copy it into ${mirror.copy}, then run: npm run check:mirror -- --update`,
    )
    continue
  }
  console.log(`  ${mirror.name.padEnd(20)} unchanged (${recorded.lines} lines, ${sha.slice(0, 12)})`)
}

if (update) {
  writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
  process.exit(0)
}

console.log()
if (problems.length === 0) {
  console.log('  OK — every mirrored implementation matches upstream')
  process.exit(0)
}
for (const problem of problems) console.log(`  DIVERGED ${problem}`)
process.exit(1)
