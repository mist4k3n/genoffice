#!/usr/bin/env node
/**
 * Two jobs, both meant for CI:
 *
 *   1. Enforce the invariant — nothing outside web/ may differ from upstream.
 *   2. Report movement in the DRIFT.md watch list — files we mirror rather than
 *      modify, which therefore rebase cleanly and would otherwise diverge
 *      silently.
 *
 * Run: npm run check:drift [-- --base upstream/main]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const baseArg = process.argv.indexOf('--base')
const base = baseArg !== -1 ? process.argv[baseArg + 1] : 'upstream/main'

const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd()

function baseExists() {
  try {
    git('rev-parse', '--verify', `${base}^{commit}`)
    return true
  } catch {
    return false
  }
}

if (!baseExists()) {
  console.error(`Cannot resolve "${base}".`)
  console.error('Add the upstream remote and fetch it:')
  console.error('  git remote add upstream https://github.com/genspark-ai/genoffice.git')
  console.error('  git fetch upstream')
  process.exit(2)
}

let failed = false

// ── 1. The invariant ────────────────────────────────────────────────────────
// Tracked divergence from the base, plus anything untracked — a new file added
// under apps/ is just as much a future conflict as an edited one, and `git diff`
// alone would not see it.
const tracked = git('diff', '--name-only', base, '--').split('\n')
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n')

const changed = [...new Set([...tracked, ...untracked])]
  .filter(Boolean)
  .filter((f) => !f.startsWith('web/'))
  .sort()

console.log(`Invariant: nothing outside web/ differs from ${base}`)
if (changed.length === 0) {
  console.log('  OK — fork delta is entirely under web/\n')
} else {
  failed = true
  console.log(`  VIOLATED — ${changed.length} file(s) outside web/ differ:\n`)
  for (const f of changed) console.log(`    ${f}`)
  console.log('\n  Each of these makes every future rebase conflict.')
  console.log('  Move it into web/, send it upstream as a PR, or record it as a')
  console.log('  tracked patch under web/patches/ (see PLAN.md, escalation policy).\n')
}

// ── 2. Watch-list movement ──────────────────────────────────────────────────
const driftDoc = readFileSync(resolve(here, '../DRIFT.md'), 'utf8')
const baselineMatch = driftDoc.match(/Baseline upstream SHA:\s*`([0-9a-f]{7,40})`/)
const watched = [...driftDoc.matchAll(/^\| `([^`]+\.(?:ts|tsx|html))` \|/gm)].map((m) => m[1])

if (!baselineMatch) {
  console.error('DRIFT.md has no "Baseline upstream SHA" line — cannot report movement.')
  process.exit(2)
}
const baseline = baselineMatch[1]

console.log(`Watch list: ${watched.length} file(s) since ${baseline}`)
const moved = []
for (const file of watched) {
  const stat = git('diff', '--numstat', baseline, base, '--', file)
  if (stat) moved.push({ file, stat: stat.split('\t').slice(0, 2).join('+/-') })
}

if (moved.length === 0) {
  console.log('  OK — no watched file changed upstream\n')
} else {
  console.log(`  ${moved.length} watched file(s) moved — review each:\n`)
  for (const { file, stat } of moved) console.log(`    ${file}  (${stat})`)
  console.log('\n  Review the diffs, port any behavior change into web/, then bump')
  console.log(`  "Baseline upstream SHA" in DRIFT.md to the reviewed commit.\n`)
  console.log('  git diff ' + baseline + ' ' + base + ' -- <file>\n')
  // Movement is a review signal, not a failure — CI should surface it, not block.
}

process.exit(failed ? 1 : 0)
