#!/usr/bin/env node
/**
 * The A1 acceptance test: a host application can import this package and
 * typecheck against it.
 *
 * It builds a throwaway consumer outside this repository -- its own tsconfig,
 * its own node_modules with this package symlinked in -- and compiles it. That
 * is deliberately more work than pointing tsc at `dist/sheets-web.d.ts` with a
 * `paths` mapping, because the mapping would pass while the package's
 * `exports` map was wrong, and the exports map is half of what A1 delivers.
 *
 * Three things are checked:
 *
 * 1. The build's artefacts exist: the module, its stylesheet, its declaration.
 * 2. A consumer compiles against the package name -- component, props, ref,
 *    and the event payload types -- under `strict` and `exactOptionalPropertyTypes`.
 * 3. A deep import into `src/` does NOT compile. The relative paths into
 *    `apps/sheets` are this fork's business; a consumer that can reach them
 *    has a dependency nobody agreed to.
 *
 * Run it after `npm run build`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')
const pkg = JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: webRoot,
    encoding: 'utf8',
  }),
)

const failures = []

/** Step 1: the build produced what the exports map promises -- all of it. */
const promised = Object.entries(pkg.exports)
  .filter(([subpath]) => subpath !== './package.json')
  .flatMap(([, target]) => (typeof target === 'string' ? [target] : Object.values(target)))
for (const rel of promised) {
  const file = resolve(webRoot, rel)
  if (!existsSync(file))
    failures.push(`${rel} is in the exports map and not on disk -- run npm run build`)
}
if (failures.length > 0) {
  for (const line of failures) console.error(`  ${line}`)
  process.exit(1)
}

/** Steps 2 and 3: a consumer, compiled. */
const consumer = mkdtempSync(join(tmpdir(), 'sheets-web-consumer-'))
const modules = join(consumer, 'node_modules')
mkdirSync(join(modules, '@mist4k3n'), { recursive: true })
mkdirSync(join(modules, '@types'), { recursive: true })

symlinkSync(webRoot, join(modules, '@mist4k3n', 'sheets-web'), 'dir')
// A host's own React, and the types our declarations lean on.
for (const dep of ['react', 'react-dom', 'zod']) {
  symlinkSync(join(repoRoot, 'node_modules', dep), join(modules, dep), 'dir')
}
for (const types of ['react', 'react-dom']) {
  symlinkSync(
    join(repoRoot, 'node_modules', '@types', types),
    join(modules, '@types', types),
    'dir',
  )
}

writeFileSync(
  join(consumer, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        // What a host application on Vite or webpack 5 uses, and the only
        // resolution mode that reads the exports map.
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: ['host.tsx'],
    },
    null,
    2,
  ),
)

writeFileSync(
  join(consumer, 'host.tsx'),
  `import { useRef } from 'react'
import { SheetsEditor } from '@mist4k3n/sheets-web'
import type {
  HostTheme,
  SheetsConflictEvent,
  SheetsExport,
  SheetsHandle,
  SheetsSavedEvent,
  SheetsSelection,
  WorkbookFile,
} from '@mist4k3n/sheets-web'

export function DocumentDeck(props: { id: string; theme: HostTheme; active: boolean }) {
  const editor = useRef<SheetsHandle>(null)
  const save = () => void editor.current?.save({ overwrite: true })
  const copy = async (): Promise<SheetsExport> => {
    const handle = editor.current
    if (handle === null) throw new Error('not mounted')
    return handle.exportBytes()
  }
  void save
  void copy
  return (
    <SheetsEditor
      ref={editor}
      documentId={props.id}
      apiBase="/sheets"
      theme={props.theme}
      locale="ms-MY"
      visible={props.active}
      onLoaded={(file: WorkbookFile) => console.log(file.name, file.sheets.length)}
      onDirtyChange={(pending: number) => console.log(pending)}
      onSaved={(event: SheetsSavedEvent) => console.log(event.touchedEntries.length)}
      onConflict={(event: SheetsConflictEvent) => console.log(event.currentVersion, event.source)}
      onSelectionChange={(selection: SheetsSelection | null) => console.log(selection?.range)}
      onSaveAsRequest={(event: SheetsExport) => console.log(event.suggestedName)}
      onError={(error: Error) => console.error(error)}
    />
  )
}
`,
)

/**
 * This repository's compiler, by path. The consumer is outside the repository
 * and has no TypeScript of its own, and `npx tsc` there installs a 2016
 * package of that name from the registry.
 */
const tscBin = join(webRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const tsc = (cwd, project) => {
  try {
    execFileSync(process.execPath, [tscBin, '-p', project], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return null
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
  }
}

const compiled = tsc(consumer, 'tsconfig.json')
if (compiled !== null) failures.push(`the consumer does not typecheck:\n${compiled}`)

/** Step 3. The same consumer, plus one import that must not resolve. */
writeFileSync(
  join(consumer, 'deep.ts'),
  `// @ts-expect-error the exports map must not expose this fork's internals
import { InlineSheets } from '@mist4k3n/sheets-web/src/embed/SheetsEditor'
void InlineSheets
`,
)
writeFileSync(
  join(consumer, 'tsconfig.deep.json'),
  JSON.stringify({ extends: './tsconfig.json', include: ['deep.ts'] }, null, 2),
)
// Inverted on purpose: the import is marked `@ts-expect-error`, so tsc passes
// when it does not resolve and fails ("unused directive") when it does.
const leak = tsc(consumer, 'tsconfig.deep.json')
if (leak !== null) {
  failures.push(`a deep import into src/ resolves through the exports map:\n${leak}`)
}

rmSync(consumer, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('check:lib failed')
  for (const line of failures) console.error(`  ${line}`)
  process.exit(1)
}
console.log('check:lib ok -- a host can import @mist4k3n/sheets-web and typecheck against it')
