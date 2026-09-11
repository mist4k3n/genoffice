import { XlsxSidecarClient } from '../../../apps/sheets/src/main/xlsx-sidecar-client'
import { SheetsError } from '../errors'
import type { SidecarOptions } from '../ports'

/**
 * A pool of warm xlsx-sidecar processes, with session affinity.
 *
 * The affinity is not an optimisation, it is a correctness requirement. A
 * sidecar `open` returns a sessionId that names state *inside that process* --
 * the parsed workbook, its index threads, its caches. Every later `read_range`,
 * `read_media` or `close` carrying that sessionId must reach the same process
 * or it fails. So the pool routes by sessionId and only load-balances at open
 * time.
 *
 * That also sets what poolSize means: the ceiling on concurrent *workbooks*
 * served without queueing behind one another, not on concurrent requests. One
 * process serialises its own queue.
 *
 * Upstream runs one client per browser window and never pools, so none of this
 * exists there. XlsxSidecarClient itself is imported unmodified -- it is pure
 * node with no Electron dependency, which is what makes the whole approach
 * work.
 */

const DEFAULT_LIVENESS_SWEEP_MS = 5_000

export class SessionGoneError extends SheetsError {
  constructor(sessionId: string) {
    super('session_gone', `Workbook session ${sessionId} is no longer open.`)
    this.name = 'SessionGoneError'
  }
}

interface Slot {
  readonly client: XlsxSidecarClient
  readonly sessions: Set<string>
  /** Last pid we saw. A change (or a null) means the process was replaced. */
  pid: number | null
  /** Earliest time we may try to respawn this slot after a failed attempt. */
  retryAfter: number
  respawnFailures: number
}

export interface PoolEvents {
  /**
   * A process died and took its sessions with it. The registry above uses this
   * to drop them; without it the next request waits for a timeout instead of
   * failing immediately with something the client can act on.
   */
  readonly onSessionsLost?: ((sessionIds: readonly string[], reason: string) => void) | undefined
}

export class SidecarPool {
  private readonly slots: Slot[] = []
  private readonly bySession = new Map<string, Slot>()
  private sweep: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly options: SidecarOptions,
    private readonly events: PoolEvents = {},
  ) {
    const size = Math.max(1, options.poolSize)
    for (let index = 0; index < size; index += 1) {
      this.slots.push({
        client: new XlsxSidecarClient(this.binaryPath()),
        sessions: new Set(),
        pid: null,
        retryAfter: 0,
        respawnFailures: 0,
      })
    }
  }

  private binaryPath(): string {
    const path = this.options.binaryPath ?? process.env.XLSX_SIDECAR_PATH
    if (!path) {
      throw new Error(
        'No xlsx-sidecar binary configured. Pass sidecar.binaryPath or set XLSX_SIDECAR_PATH.',
      )
    }
    return path
  }

  /** Spawn every process up front so the first request does not pay cold start. */
  start(): void {
    for (const slot of this.slots) {
      slot.client.start()
      slot.pid = slot.client.getProcessId()
    }
    // XlsxSidecarClient has no exit callback: on a crash it rejects whatever
    // was in flight and nulls its process, and a later request silently
    // respawns -- with every session inside it gone. Nothing tells us. So we
    // watch the pid. See DRIFT.md: an `onExit` hook is a good upstream PR,
    // and would let this sweep go away.
    this.sweep = setInterval(() => this.checkLiveness(), DEFAULT_LIVENESS_SWEEP_MS)
    this.sweep.unref?.()
  }

  /**
   * Pick a process for a new workbook: fewest resident sessions wins. Cheap,
   * and the right metric -- a session's cost is its resident workbook, not its
   * request rate.
   */
  private leastLoaded(): Slot {
    let chosen = this.slots[0]
    if (!chosen) throw new Error('Sidecar pool is empty.')
    for (const slot of this.slots) {
      if (slot.sessions.size < chosen.sessions.size) chosen = slot
    }
    return chosen
  }

  /**
   * Open a workbook and bind its session to the process that opened it.
   *
   * `open` is passed a path the caller owns; the caller is also responsible for
   * removing it once the session closes. That mirrors upstream's snapshot
   * discipline: the sidecar reads a private copy, so the document underneath
   * can change without the open session shifting under the user.
   */
  async open<T>(
    snapshotPath: string,
    locale: string,
    shortDateFormat: string | undefined,
    readSessionId: (result: unknown) => string,
    parse: (result: unknown) => T,
  ): Promise<{ sessionId: string; opened: T }> {
    const slot = this.leastLoaded()
    const raw = await this.guard(slot, () => slot.client.open(snapshotPath, locale, shortDateFormat))
    const sessionId = readSessionId(raw)
    slot.sessions.add(sessionId)
    this.bySession.set(sessionId, slot)
    slot.pid = slot.client.getProcessId()
    return { sessionId, opened: parse(raw) }
  }

  /** Run a command against the process holding this session. */
  async withSession<T>(
    sessionId: string,
    run: (client: XlsxSidecarClient) => Promise<T>,
  ): Promise<T> {
    const slot = this.bySession.get(sessionId)
    if (!slot) throw new SessionGoneError(sessionId)
    return this.guard(slot, () => run(slot.client))
  }

  async close(sessionId: string): Promise<void> {
    const slot = this.bySession.get(sessionId)
    if (!slot) return
    this.bySession.delete(sessionId)
    slot.sessions.delete(sessionId)
    // A close that fails because the process already died is a success as far
    // as the caller is concerned: the session is gone either way.
    try {
      await slot.client.close(sessionId)
    } catch {
      this.checkLiveness()
    }
  }

  /**
   * Run one request and, if it fails, find out whether the process died. A
   * crash rejects every in-flight request, so the first failure is the earliest
   * moment we can learn about it -- earlier than the periodic sweep.
   */
  private async guard<T>(slot: Slot, run: () => Promise<T>): Promise<T> {
    try {
      const value = await run()
      slot.pid ??= slot.client.getProcessId()
      return value
    } catch (error) {
      this.checkLiveness()
      throw error
    }
  }

  /**
   * A slot's process is gone when its pid went null, or changed -- the second
   * case being a respawn that already happened, whose sessions are just as
   * lost as a crash's.
   */
  private checkLiveness(): void {
    if (this.disposed) return
    for (const slot of this.slots) {
      const pid = slot.client.getProcessId()
      if (pid !== null && pid === slot.pid) continue
      if (slot.pid === null && pid === null) continue

      const lost = [...slot.sessions]
      slot.pid = pid
      if (lost.length > 0) {
        slot.sessions.clear()
        for (const sessionId of lost) this.bySession.delete(sessionId)
        this.events.onSessionsLost?.(lost, 'The spreadsheet engine restarted.')
      }
      if (pid === null) this.respawn(slot)
    }
  }

  /**
   * Bring a dead slot back warm.
   *
   * Without this the pool silently degrades: XlsxSidecarClient respawns lazily
   * on its next request, so after a crash only the slot that happened to be
   * used comes back and a poolSize of 4 quietly becomes 1. Backoff is there so
   * a genuinely unrunnable binary is retried occasionally rather than every
   * sweep forever.
   */
  private respawn(slot: Slot): void {
    const now = Date.now()
    if (now < slot.retryAfter) return
    slot.client.start()
    const pid = slot.client.getProcessId()
    if (pid === null) {
      slot.respawnFailures += 1
      slot.retryAfter = now + Math.min(60_000, 2 ** slot.respawnFailures * 1_000)
      return
    }
    slot.pid = pid
    slot.respawnFailures = 0
    slot.retryAfter = 0
  }

  stats(): { poolSize: number; sessions: number; perProcess: number[] } {
    return {
      poolSize: this.slots.length,
      sessions: this.bySession.size,
      perProcess: this.slots.map((slot) => slot.sessions.size),
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.sweep) clearInterval(this.sweep)
    this.sweep = null
    for (const slot of this.slots) {
      slot.sessions.clear()
      slot.client.stop()
    }
    this.bySession.clear()
  }
}
