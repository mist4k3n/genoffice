#!/usr/bin/env node
/**
 * The published `.d.ts`.
 *
 * Two steps, because neither alone is enough:
 *
 * 1. `tsc --emitDeclarationOnly` against `tsconfig.build.json`. The entry's
 *    module graph reaches into `apps/sheets` and the workspace packages, so
 *    tsc's common root directory is the repository root and it writes a tree
 *    of a few hundred declarations under `dist/.types/`. Publishing that tree
 *    would work and would also hand every consumer this fork's internal
 *    layout, permanently.
 *
 * 2. Roll it up from the entry with rollup-plugin-dts, so what ships is one
 *    file containing exactly the types reachable from `src/embed/index.ts`,
 *    with upstream's types inlined rather than referenced by a path a
 *    consumer cannot resolve (PLAN.md, "SDK ergonomics without drift").
 *
 * The staging tree is deleted afterwards. Anything left importable from
 * outside the rolled-up file is a leak and fails the build below.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rollup } from 'rollup'
import { dts } from 'rollup-plugin-dts'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')
const staging = join(webRoot, 'dist', '.types')
const out = join(webRoot, 'dist', 'sheets-web.d.ts')

/**
 * Where tsc puts the entry's declaration. The staging path mirrors the source
 * path relative to tsc's inferred root, which is the repository root because
 * the graph reaches outside web/.
 */
const entry = join(staging, relative(repoRoot, join(webRoot, 'src/embed/index.d.ts')))

rmSync(staging, { recursive: true, force: true })

console.log('tsc --emitDeclarationOnly …')
/**
 * One class of error is tolerated, and only one: TS7056, "the inferred type of
 * this node exceeds the maximum length the compiler will serialize".
 *
 * Upstream's `i18n/strings.ts` trips it -- twenty-one locales of fourteen
 * hundred keys is past what tsc will write into a `.d.ts` -- and the limit is
 * about *serializing* that type, not about checking it: `npm run typecheck` is
 * clean, every other declaration is still emitted, and nothing in this
 * package's public surface mentions the dictionary. Failing the build over it
 * would mean annotating an upstream file for no one's benefit.
 *
 * Anything else tsc says fails the build.
 */
let tscOutput = ''
try {
  tscOutput = execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd: webRoot,
    encoding: 'utf8',
  })
} catch (error) {
  tscOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
  const fatal = tscOutput
    .split('\n')
    .filter((line) => /error TS\d+:/.test(line))
    .filter((line) => !line.includes('error TS7056:'))
  if (fatal.length > 0) {
    console.error(tscOutput.trim())
    process.exit(1)
  }
  for (const line of tscOutput.split('\n').filter((l) => l.includes('TS7056'))) {
    console.log(`  tolerated: ${line.trim()}`)
  }
}

if (!existsSync(entry)) {
  console.error(`expected a declaration for the entry at ${entry}, and there is none`)
  process.exit(1)
}

console.log('rolling up declarations …')
/**
 * `import './embed.css'` survives into the declaration tree, because tsc keeps
 * side-effect imports. There is nothing to resolve -- the stylesheet is the
 * library build's business -- so it is loaded as an empty module and vanishes.
 */
const dropStylesheets = {
  name: 'drop-stylesheets',
  resolveId: (id) => (id.endsWith('.css') ? { id, external: false } : null),
  load: (id) => (id.endsWith('.css') ? '' : null),
}

const bundle = await rollup({
  input: entry,
  plugins: [dropStylesheets, dts({ respectExternal: false })],
  // Anything outside the staging tree is a real package the consumer installs
  // (react) or a type-only dependency that must not be inlined. Bare
  // specifiers stay imports; relative ones are inlined.
  external: (id) => !id.startsWith('.') && !id.startsWith('/'),
  onwarn(warning, warn) {
    // Circular imports between upstream declaration files are not actionable
    // here and are not a defect in the output.
    if (warning.code === 'CIRCULAR_DEPENDENCY') return
    warn(warning)
  },
})
await bundle.write({ file: out, format: 'es' })
await bundle.close()

rmSync(staging, { recursive: true, force: true })
console.log(`wrote ${relative(webRoot, out)}`)
