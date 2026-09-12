/**
 * Host transport for the browser build.
 *
 * The Electron preload exposes two primitives: `ipcRenderer.invoke(channel,
 * ...args)` for request/response and `ipcRenderer.on(channel, listener)` for
 * pushes. Everything the renderer does goes through one of those two. This
 * module provides the same pair over HTTP and a WebSocket, so the DesktopApi
 * implementation above it reads almost identically to upstream's preload.
 *
 * Channel names are upstream's, verbatim — see DRIFT.md.
 */

import { READ_ONLY_HEADER } from '../../protocol'

export interface HostTransport {
  /** request/response, mirroring ipcRenderer.invoke */
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  /** main→renderer push, mirroring ipcRenderer.on; returns an unsubscribe */
  subscribe(channel: string, listener: (...args: unknown[]) => void): () => void
  /**
   * GET a binary payload from a path under the router's mount point.
   *
   * The Electron preload has no counterpart, and that is the point: a file is
   * the one thing `invoke` is bad at. Base64 through the JSON endpoint would
   * inflate a 30MB workbook by a third on both sides to move bytes a GET
   * already moves.
   */
  fetchBytes(path: string): Promise<Uint8Array>
  /** best-effort teardown; the page unloading is the usual end of life */
  dispose(): void
}

export class HostTransportError extends Error {
  readonly channel: string
  readonly status: number | undefined
  readonly code: string | undefined
  /**
   * The `detail` the server attached to the error, e.g. the version a
   * conflicted save lost to. Carried through because the host's conflict
   * banner is built around it -- without it the banner can say a conflict
   * happened and nothing else.
   */
  readonly detail: Record<string, unknown> | undefined

  constructor(
    channel: string,
    message: string,
    status?: number,
    code?: string,
    detail?: Record<string, unknown>,
  ) {
    super(`${channel}: ${message}`)
    this.name = 'HostTransportError'
    this.channel = channel
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export interface HttpTransportOptions {
  /** Base URL of the Hono router, e.g. https://api.example.com/sheets */
  readonly baseUrl: string
  /** Opaque document handle; sent with every request so the server can bind a session. */
  readonly documentId?: string | undefined
  /** Extra headers per request — auth belongs here, not in this module. */
  readonly headers?: (() => Record<string, string> | Promise<Record<string, string>>) | undefined
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch | undefined
  /** Injected for tests; defaults to the global WebSocket. */
  readonly webSocketImpl?: typeof WebSocket | undefined
  /**
   * Ask the server to open this connection read-only.
   *
   * A downgrade the server intersects with what it already decided, so it can
   * only ever give up rights. The conflict banner's "show saved version"
   * mounts a second editor on the stored bytes beside the dirty one, and that
   * second one must not be able to write.
   */
  readonly readOnly?: boolean | undefined
}

/** Wire envelope for a push. The server multiplexes every channel over one socket. */
interface PushMessage {
  readonly channel: string
  readonly args: unknown[]
}

const isPushMessage = (value: unknown): value is PushMessage =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PushMessage).channel === 'string' &&
  Array.isArray((value as PushMessage).args)

export function createHttpTransport(options: HttpTransportOptions): HostTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket
  const base = options.baseUrl.replace(/\/+$/, '')

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let socket: WebSocket | null = null
  let closed = false
  let reconnectDelay = 500

  /**
   * One socket for every channel. Subscriptions are registered locally rather
   * than announced to the server: the set of push channels is small and fixed,
   * and a renderer that subscribes late must not miss a channel the server has
   * already started sending.
   */
  function connect(): void {
    if (closed || socket) return
    const url = new URL(`${base}/events`)
    url.protocol = url.protocol.replace(/^http/, 'ws')
    if (options.documentId) url.searchParams.set('doc', options.documentId)

    const next = new WebSocketImpl(url.toString())
    socket = next

    next.addEventListener('open', () => {
      reconnectDelay = 500
    })

    next.addEventListener('message', (event: MessageEvent) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        console.warn('[host] unparseable push frame')
        return
      }
      if (!isPushMessage(parsed)) return
      for (const listener of listeners.get(parsed.channel) ?? []) {
        try {
          listener(...parsed.args)
        } catch (error) {
          // One bad listener must not stop the others on the same channel.
          console.error(`[host] listener for ${parsed.channel} threw`, error)
        }
      }
    })

    const reconnect = () => {
      if (socket !== next) return
      socket = null
      if (closed) return
      // Bounded backoff. A dropped socket loses pushes, not state — the
      // authoritative document lives on the server.
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000)
    }
    next.addEventListener('close', reconnect)
    next.addEventListener('error', reconnect)
  }

  return {
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(await options.headers?.()),
      }
      if (options.documentId) headers['x-document-id'] = options.documentId
      if (options.readOnly) headers[READ_ONLY_HEADER] = '1'

      let response: Response
      try {
        response = await fetchImpl(`${base}/invoke/${encodeURIComponent(channel)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ args }),
        })
      } catch (error) {
        throw new HostTransportError(channel, `network error: ${String(error)}`)
      }

      if (!response.ok) {
        // The server reports domain failures as a JSON body so the renderer can
        // distinguish "wrong password" from "server fell over".
        let code: string | undefined
        let message = response.statusText
        let detail: Record<string, unknown> | undefined
        try {
          const body = (await response.json()) as {
            error?: { code?: string; message?: string; detail?: Record<string, unknown> }
          }
          code = body.error?.code
          message = body.error?.message ?? message
          detail = body.error?.detail
        } catch {
          /* non-JSON error body */
        }
        throw new HostTransportError(channel, message, response.status, code, detail)
      }

      const body = (await response.json()) as { result: T }
      return body.result
    },

    async fetchBytes(path: string): Promise<Uint8Array> {
      const headers: Record<string, string> = { ...(await options.headers?.()) }
      if (options.documentId) headers['x-document-id'] = options.documentId
      if (options.readOnly) headers[READ_ONLY_HEADER] = '1'

      let response: Response
      try {
        response = await fetchImpl(`${base}${path}`, { method: 'GET', headers })
      } catch (error) {
        throw new HostTransportError(path, `network error: ${String(error)}`)
      }
      if (!response.ok) {
        let code: string | undefined
        let message = response.statusText
        try {
          const body = (await response.json()) as { error?: { code?: string; message?: string } }
          code = body.error?.code
          message = body.error?.message ?? message
        } catch {
          /* non-JSON error body */
        }
        throw new HostTransportError(path, message, response.status, code)
      }
      return new Uint8Array(await response.arrayBuffer())
    },

    subscribe(channel, listener) {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      connect()

      return () => {
        const current = listeners.get(channel)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(channel)
      }
    },

    dispose() {
      closed = true
      listeners.clear()
      socket?.close()
      socket = null
    },
  }
}
