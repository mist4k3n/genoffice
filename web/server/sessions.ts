import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { workbookFileSchema } from '../../apps/sheets/src/shared/desktop-api'
import { SheetsError } from './errors'
import { classifyWorkbookAt, classifyWorkbookBytes, type WorkbookKind } from './workbook-format'
import { workbookDisplayPath } from './workbook-handle'
import { SidecarPool } from './sidecar/pool'
import {
  DEFAULT_QUOTA,
  type QuotaOptions,
  type RequestIdentity,
  type StorageAdapter,
  type VersionToken,
  type WorkbookMetadata,
} from './ports'

/**
 * Open workbook sessions, and everything that has to be true for one to exist.
 *
 * The snapshot rule is upstream's and worth keeping verbatim: the sidecar never
 * opens the live document, it opens a private copy. Every read, recalc and save
 * in a session then comes from the same bytes, and the sha256 we hand the
 * client describes exactly those bytes -- even if someone else saves the
 * document a millisecond later. On the desktop the copy comes from disk; here
 * it comes from the StorageAdapter, which is the only real difference.
 */

export interface WorkbookSession {
  readonly sessionId: string
  readonly documentId: string
  readonly tenantId: string
  readonly userId: string
  /** Path of the private copy the sidecar has open. */
  readonly snapshotPath: string
  readonly byteLength: number
  readonly sha256: string
  /** Storage version the snapshot was taken from; a save must still match it. */
  readonly openedFromVersion: VersionToken
  readonly sheetNames: ReadonlyMap<string, string>
  readonly canEdit: boolean
  lastUsedAt: number
  /** Unsaved edits the renderer has journaled but not yet saved. */
  pendingEdits: number
  /**
   * Frees whatever the snapshot owns. A no-op when the engine was pointed at
   * storage's own immutable blob -- deleting that would destroy the document.
   */
  releaseSnapshot: () => Promise<void>
}

export interface SessionRegistryOptions {
  readonly pool: SidecarPool
  readonly storage: StorageAdapter
  readonly quota: QuotaOptions
  readonly scratchDir: string
  readonly locale: string
}

/** The sidecar's open result: a workbook file minus the two fields we supply. */
const openResultSchema = workbookFileSchema.omit({ sha256: true, readOnly: true })

export class SessionRegistry {
  private readonly sessions = new Map<string, WorkbookSession>()
  private reaper: NodeJS.Timeout | null = null

  constructor(private readonly options: SessionRegistryOptions) {}

  start(): void {
    // Sweep at a quarter of the timeout: often enough that an abandoned tab
    // frees its workbook promptly, rare enough to cost nothing.
    const period = Math.max(30_000, Math.floor(this.options.quota.idleTimeoutMs / 4))
    this.reaper = setInterval(() => void this.reapIdle(), period)
    this.reaper.unref?.()
  }

  /** Look up without touching liveness or throwing. */
  peek(sessionId: string): WorkbookSession | undefined {
    return this.sessions.get(sessionId)
  }

  get(sessionId: string): WorkbookSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new SheetsError('session_gone', 'Workbook session is no longer open.')
    }
    session.lastUsedAt = Date.now()
    return session
  }

  /** Assert the caller owns the session. Never trust a client-supplied id. */
  require(sessionId: string, identity: RequestIdentity): WorkbookSession {
    const session = this.get(sessionId)
    if (session.userId !== identity.userId || session.documentId !== identity.documentId) {
      // Deliberately 'session_gone' and not 'forbidden': a caller probing ids
      // learns nothing about which ones exist.
      throw new SheetsError('session_gone', 'Workbook session is no longer open.')
    }
    return session
  }

  /**
   * Fetch the document, write the private copy, and hand the path to the
   * caller to open. The caller registers the resulting session.
   */
  async prepareSnapshot(identity: RequestIdentity): Promise<{
    snapshotPath: string
    byteLength: number
    sha256: string
    version: VersionToken
    name: string
    displayPath: string | undefined
    cleanup: () => Promise<void>
  }> {
    this.enforceQuota(identity)

    // Content-addressed storage is already a snapshot: a blob named by the
    // hash of its contents cannot change under an open session. Where the
    // adapter offers that, skip the copy entirely -- it is the difference
    // between every open costing a full duplicate of the workbook and costing
    // nothing.
    const direct = await this.options.storage.localPath?.(identity.documentId)
    if (direct) {
      assertOpenable(await classifyWorkbookAt(direct.path))
      return {
        snapshotPath: direct.path,
        byteLength: direct.byteLength,
        // Storage usually knows this already. When it does not, streaming the
        // file to hash it still beats copying it.
        sha256: direct.sha256 ?? (await sha256File(direct.path)),
        version: direct.version,
        name: direct.name,
        displayPath: direct.displayPath,
        // Not ours. Deleting it would destroy the document.
        cleanup: async () => {},
      }
    }

    const stored = await this.options.storage.get(identity.documentId)

    // Fail with something actionable before the sidecar turns this into an
    // EOCD error indistinguishable from corruption.
    assertOpenable(classifyWorkbookBytes(stored.bytes))
    const dir = join(this.options.scratchDir, randomUUID())
    await mkdir(dir, { recursive: true })
    const snapshotPath = join(dir, sanitizeName(stored.name))
    await writeFile(snapshotPath, stored.bytes)
    return {
      snapshotPath,
      byteLength: stored.bytes.byteLength,
      sha256: createHash('sha256').update(stored.bytes).digest('hex'),
      version: stored.version,
      name: stored.name,
      displayPath: stored.displayPath,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    }
  }

  register(session: WorkbookSession): void {
    this.sessions.set(session.sessionId, session)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await this.options.pool.close(sessionId)
    await session.releaseSnapshot()
  }

  /**
   * Replace a just-saved session with a fresh one over the saved bytes.
   *
   * The old sidecar session still streams the pre-save workbook, so without
   * this every read for the rest of the session would serve cells that no
   * longer match what was written. Upstream does the same swap after a save.
   *
   * The new session inherits the identity of the old one and the version
   * token the save produced, so the next save's conflict check compares
   * against what this save wrote rather than what the session first opened.
   */
  async reopenAfterSave(
    previous: WorkbookSession,
    saved: WorkbookMetadata,
    pool: SidecarPool,
    locale: string,
  ): Promise<unknown> {
    await this.close(previous.sessionId)

    const snapshot = await this.prepareSnapshot({
      userId: previous.userId,
      tenantId: previous.tenantId,
      documentId: previous.documentId,
      canEdit: previous.canEdit,
    })
    try {
      const { sessionId, opened } = await pool.open(
        snapshot.snapshotPath,
        locale,
        undefined,
        (result) => openResultSchema.parse(result).sessionId,
        (result) => openResultSchema.parse(result),
      )
      this.register({
        sessionId,
        documentId: previous.documentId,
        tenantId: previous.tenantId,
        userId: previous.userId,
        snapshotPath: snapshot.snapshotPath,
        byteLength: snapshot.byteLength,
        releaseSnapshot: snapshot.cleanup,
        sha256: snapshot.sha256,
        openedFromVersion: saved.version,
        sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
        canEdit: previous.canEdit,
        lastUsedAt: Date.now(),
        pendingEdits: 0,
      })
      return workbookFileSchema.parse({
        ...opened,
        name: saved.name,
        path: workbookDisplayPath(saved.name, saved.displayPath),
        sha256: snapshot.sha256,
        fileBytes: snapshot.byteLength,
        readOnly: !previous.canEdit,
      })
    } catch (error) {
      await snapshot.cleanup()
      throw error
    }
  }

  /**
   * Which document each of these sessions belonged to, so a loss notice
   * reaches the right sockets. Called before `forget`, which discards them.
   */
  documentsFor(sessionIds: readonly string[]): Map<string, string[]> {
    const byDocument = new Map<string, string[]>()
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId)
      if (!session) continue
      const list = byDocument.get(session.documentId)
      if (list) list.push(sessionId)
      else byDocument.set(session.documentId, [sessionId])
    }
    return byDocument
  }

  /**
   * Sessions on this document that are behind the given version.
   *
   * Used to answer "the document moved" precisely: a session already at the
   * new version produced it and has nothing to be told.
   */
  staleSessions(documentId: string, version: VersionToken): WorkbookSession[] {
    const stale: WorkbookSession[] = []
    for (const session of this.sessions.values()) {
      if (session.documentId !== documentId) continue
      if (session.openedFromVersion === version) continue
      stale.push(session)
    }
    return stale
  }

  /**
   * The renderer's unsaved-edit count for this document. Held so an idle sweep
   * can tell the difference between dropping a clean session and a dirty one.
   */
  notePendingEdits(identity: RequestIdentity, count: number): void {
    for (const session of this.sessions.values()) {
      if (session.documentId !== identity.documentId) continue
      if (session.userId !== identity.userId) continue
      session.pendingEdits = count
      session.lastUsedAt = Date.now()
    }
  }

  /**
   * Close every session for a document. Called when the last browser socket
   * watching it has gone and stayed gone.
   */
  async closeForDocument(documentId: string): Promise<void> {
    const ids = [...this.sessions.values()]
      .filter((session) => session.documentId === documentId)
      .map((session) => session.sessionId)
    await Promise.allSettled(ids.map((id) => this.close(id)))
  }

  /** Drop sessions whose sidecar process died. Their snapshots still need removing. */
  async forget(sessionIds: readonly string[]): Promise<void> {
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const session = this.sessions.get(sessionId)
        if (!session) return
        this.sessions.delete(sessionId)
        await session.releaseSnapshot()
      }),
    )
  }

  private enforceQuota(identity: RequestIdentity): void {
    const { maxSessionsPerTenant, maxResidentBytesPerTenant } = this.options.quota
    let count = 0
    let bytes = 0
    for (const session of this.sessions.values()) {
      if (session.tenantId !== identity.tenantId) continue
      count += 1
      bytes += session.byteLength
    }
    if (count >= maxSessionsPerTenant) {
      throw new SheetsError('quota_exceeded', 'Too many workbooks open. Close one and retry.', {
        openSessions: count,
        limit: maxSessionsPerTenant,
      })
    }
    if (bytes >= maxResidentBytesPerTenant) {
      throw new SheetsError('quota_exceeded', 'Too much spreadsheet data open at once.', {
        residentBytes: bytes,
        limit: maxResidentBytesPerTenant,
      })
    }
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.options.quota.idleTimeoutMs
    const stale = [...this.sessions.values()].filter((session) => session.lastUsedAt < cutoff)
    // Unsaved edits are not lost here: the client journals them and a reopened
    // session replays them. Phase 03 owns telling the user this happened.
    await Promise.allSettled(stale.map((session) => this.close(session.sessionId)))
  }

  stats(): { sessions: number; residentBytes: number } {
    let residentBytes = 0
    for (const session of this.sessions.values()) residentBytes += session.byteLength
    return { sessions: this.sessions.size, residentBytes }
  }

  async dispose(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper)
    this.reaper = null
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)))
  }
}

/** Both open paths must reject the same inputs, for the same reasons. */
function assertOpenable(kind: WorkbookKind): void {
  if (kind === 'encrypted') {
    throw new SheetsError(
      'password_required',
      'This workbook is password-protected. Decryption is not implemented yet.',
    )
  }
  if (kind === 'legacy-xls') {
    throw new SheetsError(
      'not_implemented',
      'Legacy .xls workbooks are not supported yet; convert to .xlsx first.',
    )
  }
  if (kind === 'unknown') {
    throw new SheetsError('invalid_request', 'This file is not a spreadsheet.')
  }
}

/** Hash a file without holding it in memory. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export function defaultScratchDir(): string {
  return join(tmpdir(), 'genoffice-sheets-web')
}

export function resolveQuota(partial: Partial<QuotaOptions> | undefined): QuotaOptions {
  return { ...DEFAULT_QUOTA, ...partial }
}

/**
 * The name reaches the sidecar as a filename and the renderer as the workbook
 * title, so strip anything that could escape the scratch directory. The
 * extension matters -- the sidecar dispatches on it.
 */
function sanitizeName(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/^\.+/, '')
  return base.length > 0 ? base.slice(-200) : 'workbook.xlsx'
}
