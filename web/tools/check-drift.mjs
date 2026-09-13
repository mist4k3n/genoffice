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

// The fork now carries a deliberate upstream change (see UPSTREAM-CHANGES.md).
// The invariant is no longer "nothing differs" but "only what we declared
// differs" — which keeps the same discipline: an undeclared edit outside web/
// is still a failure, and every declared one has a written justification.
const declared = JSON.parse(readFileSync(resolve(here, '../upstream-changes.json'), 'utf8'))
const declaredFiles = new Set(declared.files)
// A declaration may name a directory of siblings that can only ever change
// together. The i18n shards are the case: each carries
// `satisfies Record<keyof typeof zh, string>`, so adding one key to one shard
// is a type error in the other nineteen -- the set is all-or-nothing by
// construction, and listing twenty one-line inserts individually buries what
// the fork actually changed. `*` matches within one directory segment only, so
// a glob can never quietly absorb a file from somewhere else.
const declaredGlobs = (declared.fileGroups ?? []).map((group) => ({
  pattern: group.pattern,
  match: new RegExp(`^${group.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`),
}))
const isDeclared = (file) =>
  declaredFiles.has(file) || declaredGlobs.some((group) => group.match.test(file))
const undeclared = changed.filter((f) => !isDeclared(f))
const stale = [
  ...[...declaredFiles].filter((f) => !changed.includes(f)),
  ...declaredGlobs.filter((g) => !changed.some((f) => g.match.test(f))).map((g) => g.pattern),
]

console.log(`Invariant: only declared upstream files differ from ${base}`)
if (undeclared.length === 0) {
  console.log(
    `  OK — ${changed.length} declared file(s) differ` +
      `${declaredGlobs.length > 0 ? ` (${declaredGlobs.length} via group(s))` : ''}` +
      `, nothing undeclared (web/UPSTREAM-CHANGES.md)\n`,
  )
} else {
  failed = true
  console.log(`  VIOLATED — ${undeclared.length} undeclared file(s) outside web/ differ:\n`)
  for (const f of undeclared) console.log(`    ${f}`)
  console.log('\n  Each of these makes every future rebase conflict.')
  console.log('  Move it into web/, or — if the change is genuinely necessary —')
  console.log('  declare it in web/upstream-changes.json AND justify it in')
  console.log('  web/UPSTREAM-CHANGES.md. Read that file before adding to the list.\n')
}
// A declared file that no longer differs is stale bookkeeping, usually because
// upstream adopted the change. Worth saying, not worth failing over.
for (const f of stale) console.log(`  NOTE — ${f} is declared but matches upstream\n`)

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
