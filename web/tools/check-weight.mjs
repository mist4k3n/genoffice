#!/usr/bin/env node
/**
 * The A4 acceptance test: a host's initial payload is unchanged by importing
 * this package.
 *
 * The editor is 12 MB, 3 MB gzipped, and that is the editor itself -- Univer's
 * locales are already split per language. The number is fine behind a lazy
 * route and not fine in an app shell every page loads, so `src/embed/editor.tsx`
 * puts the inline editor behind a dynamic import: importing the package costs
 * a wrapper, and the editor's chunks arrive when an editor first mounts.
 *
 * Asserting that on our own output would prove the wrong thing -- what matters
 * is what a host's bundler emits. So this builds two host applications with
 * Vite, identical except that one imports `<SheetsEditor>` and renders it and
 * the other renders a placeholder, and compares what each one's page loads
 * before anything is interacted with: the entry chunk plus everything the HTML
 * preloads, which is exactly the set a browser fetches on first paint.
 *
 * The difference is this integration's cost. It is allowed to be a wrapper and
 * not an editor.
 *
 *   npm run check:weight
 */
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')

/**
 * What the wrapper is allowed to add to a host's first paint. It is a
 * component that decides between an iframe and a dynamic import; a few tens of
 * kilobytes is the honest size of that, and anything approaching the editor's
 * megabytes means the split has come undone.
 */
const BUDGET_BYTES = 60 * 1024
/** The editor must still be in the output -- lazily, not tree-shaken away. */
const EDITOR_MIN_BYTES = 2 * 1024 * 1024

const failures = []

function scaffold(app, entry) {
  const root = mkdtempSync(join(tmpdir(), `sheets-weight-${app}-`))
  const modules = join(root, 'node_modules')
  mkdirSync(join(modules, '@mist4k3n'), { recursive: true })

  symlinkSync(webRoot, join(modules, '@mist4k3n', 'sheets-web'), 'dir')
  // The host's own React, and the compiler and bundler it builds with.
  for (const dep of ['react', 'react-dom', 'zod']) {
    symlinkSync(join(repoRoot, 'node_modules', dep), join(modules, dep), 'dir')
  }
  for (const dep of ['vite', 'esbuild', '@vitejs']) {
    symlinkSync(join(webRoot, 'node_modules', dep), join(modules, dep), 'dir')
  }

  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html><body><div id="root"></div>
<script type="module" src="/main.ts"></script></body></html>\n`,
  )
  writeFileSync(join(root, 'main.ts'), entry)
  writeFileSync(
    join(root, 'vite.config.js'),
    `import { defineConfig } from 'vite'\nexport default defineConfig({ build: { target: 'es2022' }, logLevel: 'silent' })\n`,
  )

  execFileSync(join(modules, 'vite', 'bin', 'vite.js'), ['build'], { cwd: root, stdio: 'pipe' })
  return root
}

/**
 * The bytes a browser fetches before anything happens: the entry script and
 * everything the HTML tells it to preload. Vite preloads a chunk's *static*
 * imports; a dynamically imported chunk is fetched by the import itself, which
 * is the whole point of the measurement.
 */
function initialPayload(root) {
  const dist = join(root, 'dist')
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  let javascript = 0
  let stylesheet = 0
  for (const ref of refs) {
    if (!ref.startsWith('/')) continue
    const size = statSync(join(dist, ref.slice(1))).size
    if (ref.endsWith('.css')) stylesheet += size
    else javascript += size
  }
  return { javascript, stylesheet }
}

/** The largest chunk in the build, which is the editor when there is one. */
function largestChunk(root) {
  const assets = join(root, 'dist', 'assets')
  const sizes = readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .map((file) => statSync(join(assets, file)).size)
  return Math.max(0, ...sizes)
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

console.log('building two host applications …')
const baseline = scaffold(
  'baseline',
  `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

createRoot(document.getElementById('root')).render(createElement('div', null, 'no editor here'))
`,
)
const embedding = scaffold(
  'embedding',
  `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SheetsEditor } from '@mist4k3n/sheets-web'

createRoot(document.getElementById('root')).render(
  createElement(SheetsEditor, { documentId: 'a-workbook.xlsx', apiBase: '/sheets' }),
)
`,
)

try {
  const before = initialPayload(baseline)
  const after = initialPayload(embedding)
  const delta = after.javascript - before.javascript

  console.log(`  a host without the editor:  ${kb(before.javascript)} on first paint`)
  console.log(`  the same host with it:      ${kb(after.javascript)} on first paint`)
  console.log(`  this integration's cost:    ${kb(delta)}`)

  if (delta > BUDGET_BYTES) {
    failures.push(
      `importing the package adds ${kb(delta)} to a host's first paint, over the ${kb(BUDGET_BYTES)} budget` +
        ' -- the editor is no longer behind its dynamic import',
    )
  }

  const editor = largestChunk(embedding)
  console.log(`  the editor, lazily:         ${kb(editor)}`)
  if (editor < EDITOR_MIN_BYTES) {
    failures.push(
      `the largest chunk is ${kb(editor)}, too small to be the editor` +
        ' -- it was tree-shaken away rather than deferred, and nothing here is being measured',
    )
  }
} finally {
  rmSync(baseline, { recursive: true, force: true })
  rmSync(embedding, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('check:weight failed')
  for (const line of failures) console.error(`  ${line}`)
  process.exit(1)
}
console.log('check:weight ok -- the editor is fetched when it mounts, not when it is imported')
