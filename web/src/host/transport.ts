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

export interface HostTransport {
  /** request/response, mirroring ipcRenderer.invoke */
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  /** main→renderer push, mirroring ipcRenderer.on; returns an unsubscribe */
  subscribe(channel: string, listener: (...args: unknown[]) => void): () => void
  /** best-effort teardown; the page unloading is the usual end of life */
  dispose(): void
}

export class HostTransportError extends Error {
  readonly channel: string
  readonly status: number | undefined
  readonly code: string | undefined

  constructor(channel: string, message: string, status?: number, code?: string) {
    super(`${channel}: ${message}`)
    this.name = 'HostTransportError'
    this.channel = channel
    this.status = status
    this.code = code
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
        try {
          const body = (await response.json()) as { error?: { code?: string; message?: string } }
          code = body.error?.code
          message = body.error?.message ?? message
        } catch {
          /* non-JSON error body */
        }
        throw new HostTransportError(channel, message, response.status, code)
      }

      const body = (await response.json()) as { result: T }
      return body.result
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
