#!/usr/bin/env node
/**
 * The A3 acceptance test: a compare view renders two grids.
 *
 * `isolate` is the one case that needs a second realm -- Univer's internal
 * editor hosts carry fixed element ids, so two visible grids collide in one
 * document -- and the second realm is an iframe running `sheets-frame.html`.
 * Everything about that is invisible to a type checker: whether the page is
 * reachable where `frameSrc` says, whether its bundle boots, whether the
 * protocol handshake completes, whether a grid actually paints inside it.
 *
 * So this drives a real browser. It builds the pages and the packaged frame,
 * starts the dev API server on a copy of the corpus, serves both builds from
 * one origin, opens the harness with the compare view already mounted, and
 * waits for a painted canvas in each realm.
 *
 * It runs twice, because there are two frame pages a host can serve:
 *
 * - the page build's own `sheets-frame.html`, reached by the default relative
 *   `frameSrc`;
 * - the one shipped inside the package at `dist/frame/`, reached by pointing
 *   `frameSrc` at it the way a host would.
 *
 *   npm run check:frame
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
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
/** Opening a workbook is a real round trip through a real engine process. */
const READY_TIMEOUT_MS = 60_000

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
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

/** Serves several build directories from one origin, each under its own prefix. */
function serveRoots(roots) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const entry = Object.entries(roots).find(([prefix]) => path.startsWith(prefix))
    if (!entry) {
      response.writeHead(404).end()
      return
    }
    const [prefix, root] = entry
    const file = join(root, path.slice(prefix.length))
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(response)
  })
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => ready(server))
  })
}

async function waitForApi(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((wake) => setTimeout(wake, 200))
  }
  throw new Error(`the API never answered /health on ${port}`)
}

const debug = process.argv.includes('--debug')
const failures = []

/**
 * One compare view, end to end.
 *
 * `frameSrc` is null for the default (the page build's own frame page beside
 * the harness) and a path for the packaged one.
 */
async function checkCompareView(browser, origin, label, frameSrc) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await context.newPage()
  const crashes = []
  page.on('pageerror', (error) => crashes.push(`${label}: uncaught ${error.message}`))
  // `--debug` prints what both realms said, which is the only way to tell a
  // frame that never handshook from one that loaded and then failed.
  if (debug) {
    page.on('console', (message) => {
      const where = message.location().url.includes('frame') ? 'frame' : 'host'
      console.log(`    [${where}] ${message.type()}: ${message.text()}`)
    })
  }

  const query = new URLSearchParams({ docs: DOCUMENT, compare: 'all' })
  if (frameSrc !== null) query.set('frame', frameSrc)
  await page.goto(`${origin}/host/harness.html?${query}`, { waitUntil: 'domcontentloaded' })

  /**
   * A grid that has painted: a canvas with real pixels behind it.
   *
   * A function, deliberately, and not a string: Playwright evaluates a string
   * as an expression, so `'() => …'` is a function object -- truthy, resolving
   * the wait instantly and asserting nothing.
   */
  const painted = () =>
    [...document.querySelectorAll('canvas')].some((c) => c.width > 200 && c.height > 100)

  try {
    await page.waitForFunction(painted, null, { timeout: READY_TIMEOUT_MS })
  } catch {
    failures.push(`${label}: the host's own grid never painted`)
  }

  const frames = page.frames().filter((frame) => frame !== page.mainFrame())
  if (frames.length !== 1) {
    failures.push(`${label}: expected exactly one frame, found ${frames.length}`)
  } else {
    try {
      await frames[0].waitForFunction(painted, null, { timeout: READY_TIMEOUT_MS })
    } catch {
      failures.push(`${label}: the isolated grid never painted inside the frame`)
    }
    if (debug) {
      const detail = await frames[0].evaluate(() => ({
        url: location.href,
        canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height}`),
        rootChildren: document.getElementById('sheets-frame-root')?.childElementCount ?? -1,
      }))
      console.log(`    frame: ${JSON.stringify(detail)}`)
    }
    const url = frames[0].url()
    const expected = frameSrc === null ? '/host/sheets-frame.html' : frameSrc
    if (!url.includes(expected)) failures.push(`${label}: the frame loaded ${url}, not ${expected}`)
  }

  // The compare view's whole point is the stored bytes beside the dirty ones,
  // and the server is what decides the second editor cannot write.
  const log = await page.locator('#harness-log').textContent()
  if (debug) console.log(`    log:\n${log.trim()}`)
  if (!log.includes('saved version mounted (isolated), readOnly=true')) {
    const tail = log.trim().split('\n').slice(-6).join(' | ')
    failures.push(`${label}: the isolated editor did not report itself read-only -- log: ${tail}`)
  }

  failures.push(...crashes)
  await context.close()
  console.log(`  ${label}: ${failures.length === 0 ? 'ok' : 'see below'}`)
}

const corpus = mkdtempSync(join(tmpdir(), 'sheets-frame-corpus-'))
for (const file of readdirSync(join(webRoot, 'fixtures'))) {
  if (file.endsWith('.xlsx')) cpSync(join(webRoot, 'fixtures', file), join(corpus, file))
}

const apiPort = await freePort()
console.log('building the pages and the packaged frame …')
execFileSync('npx', ['vite', 'build', '--config', 'vite.config.ts'], {
  cwd: webRoot,
  env: { ...process.env, VITE_SHEETS_API: `http://127.0.0.1:${apiPort}` },
  stdio: 'pipe',
})
execFileSync('npx', ['vite', 'build', '--config', 'vite.frame.config.ts'], {
  cwd: webRoot,
  stdio: 'pipe',
})

console.log(`starting the API on ${apiPort} over a copy of the corpus …`)
const api = spawn(
  'npx',
  ['tsx', 'server/dev-server.ts', '--dir', corpus, '--port', String(apiPort)],
  {
    cwd: webRoot,
    stdio: 'pipe',
  },
)
api.stderr.on('data', (chunk) => process.stderr.write(chunk))

let server
let browser
try {
  await waitForApi(apiPort)
  server = await serveRoots({
    '/host/': join(webRoot, 'src', 'dist'),
    '/pkg/': join(webRoot, 'dist', 'frame'),
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
  await checkCompareView(browser, origin, 'the page build’s frame (default frameSrc)', null)
  await checkCompareView(
    browser,
    origin,
    'the packaged frame (dist/frame)',
    '/pkg/sheets-frame.html',
  )
} finally {
  await browser?.close()
  server?.close()
  api.kill()
  rmSync(corpus, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('check:frame failed')
  for (const line of failures) console.error(`  ${line}`)
  process.exit(1)
}
console.log('check:frame ok -- a compare view renders two grids, from either frame page')
