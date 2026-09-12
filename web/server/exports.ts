import { randomUUID } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'

import { SheetsError } from './errors'
import type { ExportSlot } from '../protocol'

/**
 * Bytes produced by a save that must not persist: Save As.
 *
 * The host application owns the destination. Papan's picker already takes a
 * `customSave` callback, so "Save As" is its flow with our bytes -- not a
 * second dialog and not a document-create port on this side. That makes the
 * server's job narrow: patch the snapshot, hand the result over once, forget
 * it.
 *
 * Two properties matter, and both are deliberate:
 *
 * **The bytes stay on disk.** A 30MB workbook held in a map for a minute would
 * undo the one property this fork sells -- the engine's resident set is flat
 * because no document model lives in memory. An export is a file in the
 * scratch directory and a path; the response streams it.
 *
 * **A slot is one-shot and short-lived.** The browser fetches immediately
 * after the save call returns, so anything still here a minute later was
 * abandoned. Redeeming a token deletes the file, so a leaked token is spent.
 */

interface Pending {
  readonly path: string
  /** Removed whole on redemption: writeWorkbookTo assembles inside it. */
  readonly workDir: string
  readonly name: string
  readonly identityKey: string
  readonly expiresAt: number
}

/** Long enough for a slow browser, short enough that nothing accumulates. */
const DEFAULT_TTL_MS = 60_000

export class ExportStore {
  readonly #pending = new Map<string, Pending>()
  readonly #ttlMs: number
  #sweeper: ReturnType<typeof setInterval> | null = null

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.#ttlMs = ttlMs
  }

  /**
   * Register an assembled file. `identityKey` is the caller's identity, so a
   * token is only redeemable by whoever asked for it -- a uuid is already
   * unguessable, and this makes that not the only thing standing in the way.
   */
  async register(input: {
    path: string
    workDir: string
    name: string
    identityKey: string
  }): Promise<ExportSlot> {
    const { size } = await stat(input.path)
    const token = randomUUID()
    this.#pending.set(token, {
      path: input.path,
      workDir: input.workDir,
      name: input.name,
      identityKey: input.identityKey,
      expiresAt: Date.now() + this.#ttlMs,
    })
    return { token, name: input.name, size }
  }

  /**
   * Redeem a token. The slot is gone either way -- a second fetch of the same
   * export is a bug on the client, not a feature to support.
   */
  take(token: string, identityKey: string): { path: string; name: string; release(): void } {
    const pending = this.#pending.get(token)
    // Same error for absent, expired and wrong-identity. Which one it was is
    // information the caller has no legitimate use for.
    if (!pending || pending.identityKey !== identityKey || pending.expiresAt < Date.now()) {
      if (pending) this.#discard(token, pending)
      throw new SheetsError('not_found', 'That export is no longer available.')
    }
    this.#pending.delete(token)
    return {
      path: pending.path,
      name: pending.name,
      release: () => void rm(pending.workDir, { recursive: true, force: true }).catch(() => {}),
    }
  }

  /** Abandoned exports: the save succeeded, the browser never came back. */
  start(sweepMs = DEFAULT_TTL_MS): void {
    if (this.#sweeper) return
    this.#sweeper = setInterval(() => this.sweep(), sweepMs)
    this.#sweeper.unref?.()
  }

  sweep(): void {
    const now = Date.now()
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt < now) this.#discard(token, pending)
    }
  }

  dispose(): void {
    if (this.#sweeper) clearInterval(this.#sweeper)
    this.#sweeper = null
    for (const [token, pending] of this.#pending) this.#discard(token, pending)
  }

  stats(): { pending: number } {
    return { pending: this.#pending.size }
  }

  #discard(token: string, pending: Pending): void {
    this.#pending.delete(token)
    void rm(pending.workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The identity an export is bound to.
 *
 * Includes the document: a token minted while exporting one workbook must not
 * be redeemable against another, even by the same user.
 */
export function exportIdentityKey(identity: {
  tenantId: string
  userId: string
  documentId: string
}): string {
  return [identity.tenantId, identity.userId, identity.documentId].join(' ')
}
