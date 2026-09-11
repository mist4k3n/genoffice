import { Hono } from 'hono'

import { toSheetsError } from './errors'
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
  })

  pool.start()
  registry.start()

  const app = new Hono()

  app.post('/invoke/:channel', async (c) => {
    const channel = c.req.param('channel')

    let identity: RequestIdentity
    try {
      identity = await options.identify(c.req.raw)
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

  app.get('/health', (c) =>
    c.json({ ok: true, sidecar: pool.stats(), sessions: registry.stats(), push: push.stats() }),
  )

  return {
    app,
    attachSocket: (documentId, socket) => push.attach(documentId, socket),
    push: (documentId, channel, ...args) => push.send(documentId, channel, ...args),
    async dispose() {
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
