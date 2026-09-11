/**
 * The push half of the host contract.
 *
 * web/src/host/transport.ts opens one WebSocket and demultiplexes frames by
 * channel name, so the server's whole obligation is to deliver
 * `{ channel, args }` to the right sockets.
 *
 * What this deliberately does NOT do is own the WebSocket. The upgrade differs
 * per runtime -- @hono/node-ws, Bun.serve, Deno.upgradeWebSocket, a Cloudflare
 * WebSocketPair -- and picking one here would pin the host application to it.
 * Instead the host attaches whatever it has, as something that can `send` a
 * string and report when it closes.
 */

/** The minimum a socket must do. Every runtime's WebSocket satisfies this. */
export interface PushSocket {
  send(data: string): void
  close?(): void
}

export interface PushHubOptions {
  /**
   * Called when a document has had no sockets for `idleGraceMs`.
   *
   * This is the web's answer to upstream's "renderer destroyed, close its
   * sessions". Without it a browser refresh orphans a session: the page that
   * opened it is gone, nothing calls closeWorkbook, and the workbook stays
   * resident until the idle sweep -- measured at one leaked session per
   * reload, which exhausts a tenant's quota well before anything times out.
   */
  readonly onDocumentIdle?: ((documentId: string) => void) | undefined
  /**
   * Grace before that fires. Must comfortably exceed the client's reconnect
   * backoff (capped at 15s in transport.ts), or a blip closes a live workbook.
   */
  readonly idleGraceMs?: number | undefined
}

const DEFAULT_IDLE_GRACE_MS = 45_000

export class PushHub {
  private readonly byDocument = new Map<string, Set<PushSocket>>()
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  private readonly idleGraceMs: number

  constructor(private readonly options: PushHubOptions = {}) {
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS
  }

  /** Returns a detach function; call it from the socket's close handler. */
  attach(documentId: string, socket: PushSocket): () => void {
    let set = this.byDocument.get(documentId)
    if (!set) {
      set = new Set()
      this.byDocument.set(documentId, set)
    }
    set.add(socket)
    // A reconnect within the grace window keeps the document alive.
    const pending = this.idleTimers.get(documentId)
    if (pending) {
      clearTimeout(pending)
      this.idleTimers.delete(documentId)
    }

    let detached = false
    return () => {
      // Detaching twice must not double-count; hosts call this from both the
      // close and error paths.
      if (detached) return
      detached = true
      const current = this.byDocument.get(documentId)
      if (!current) return
      current.delete(socket)
      if (current.size > 0) return
      this.byDocument.delete(documentId)
      this.startIdleTimer(documentId)
    }
  }

  private startIdleTimer(documentId: string): void {
    if (!this.options.onDocumentIdle) return
    const timer = setTimeout(() => {
      this.idleTimers.delete(documentId)
      if (this.byDocument.has(documentId)) return
      this.options.onDocumentIdle?.(documentId)
    }, this.idleGraceMs)
    timer.unref?.()
    this.idleTimers.set(documentId, timer)
  }

  send(documentId: string, channel: string, ...args: unknown[]): void {
    this.deliver(this.byDocument.get(documentId), channel, args)
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const set of this.byDocument.values()) this.deliver(set, channel, args)
  }

  private deliver(sockets: Set<PushSocket> | undefined, channel: string, args: unknown[]): void {
    if (!sockets || sockets.size === 0) return
    const frame = JSON.stringify({ channel, args })
    for (const socket of sockets) {
      try {
        socket.send(frame)
      } catch {
        // A socket that fails mid-broadcast must not stop the others. Its own
        // close handler will detach it.
      }
    }
  }

  stats(): { documents: number; sockets: number } {
    let sockets = 0
    for (const set of this.byDocument.values()) sockets += set.size
    return { documents: this.byDocument.size, sockets }
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    for (const set of this.byDocument.values()) {
      for (const socket of set) socket.close?.()
    }
    this.byDocument.clear()
  }
}
