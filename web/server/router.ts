import { readFile } from 'node:fs/promises'

import { Hono } from 'hono'

import { toSheetsError } from './errors'
import { ExportStore, exportIdentityKey } from './exports'
import { CONFLICT_CHANNEL, READ_ONLY_HEADER, conflictFor } from '../protocol'
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SIDECAR,
  type RequestIdentity,
  type SheetsServerOptions,
} from './ports'
import { PushHub, type PushSocket } from './push'
import { defaultScratchDir, resolveQuota, SessionRegistry } from './sessions'
import { SidecarPool } from './sidecar/pool'
import type { ChannelTable } from './router-types'
import { appChannels } from './channels/app'
import { readChannels } from './channels/read'
import { saveChannels } from './channels/save'
import { workbookChannels } from './channels/workbook'

/**
 * The Hono router the host application mounts.
 *
 *   const sheets = createSheetsRouter({ storage, identify })
 *   app.route('/sheets', sheets.app)
 *
 * One endpoint, because the Electron preload exposes one request primitive:
 * `POST /invoke/:channel`. The push half is a WebSocket the host owns and
 * hands to `attachSocket` -- see push.ts for why the socket is not created
 * here.
 */

export interface SheetsRouter {
  readonly app: Hono
  /**
   * Attach a WebSocket for a document. Returns a detach function to call from
   * the socket's own close handler.
   */
  attachSocket(documentId: string, socket: PushSocket): () => void
  /** Push `{channel, args}` to every socket watching a document. */
  push(documentId: string, channel: string, ...args: unknown[]): void
  /**
   * Tell every session that this document moved underneath it.
   *
   * The host calls this from wherever it learns that storage changed -- its
   * own realtime layer, a webhook, the write path of another editor. There is
   * no port for storage to announce itself, and polling `head()` would be a
   * guess dressed up as a fact.
   *
   * Sessions already at the new version produced it and are not told. Resolves
   * with how many were.
   */
  documentChanged(documentId: string, version?: string): Promise<number>
  dispose(): Promise<void>
}

const CHANNELS: ChannelTable = {
  ...appChannels,
  ...workbookChannels,
  ...readChannels,
  ...saveChannels,
}

export function createSheetsRouter(options: SheetsServerOptions): SheetsRouter {
  const quota = resolveQuota(options.quota)
  const scratchDir = options.sidecar?.scratchDir ?? defaultScratchDir()
  const preferences = { ...DEFAULT_PREFERENCES, ...options.preferences }
  const exports = new ExportStore(options.exportTtlMs)
  const locale = options.locale ?? preferences.language

  const push = new PushHub({
    idleGraceMs: options.socketIdleGraceMs,
    onDocumentIdle: (documentId) => {
      // Every viewer is gone. Upstream closes a window's sessions when its
      // renderer is destroyed; on the web the socket is what tells us that.
      void registry.closeForDocument(documentId)
    },
  })

  const pool = new SidecarPool(
    {
      poolSize: options.sidecar?.poolSize ?? DEFAULT_SIDECAR.poolSize,
      binaryPath: options.sidecar?.binaryPath,
      scratchDir,
    },
    {
      onSessionsLost: (sessionIds, reason) => {
        // The workbook is still on the user's screen but its session is gone.
        // Saying so now beats letting their next scroll fail obscurely.
        const documents = registry.documentsFor(sessionIds)
        void registry.forget(sessionIds)
        for (const [documentId, ids] of documents) {
          push.send(documentId, SESSION_LOST_CHANNEL, { sessionIds: ids, reason })
        }
      },
    },
  )

  const registry = new SessionRegistry({
    pool,
    storage: options.storage,
    quota,
    scratchDir,
    locale,
    drafts: options.drafts,
  })

  pool.start()
  registry.start()
  exports.start()

  const app = new Hono()

  app.post('/invoke/:channel', async (c) => {
    const channel = c.req.param('channel')

    let identity: RequestIdentity
    try {
      identity = readOnlyIfAsked(await options.identify(c.req.raw), c.req.raw)
    } catch (error) {
      // Never leak why. An identify() that throws has already decided.
      const failure = toSheetsError(error)
      return c.json({ error: { code: 'unauthorized', message: failure.message } }, 401)
    }

    const handler = CHANNELS[channel]
    if (!handler) {
      return c.json(
        { error: { code: 'not_implemented', message: `Channel ${channel} is not implemented.` } },
        501,
      )
    }

    let args: readonly unknown[] = []
    try {
      const body = (await c.req.json()) as { args?: unknown }
      if (body.args !== undefined && !Array.isArray(body.args)) {
        throw new Error('Request body `args` must be an array.')
      }
      args = body.args ?? []
    } catch (error) {
      return c.json(
        { error: { code: 'invalid_request', message: toSheetsError(error).message } },
        400,
      )
    }

    try {
      const result = await handler({
        args,
        identity,
        registry,
        pool,
        locale,
        preferences,
        push,
        storage: options.storage,
        scratchDir,
        exports,
        drafts: options.drafts,
      })
      // An undefined result drops out of JSON.stringify entirely, and the
      // transport reads the missing key back as undefined. Right for the void
      // channels, which is most of them.
      return c.json({ result })
    } catch (error) {
      const failure = toSheetsError(error)
      return c.json(
        {
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.detail ? { detail: failure.detail } : {}),
          },
        },
        failure.status as 400,
      )
    }
  })

  /**
   * Redeem a Save As.
   *
   * A GET rather than another `/invoke` channel because the payload is a file:
   * the invoke endpoint speaks JSON, and base64 through it would inflate a
   * 30MB workbook by a third on both sides for no gain. The host fetches this
   * once and writes the bytes wherever its own picker chose.
   */
  app.get('/export/:token', async (c) => {
    let identity: RequestIdentity
    try {
      identity = await options.identify(c.req.raw)
    } catch (error) {
      const failure = toSheetsError(error)
      return c.json({ error: { code: 'unauthorized', message: failure.message } }, 401)
    }

    let slot: ReturnType<ExportStore['take']>
    try {
      slot = exports.take(c.req.param('token'), exportIdentityKey(identity))
    } catch (error) {
      const failure = toSheetsError(error)
      return c.json({ error: { code: failure.code, message: failure.message } }, failure.status as 404)
    }

    // Read then release: the file is at most one workbook and the slot is
    // already spent, so holding the scratch directory open across a stream
    // would buy nothing but a cleanup path that runs on disconnect.
    try {
      const bytes = await readFile(slot.path)
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        'content-type': XLSX_MEDIA_TYPE,
        'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename="${slot.name.replace(/["\\]/g, '')}"`,
      })
    } finally {
      slot.release()
    }
  })

  app.get('/health', (c) =>
    c.json({
      ok: true,
      sidecar: pool.stats(),
      sessions: registry.stats(),
      push: push.stats(),
      exports: exports.stats(),
    }),
  )

  return {
    app,
    attachSocket: (documentId, socket) => push.attach(documentId, socket),
    push: (documentId, channel, ...args) => push.send(documentId, channel, ...args),
    async documentChanged(documentId, version) {
      const current = version ?? (await options.storage.head(documentId)).version
      const stale = registry.staleSessions(documentId, current)
      if (stale.length > 0) push.send(documentId, CONFLICT_CHANNEL, conflictFor(current, stale))
      return stale.length
    },
    async dispose() {
      exports.dispose()
      push.dispose()
      await registry.dispose()
      pool.dispose()
    },
  }
}

/**
 * Not an upstream channel: the desktop has no equivalent, because a crashed
 * sidecar there takes the window with it. The renderer ignores it today; the
 * phase-03 reconnect logic is what will listen.
 */
export const SESSION_LOST_CHANNEL = 'sheets:session-lost'

/**
 * The media type for .xlsx. Also correct for .xlsm: the macro-enabled type
 * only differs in the manifest, and a host that cares reads the name.
 */
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Honour a request to open read-only.
 *
 * A downgrade only, and that asymmetry is the whole safety argument: a client
 * can give up rights `identify()` granted it, and can never claim rights it
 * did not. The conflict banner's "show saved version" needs it -- it mounts a
 * second editor on the stored bytes beside the dirty one, and that one must
 * not be able to write.
 */
function readOnlyIfAsked(identity: RequestIdentity, request: Request): RequestIdentity {
  if (!identity.canEdit) return identity
  return request.headers.get(READ_ONLY_HEADER) ? { ...identity, canEdit: false } : identity
}
