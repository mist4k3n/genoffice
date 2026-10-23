#!/usr/bin/env node
/**
 * The package, mounted by a host, in a real browser.
 *
 * Every other check stopped one step short of this. `check:lib` compiles a
 * host against the package; `check:weight` builds one and measures it;
 * `check:frame` renders an editor -- but the frame page bundles its own React,
 * so nothing in it is external. None of them ever *ran* the library build the
 * way a host does: a host's bundler, the host's React, `<SheetsEditor>` mounted
 * in the host's tree. Papan did, and the editor crashed on mount with
 * `Calling require for "react"`: an inlined CommonJS module asking for an
 * external at runtime, which only exists in that exact configuration.
 *
 * So this builds a host application with Vite from the built package (`dist/`,
 * reached through the package name and its exports map), starts the dev API on
 * a copy of the corpus, opens the page in Chromium and requires a painted grid,
 * `onLoaded`, no uncaught error -- and then edits and saves twice through the
 * grid, requiring both saves to land and no read to fail afterwards.
 *
 *   npm run check:host            # after npm run build
 *   npm run check:host -- --debug # print what the page said
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')

const SIDECAR = join(repoRoot, 'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar')
const DOCUMENT = 'acme-budget.xlsx'
const READY_TIMEOUT_MS = 60_000
const debug = process.argv.includes('--debug')

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

if (!existsSync(join(webRoot, 'dist', 'sheets-web.js'))) {
  console.error('dist/ is missing -- run npm run build first')
  process.exit(2)
}
if (!existsSync(SIDECAR)) {
  console.error(`the engine binary is missing: ${SIDECAR}`)
  console.error('build it:  npm run native:build -w @genoffice/sheets')
  process.exit(2)
}

const freePort = () =>
  new Promise((ready) => {
    const probe = createSocketServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ready(port))
    })
  })

/**
 * A host application, built the way a host builds: its own Vite, its own
 * React, the package by name. Plain `createElement`, so the host needs no JSX
 * configuration of its own -- the point is the package's behaviour, not the
 * host's toolchain.
 */
function buildHost(apiBase) {
  const root = mkdtempSync(join(tmpdir(), 'sheets-host-'))
  const modules = join(root, 'node_modules')
  // Copied, not symlinked: installed the way npm installs it, as a directory
  // with no node_modules of its own. A symlink resolves the package's own
  // `react` import from web/node_modules -- where npm put React as an
  // auto-installed peer -- and the host ends up with two Reacts and a hooks
  // crash that no real install can have.
  const installed = join(modules, '@mist4k3n', 'sheets-web')
  mkdirSync(installed, { recursive: true })
  cpSync(join(webRoot, 'package.json'), join(installed, 'package.json'))
  cpSync(join(webRoot, 'dist'), join(installed, 'dist'), { recursive: true })
  for (const dep of ['react', 'react-dom', 'zod']) {
    symlinkSync(join(repoRoot, 'node_modules', dep), join(modules, dep), 'dir')
  }
  for (const dep of ['vite', '@vitejs']) {
    symlinkSync(join(webRoot, 'node_modules', dep), join(modules, dep), 'dir')
  }
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html><body style="margin:0">
<div id="root" style="height:100vh;display:flex"></div>
<script type="module" src="/main.ts"></script></body></html>\n`,
  )
  writeFileSync(
    join(root, 'main.ts'),
    `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SheetsEditor } from '@mist4k3n/sheets-web'
import '@mist4k3n/sheets-web/style.css'

const report = (window as unknown as { __sheets: Record<string, unknown> }).__sheets = {
  loaded: false, errors: [], pending: 0, saves: 0, handle: null, dirty: [], conflicts: [],
}
createRoot(document.getElementById('root')!).render(
  createElement(SheetsEditor, {
    ref: (handle: unknown) => { report.handle = handle },
    documentId: ${JSON.stringify(DOCUMENT)},
    apiBase: ${JSON.stringify(apiBase)},
    theme: 'light',
    onLoaded: () => { report.loaded = true },
    onDirtyChange: (pending: number) => { report.pending = pending; (report.dirty as number[]).push(pending) },
    onSaved: () => { report.saves = (report.saves as number) + 1 },
    onConflict: (event: { pendingEdits: number }) => { (report.conflicts as number[]).push(event.pendingEdits) },
    onError: (error: Error) => { (report.errors as string[]).push(error.message) },
  }),
)
`,
  )
  writeFileSync(
    join(root, 'vite.config.js'),
    `import { defineConfig } from 'vite'\nexport default defineConfig({ logLevel: 'silent', build: { target: 'es2022' } })\n`,
  )
  execFileSync(join(modules, 'vite', 'bin', 'vite.js'), ['build'], { cwd: root, stdio: 'pipe' })
  return root
}

function serve(root) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname
    const file = join(root, path === '/' ? 'index.html' : path)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(response)
  })
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)))
}

async function waitForApi(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((wake) => setTimeout(wake, 200))
  }
  throw new Error(`the API never answered /health on ${port}`)
}

const failures = []
const corpus = mkdtempSync(join(tmpdir(), 'sheets-host-corpus-'))
for (const file of readdirSync(join(webRoot, 'fixtures'))) {
  if (file.endsWith('.xlsx')) cpSync(join(webRoot, 'fixtures', file), join(corpus, file))
}

const apiPort = await freePort()
console.log('building a host application from dist/ …')
const host = buildHost(`http://127.0.0.1:${apiPort}`)

console.log(`starting the API on ${apiPort} over a copy of the corpus …`)
const api = spawn(
  'npx',
  ['tsx', 'server/dev-server.ts', '--dir', corpus, '--port', String(apiPort)],
  {
    cwd: webRoot,
    stdio: 'pipe',
  },
)

let server
let browser
try {
  await waitForApi(apiPort)
  server = await serve(join(host, 'dist'))
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (error) => failures.push(`uncaught: ${error.message}`))
  if (debug) {
    page.on('console', (message) => console.log(`    [${message.type()}] ${message.text()}`))
    page.on('response', (response) => {
      const at = response.url().indexOf('/invoke/')
      if (at !== -1) console.log(`    ${response.status()} ${response.url().slice(at + 8)}`)
    })
  }

  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' })

  // A second tab on the same document, which makes no edits. When the first
  // saves, it must hear about it -- and with nothing of its own at stake.
  const other = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  other.on('pageerror', (error) => failures.push(`second tab, uncaught: ${error.message}`))
  await other.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' })

  const painted = () =>
    [...document.querySelectorAll('canvas')].some((c) => c.width > 200 && c.height > 100)
  try {
    await page.waitForFunction(painted, null, { timeout: READY_TIMEOUT_MS })
  } catch {
    failures.push('no grid painted within 60s')
  }
  try {
    await page.waitForFunction(() => window.__sheets?.loaded === true, null, { timeout: 10_000 })
  } catch {
    failures.push('onLoaded never fired')
  }
  // Edit, save, edit, save -- through the grid, the way a person does. The
  // second save is the point: after the first, the renderer installs the
  // session the save returned and closes the one it replaced, and when the
  // server kept the id it closed the session it was about to read through.
  // Every read after that answered 410 and the grid went blank (Papan, D2).
  const lostReads = []
  page.on('response', (response) => {
    if (!response.url().includes('/invoke/workbook:read-range')) return
    if (response.status() >= 400) lostReads.push(response.status())
  })
  const grid = page.locator('canvas').filter({ visible: true }).last()
  const box = await grid.boundingBox()
  for (const [index, text] of ['first', 'second'].entries()) {
    if (!box) {
      failures.push('no grid to edit')
      break
    }
    // Two different cells well inside the sheet area, below the headers.
    await page.mouse.click(box.x + box.width * (0.3 + index * 0.2), box.y + box.height * 0.5)
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    try {
      await page.waitForFunction(() => window.__sheets.pending > 0, null, { timeout: 10_000 })
    } catch {
      failures.push(`edit ${index + 1} never registered as a pending edit`)
      break
    }
    if (debug)
      console.log(
        `    dirty so far: ${JSON.stringify(await page.evaluate(() => window.__sheets.dirty))}`,
      )
    await page.evaluate(() => window.__sheets.handle.save())
    try {
      await page.waitForFunction((n) => window.__sheets.saves >= n, index + 1, { timeout: 30_000 })
    } catch {
      failures.push(`save ${index + 1} never landed`)
      break
    }
    // A landed save leaves nothing pending. Waiting for that is what makes the
    // next edit's "pending > 0" mean *that* edit rather than a stale count.
    try {
      await page.waitForFunction(() => window.__sheets.pending === 0, null, { timeout: 10_000 })
    } catch {
      failures.push(`after save ${index + 1} the editor still reports pending edits`)
      break
    }
  }
  // The tab that made no edits heard both saves, and had nothing at stake.
  try {
    await other.waitForFunction(() => window.__sheets.conflicts.length > 0, null, {
      timeout: 10_000,
    })
    const heard = await other.evaluate(() => window.__sheets.conflicts)
    if (heard.some((pending) => pending !== 0)) {
      failures.push(`the tab with no edits was told it had unsaved edits: ${JSON.stringify(heard)}`)
    }
  } catch {
    failures.push('the second tab never heard that the document moved')
  }

  // A page that opens hidden -- a workbook Cmd-clicked into a background tab
  // -- must not mount until it is seen, and must paint once it is (Papan, D6).
  // Headless Chromium has no real background tab, so visibility is reported
  // rather than earned: this checks the editor's own deferral, not Chromium's
  // throttling, which is what the deferral exists to avoid.
  const hidden = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  hidden.on('pageerror', (error) => failures.push(`hidden tab, uncaught: ${error.message}`))
  await hidden.addInitScript(() => {
    let state = 'hidden'
    Object.defineProperty(document, 'visibilityState', { get: () => state, configurable: true })
    Object.defineProperty(document, 'hidden', { get: () => state === 'hidden', configurable: true })
    window.__reveal = () => {
      state = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })
  await hidden.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' })
  await hidden.waitForTimeout(2_000)
  if (await hidden.evaluate(painted))
    failures.push('a hidden page mounted its grid before it was seen')
  await hidden.evaluate(() => window.__reveal())
  try {
    await hidden.waitForFunction(painted, null, { timeout: READY_TIMEOUT_MS })
  } catch {
    failures.push('a page that opened hidden never painted after it became visible')
  }

  // Let the post-save reinstall and its reads settle before judging them.
  await page.waitForTimeout(3_000)
  if (lostReads.length > 0) {
    failures.push(`reads failed after a save: ${lostReads.join(', ')} -- the session was lost`)
  }
  try {
    await page.waitForFunction(painted, null, { timeout: 5_000 })
  } catch {
    failures.push('the grid is no longer painted after saving')
  }

  const reported = await page.evaluate(() => window.__sheets?.errors ?? [])
  for (const message of reported) failures.push(`onError: ${message}`)
} finally {
  await browser?.close()
  server?.close()
  api.kill()
  rmSync(host, { recursive: true, force: true })
  rmSync(corpus, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('check:host failed')
  for (const line of [...new Set(failures)]) console.error(`  ${line}`)
  process.exit(1)
}
console.log('check:host ok -- a Vite host mounts the packaged editor, edits and saves twice')
