#!/usr/bin/env node
/**
 * Two jobs, both meant for CI:
 *
 *   1. Enforce the invariant — nothing outside web/ may differ from upstream.
 *   2. Report movement in the DRIFT.md watch list — files we mirror rather than
 *      modify, which therefore rebase cleanly and would otherwise diverge
 *      silently.
 *
 * ## The two jobs need two different reference points
 *
 * They are easy to conflate and were, which made this check lie in both
 * directions after a plain `git fetch upstream`.
 *
 * The **invariant** asks what *we* changed, so it compares the working tree
 * against the upstream commit the tree actually descends from — the merge base
 * of HEAD and the upstream ref. Compared against a *moved* upstream tip
 * instead, every file upstream has touched since reads as our edit: fetching
 * 860 commits turned "nothing undeclared" into 4,006 violations, none of them
 * ours.
 *
 * The **watch list** asks what *upstream* changed under us, so it compares the
 * reviewed baseline in DRIFT.md against the upstream tip. Pin that half to the
 * merge base and it can only ever report nothing, which is the same lie the
 * other way round.
 *
 * So: `--base` is the upstream ref (default `upstream/main`, and the thing to
 * fetch); the invariant derives its own reference from it. `--invariant-base`
 * overrides that derivation, which is only interesting while a merge is in
 * progress.
 *
 * Run: npm run check:drift [-- --base upstream/main] [-- --invariant-base <ref>]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 ? process.argv[index + 1] : fallback
}

/** The upstream ref: what upstream looks like now. */
const base = flag('base', 'upstream/main')

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd()

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

/**
 * The upstream commit this tree descends from, which is what the invariant
 * measures against. Overridable, because during a merge the merge base is
 * briefly not the commit anyone means.
 */
let held = flag('invariant-base', null)
if (held === null) {
  try {
    held = git('merge-base', 'HEAD', base)
  } catch {
    console.error(`No common ancestor between HEAD and "${base}".`)
    console.error('Fetch the upstream remote, or pass --invariant-base explicitly.')
    process.exit(2)
  }
}
const heldShort = git('rev-parse', '--short', held)

let failed = false

// ── 1. The invariant ────────────────────────────────────────────────────────
// Tracked divergence from the upstream commit we hold, plus anything untracked
// — a new file added under apps/ is just as much a future conflict as an edited
// one, and `git diff` alone would not see it.
const tracked = git('diff', '--name-only', held, '--').split('\n')
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
  match: new RegExp(
    `^${group.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
  ),
}))
const isDeclared = (file) =>
  declaredFiles.has(file) || declaredGlobs.some((group) => group.match.test(file))
const undeclared = changed.filter((f) => !isDeclared(f))
const stale = [
  ...[...declaredFiles].filter((f) => !changed.includes(f)),
  ...declaredGlobs.filter((g) => !changed.some((f) => g.match.test(f))).map((g) => g.pattern),
]

console.log(
  `Invariant: only declared upstream files differ from ${heldShort} (the upstream commit this tree holds)`,
)
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
/**
 * The watch list, read out of DRIFT.md's table.
 *
 * Structurally -- first cell of every table row -- rather than by matching the
 * row's exact punctuation. The previous pattern wanted a backtick followed
 * immediately by ` |`, so the first time Prettier padded that table into
 * columns the list silently fell from thirteen files to one, and the check
 * reported "no watched file changed upstream" while eight of them had been
 * rewritten. A check that goes quiet when its input is reformatted is worse
 * than no check.
 *
 * A trailing parenthetical is dropped, so the `desktop-api.ts (schemas)` row
 * resolves to the same file as its sibling and dedupes.
 */
// Only the watch-list table. The file also carries tables of local patches and
// of proposals, whose first cells are prose.
const watchSection = driftDoc.slice(driftDoc.indexOf('## Watched files'))
const nextHeading = watchSection.indexOf('\n## ')
const rows = (nextHeading === -1 ? watchSection : watchSection.slice(0, nextHeading))
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .map((line) => (line.split('|')[1] ?? '').trim())
const paths = rows.map((cell) =>
  cell
    .replaceAll('`', '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim(),
)
const isWatchedPath = (cell) => /^[\w./-]+\.(?:ts|tsx|html|json)$/.test(cell) && cell.includes('/')
const watched = [...new Set(paths.filter(isWatchedPath))]
// A row that looks like it names a file and does not parse is the silent
// failure above, arriving again. Say so rather than shrinking the list.
const unparsed = rows.filter(
  (cell, index) => cell.includes('`') && cell.includes('/') && !isWatchedPath(paths[index]),
)

if (!baselineMatch) {
  console.error('DRIFT.md has no "Baseline upstream SHA" line — cannot report movement.')
  process.exit(2)
}
const baseline = baselineMatch[1]

// A reviewed baseline that is not the commit the tree holds is bookkeeping
// drift of its own: either a merge landed and DRIFT.md was not bumped, or the
// watch list was reviewed ahead of a merge. Worth saying; not worth failing.
if (!held.startsWith(baseline) && !baseline.startsWith(heldShort)) {
  console.log(
    `  NOTE — DRIFT.md's reviewed baseline is ${baseline}, and this tree holds ${heldShort}.` +
      ' One of the two is behind.\n',
  )
}

for (const cell of unparsed) {
  failed = true
  console.log(`  UNPARSED — DRIFT.md row "${cell}" names a file the watch list cannot read\n`)
}

console.log(`Watch list: ${watched.length} file(s) between ${baseline} and ${base}`)
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
