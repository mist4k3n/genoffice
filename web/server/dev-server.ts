/**
 * Development host for the Sheets server.
 *
 * Stands in for the client's Hono app: it supplies the two things
 * createSheetsRouter cannot supply itself -- durable storage and an identity --
 * and wires a real WebSocket to the push hub. A production host does the same
 * three things with S3 (or whatever) and real auth.
 *
 *   npm run serve            # serves web/fixtures on :5274
 *   npm run serve -- --dir /some/other/folder
 *
 * The document id is the filename, so the browser opens one with
 * `?doc=acme-budget.xlsx`.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'

import { SheetsError, VersionConflictError } from './errors'
import { createSheetsRouter } from './router'
import type { RequestIdentity, StorageAdapter, WorkbookMetadata } from './ports'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

const root = resolve(flag('dir', 'fixtures'))
const port = Number(flag('port', '5274'))
// Lowerable so the socket-idle session close can be exercised without a
// 45-second wait.
const socketIdleGraceMs = Number(flag('idle-grace', '45000'))
// Pinning the pool to one process makes per-workbook memory attributable.
const poolSize = Number(flag('pool', '4'))
// Raised by the memory benchmark, which needs to exceed the per-tenant cap to
// measure where memory actually goes.
const maxSessions = Number(flag('max-sessions', '16'))
const directRead = process.argv.includes('--direct-read')

/**
 * Filesystem storage. The version token is mtime+size, which is enough to
 * detect "someone else wrote this" for a dev server and is exactly the kind of
 * thing a real adapter replaces with an ETag or a row version.
 */
function fileStorage(directory: string): StorageAdapter {
  const pathFor = (documentId: string): string => {
    // basename() collapses any traversal, so a mismatch means the id carried
    // path structure. Reject it as a bad request, not as a server fault.
    const name = basename(documentId)
    if (name !== documentId || name.startsWith('.')) {
      throw new SheetsError('invalid_request', `Invalid document id: ${documentId}`)
    }
    return join(directory, name)
  }
  const versionOf = async (path: string): Promise<WorkbookMetadata> => {
    const info = await stat(path).catch(() => {
      throw new SheetsError('not_found', `No such document: ${basename(path)}`)
    })
    return {
      version: `${info.mtimeMs}-${info.size}`,
      name: basename(path),
      byteLength: info.size,
      // A user-meaningful location, deliberately NOT the server's directory.
      // A real host would use the document's folder in its own hierarchy.
      displayPath: `/Documents/${basename(path)}`,
    }
  }

  return {
    head: async (documentId) => versionOf(pathFor(documentId)),
    get: async (documentId) => {
      const path = pathFor(documentId)
      // Both halves need the same guard. readFile's own ENOENT would otherwise
      // escape unclassified -- as a 500 whose message carried the server's
      // absolute filesystem path straight to the browser.
      const [bytes, meta] = await Promise.all([
        readFile(path).catch(() => {
          throw new SheetsError('not_found', `No such document: ${documentId}`)
        }),
        versionOf(path),
      ])
      return { bytes, version: meta.version, name: meta.name, displayPath: meta.displayPath }
    },
    /**
     * Papan stores blobs content-addressed and immutable, so its adapter can
     * hand the engine the blob path directly. This dev adapter is a plain
     * mutable filesystem, so the fast path is opt-in behind --direct-read and
     * exists to exercise the code path, not because it is safe here.
     */
    ...(directRead
      ? {
          localPath: async (documentId: string) => {
            const path = pathFor(documentId)
            const meta = await versionOf(path)
            // No sha256 here on purpose: this adapter's version token is
            // mtime+size, so the server has to hash the file itself. Papan's
            // would pass file.contentHash and skip that.
            return {
              path,
              version: meta.version,
              name: meta.name,
              byteLength: meta.byteLength,
              ...(meta.displayPath === undefined ? {} : { displayPath: meta.displayPath }),
            }
          },
        }
      : {}),

    put: async (documentId, bytes, expectedVersion) => {
      const path = pathFor(documentId)
      if (expectedVersion !== null) {
        const current = await versionOf(path)
        if (current.version !== expectedVersion) throw new VersionConflictError(current.version)
      }
      await writeFile(path, bytes)
      return versionOf(path)
    },
  }
}

/** Dev identity: the document comes from the request, everyone is the same user. */
function devIdentity(request: Request): RequestIdentity {
  const url = new URL(request.url)
  const documentId = request.headers.get('x-document-id') ?? url.searchParams.get('doc')
  if (!documentId) throw new Error('No document id. Pass ?doc=<file> or x-document-id.')
  return { userId: 'dev', tenantId: 'dev', documentId, canEdit: true }
}

const sheets = createSheetsRouter({
  storage: fileStorage(root),
  identify: devIdentity,
  socketIdleGraceMs,
  quota: { maxSessionsPerTenant: maxSessions },
  sidecar: {
    poolSize,
    binaryPath:
      process.env.XLSX_SIDECAR_PATH ??
      resolve('../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar'),
  },
})

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// CORS for the Vite dev server on another port. Production pins an origin.
app.use('*', async (c, next) => {
  c.header('access-control-allow-origin', '*')
  c.header('access-control-allow-headers', 'content-type, x-document-id')
  c.header('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

app.get(
  '/events',
  upgradeWebSocket((c) => {
    const documentId = c.req.query('doc') ?? 'unknown'
    let detach = (): void => {}
    return {
      onOpen: (_event, ws) => {
        detach = sheets.attachSocket(documentId, {
          send: (data) => ws.send(data),
          close: () => ws.close(),
        })
        console.log(`  [serve] socket open for ${documentId}`)
      },
      onClose: () => {
        detach()
        console.log(`  [serve] socket closed for ${documentId}`)
      },
    }
  }),
)

// The corpus harness discovers the served directory here rather than being
// told twice. Pointing it at a different folder than the server serves
// silently compares two unrelated sets of bytes.
app.get('/dev-info', (c) => c.json({ documentRoot: root }))

app.route('/', sheets.app)

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
  console.log(`[serve] Sheets server on http://127.0.0.1:${info.port}`)
  console.log(`[serve] serving documents from ${root}`)
  console.log(`[serve] open the app with ?doc=<filename>`)
})
injectWebSocket(server)

const shutdown = async (): Promise<void> => {
  await sheets.dispose()
  server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
