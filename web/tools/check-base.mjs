#!/usr/bin/env node
/**
 * The A2 acceptance test: the built pages load everything they reference when
 * they are not at the site root.
 *
 * It builds the pages, serves `src/dist` under a deliberately awkward prefix,
 * and follows what each page actually asks for -- its scripts, its preloaded
 * chunks, its stylesheets, the font faces inside those stylesheets, and the
 * two font URLs upstream's canvas fallback builds in JavaScript. Anything that
 * answers 404 fails the check.
 *
 * Both answers are tested, because both are supported:
 *
 * - the default relative `base`, which must survive being served from any
 *   prefix at all;
 * - an absolute `SHEETS_WEB_BASE`, which must resolve at exactly the prefix it
 *   was given, and is the answer for assets on another origin.
 *
 * `fetch` is Node's own and the server below is a dozen lines of `http`: this
 * is a link check, not a browser test. What a browser would add -- that the
 * faces are actually applied to the canvas -- is `npm run visuals`.
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const pages = ['index.html', 'harness.html', 'sheets-frame.html']

/** Deliberately nested, and not a prefix anything would guess. */
const PREFIX = '/apps/sheets/v3/'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function build(base) {
  const env = { ...process.env }
  if (base === null) delete env.SHEETS_WEB_BASE
  else env.SHEETS_WEB_BASE = base
  execFileSync('npx', ['vite', 'build', '--config', 'vite.config.ts'], {
    cwd: webRoot,
    env,
    stdio: 'pipe',
  })
}

/** Serves `src/dist` under PREFIX, and nothing else. */
function serve(root) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    if (!path.startsWith(PREFIX)) {
      response.writeHead(404).end()
      return
    }
    const file = join(root, path.slice(PREFIX.length))
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

const failures = []

/** Fetch, and report rather than throw: one 404 should not hide the next. */
async function get(url, referrer) {
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    failures.push(`${url} -- ${error.message} (referenced by ${referrer})`)
    return null
  }
  if (!response.ok) {
    failures.push(`${url} -- ${response.status} (referenced by ${referrer})`)
    return null
  }
  const body = await response.text()
  if (body.length === 0) failures.push(`${url} -- empty (referenced by ${referrer})`)
  return body
}

const HTML_REF = /(?:src|href)="([^"]+)"/g
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g
/**
 * The literal that upstream's `new URL('./fonts/…', import.meta.url)` leaves.
 * All three quote characters: the minifier rewrites it as a template literal.
 */
const JS_FONT = /["'`](\.\/fonts\/[A-Za-z0-9._-]+\.ttf)["'`]/g

async function checkPage(origin, page) {
  const pageUrl = new URL(PREFIX + page, origin).href
  const html = await get(pageUrl, 'the check')
  if (html === null) return

  const refs = [...html.matchAll(HTML_REF)].map((match) => match[1])
  if (refs.length === 0) failures.push(`${page} references no assets at all`)

  for (const ref of refs) {
    if (ref.startsWith('data:') || ref.startsWith('http')) continue
    const url = new URL(ref, pageUrl).href
    const body = await get(url, page)
    if (body === null) continue

    if (url.endsWith('.css')) {
      const targets = new Set([...body.matchAll(CSS_URL)].map((match) => match[1]))
      for (const target of targets) {
        if (target.startsWith('data:')) continue
        await get(new URL(target, url).href, `${page} -> ${ref}`)
      }
    }
    if (url.endsWith('.js')) {
      const targets = new Set([...body.matchAll(JS_FONT)].map((match) => match[1]))
      for (const target of targets) {
        await get(new URL(target, url).href, `${page} -> ${ref}`)
      }
    }
  }
}

async function run(label, base) {
  build(base)
  const server = await serve(join(webRoot, 'src', 'dist'))
  const { port } = server.address()
  const before = failures.length
  for (const page of pages) await checkPage(`http://127.0.0.1:${port}`, page)
  server.close()
  const broken = failures.length - before
  console.log(`  ${label}: ${broken === 0 ? 'ok' : `${broken} broken reference(s)`}`)
}

console.log(`serving the pages from ${PREFIX}`)
await run('relative base (the default)', null)
await run(`SHEETS_WEB_BASE=${PREFIX}`, PREFIX)

if (failures.length > 0) {
  console.error('check:base failed')
  for (const line of failures) console.error(`  ${line}`)
  process.exit(1)
}
console.log('check:base ok -- every asset the pages ask for resolves under the prefix')
