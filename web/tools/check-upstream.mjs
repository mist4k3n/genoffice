#!/usr/bin/env node
/**
 * Upstream's own compiler and test suite still pass.
 *
 * `npm run typecheck` here compiles the *browser* project, which does not
 * include `apps/sheets/tests`. That gap was not theoretical: threading the host
 * bridge through `LazyWorkbookState` broke 34 upstream tests, and nothing said
 * so for four commits. The tests build their state with
 * `as unknown as LazyWorkbookState`, so a missing field is not a type error --
 * it is `undefined` at runtime, in a test that then fails for a reason that
 * looks like a product bug.
 *
 * A fork that ships upstream's code owes it upstream's own green suite. This
 * check is what makes that a rule rather than an intention.
 *
 * One pre-existing failure is allowed and listed, because it fails at the
 * baseline commit too and is not ours to fix. A listed failure that starts
 * passing is also an error: a stale allowance hides the next real one.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')

const { allowedFailures } = JSON.parse(readFileSync(join(webRoot, 'upstream-changes.json'), 'utf8'))

function run(command, args) {
  try {
    return { ok: true, output: execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' }) }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

console.log("Upstream's own project must still compile and pass\n")

const typecheck = run('npx', ['tsc', '-p', 'apps/sheets/tsconfig.json', '--noEmit'])
if (!typecheck.ok) {
  console.log(typecheck.output.split('\n').slice(0, 20).join('\n'))
  console.log('\n  apps/sheets does not typecheck')
  process.exit(1)
}
console.log('  OK — apps/sheets typechecks')

const tests = run('npx', ['vitest', 'run', 'apps/sheets/tests', '--reporter=json'])
// vitest writes the report to stdout; anything before the first `{` is noise.
const report = JSON.parse(tests.output.slice(tests.output.indexOf('{')))

const failed = report.testResults
  .flatMap((file) => file.assertionResults.map((test) => ({ ...test, file: file.name })))
  .filter((test) => test.status === 'failed')
  .map((test) => test.fullName ?? test.title)

const unexpected = failed.filter((name) => !allowedFailures.includes(name))
const stale = allowedFailures.filter((name) => !failed.includes(name))

for (const name of unexpected) console.log(`  BROKEN    ${name}`)
for (const name of stale) console.log(`  STALE     ${name} — passes now; drop it from the list`)

if (unexpected.length === 0 && stale.length === 0) {
  console.log(`  OK — ${report.numPassedTests} passing, ${failed.length} known failure(s)`)
  process.exit(0)
}
console.log(`\n  ${unexpected.length} unexpected failure(s), ${stale.length} stale allowance(s)`)
process.exit(1)
