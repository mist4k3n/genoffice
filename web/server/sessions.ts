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
  canWrite,
  DEFAULT_QUOTA,
  type DraftAdapter,
  type FilePermission,
  type QuotaOptions,
  type RequestIdentity,
  type StorageAdapter,
  type VersionToken,
  type WorkbookMetadata,
  type SessionDirectory,
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

/**
 * One open workbook inside the engine, and the clients looking at it.
 *
 * The expensive thing is this, not the handle a browser holds: opening it
 * writes a snapshot and parses the file, and a 30.9 MB workbook costs ~22 MB
 * resident for as long as it stays open. Measured before this existed, a
 * second reader of the same document cost exactly what a second document
 * cost -- see FINDINGS-COLLAB.md §1 -- because sessions were keyed by session
 * id and every open made another one.
 *
 * Sharing is safe because nothing mutates an open session: every call into it
 * reads `snapshotPath`, and the save writes into a per-request scratch
 * directory. It is *correct* because the key includes the storage version, so
 * two clients share only when they are looking at identical bytes.
 */
interface EngineSession {
  /** `tenant\0document\0version`, or a unique key for an unshareable open. */
  readonly key: string
  readonly tenantId: string
  readonly documentId: string
  /** The sidecar's own id. Changes when a save reopens the workbook. */
  readonly engineSessionId: string
  readonly snapshotPath: string
  readonly byteLength: number
  readonly sha256: string
  readonly openedFromVersion: VersionToken
  readonly sheetNames: ReadonlyMap<string, string>
  /** The sidecar's open result, replayed verbatim to every later client. */
  readonly opened: OpenedWorkbook
  readonly name: string
  readonly displayPath: string | undefined
  readonly fromDraft: boolean
  readonly releaseSnapshot: () => Promise<void>
  /** Client session ids. The engine closes when the last one leaves. */
  readonly clients: Set<string>
}

type OpenedWorkbook = ReturnType<typeof openResultSchema.parse>

export interface WorkbookSession {
  readonly sessionId: string
  readonly documentId: string
  readonly tenantId: string
  readonly userId: string
  /** The sidecar session this client reads through. Shared, and not the client's id. */
  readonly engineSessionId: string
  /** Path of the copy the sidecar has open. */
  readonly snapshotPath: string
  readonly byteLength: number
  readonly sha256: string
  /** Storage version the snapshot was taken from; a save must still match it. */
  readonly openedFromVersion: VersionToken
  readonly sheetNames: ReadonlyMap<string, string>
  /**
   * What the opener could do at open time.
   *
   * A record, not an authorisation: every mutating channel re-reads the
   * *request's* permission, so a revoked grant fails on the next call. This is
   * kept because the workbook's `readOnly` flag was reported from it and the
   * reopen after a save must report the same thing.
   */
  readonly permission: FilePermission
  lastUsedAt: number
  /** Unsaved edits the renderer has journaled but not yet saved. */
  pendingEdits: number
}

/**
 * A browser's handle on an engine session.
 *
 * Identity, permission and liveness are the client's; bytes and sheet names
 * are the engine's, read through getters so a save that swaps the engine
 * underneath reaches every client without anyone re-fetching a session id.
 */
class ClientSession implements WorkbookSession {
  lastUsedAt = Date.now()
  pendingEdits = 0

  constructor(
    readonly sessionId: string,
    readonly userId: string,
    readonly permission: FilePermission,
    public engine: EngineSession,
  ) {}

  get documentId(): string {
    return this.engine.documentId
  }
  get tenantId(): string {
    return this.engine.tenantId
  }
  get engineSessionId(): string {
    return this.engine.engineSessionId
  }
  get snapshotPath(): string {
    return this.engine.snapshotPath
  }
  get byteLength(): number {
    return this.engine.byteLength
  }
  get sha256(): string {
    return this.engine.sha256
  }
  get openedFromVersion(): VersionToken {
    return this.engine.openedFromVersion
  }
  get sheetNames(): ReadonlyMap<string, string> {
    return this.engine.sheetNames
  }
}

/** What an open needs: bytes on disk the sidecar can hold, and their provenance. */
export interface Snapshot {
  readonly snapshotPath: string
  readonly byteLength: number
  readonly sha256: string
  /** The *storage* version these bytes derive from, draft or not. */
  readonly version: VersionToken
  readonly name: string
  readonly displayPath: string | undefined
  readonly cleanup: () => Promise<void>
  /** True when the bytes came from unsaved work rather than from storage. */
  readonly fromDraft?: boolean | undefined
}

export interface SessionRegistryOptions {
  readonly pool: SidecarPool
  readonly storage: StorageAdapter
  readonly quota: QuotaOptions
  readonly scratchDir: string
  readonly locale: string
  readonly drafts?: DraftAdapter | undefined
  /** Where open sessions are recorded, so a sibling instance can find them. */
  readonly directory?: SessionDirectory | undefined
  /** This process's identity in that directory. */
  readonly instanceId?: string | undefined
}

/** The sidecar's open result: a workbook file minus the two fields we supply. */
const openResultSchema = workbookFileSchema.omit({ sha256: true, readOnly: true })

export class SessionRegistry {
  private readonly sessions = new Map<string, ClientSession>()
  /** Engine sessions by share key. Many clients, one entry. */
  private readonly engines = new Map<string, EngineSession>()
  /** Opens in flight, so two simultaneous first-openers do not both parse. */
  private readonly opening = new Map<string, Promise<EngineSession>>()
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
      // The id rides along so the router can ask the directory whether this is
      // a session that ended or one that lives on another instance. Nothing is
      // disclosed: the caller sent this id.
      throw new SheetsError('session_gone', 'Workbook session is no longer open.', { sessionId })
    }
    session.lastUsedAt = Date.now()
    // Refreshing on use is what makes a lapsed claim mean "that instance is
    // gone" rather than "that session is old".
    void this.#claim(sessionId)
    return session
  }

  /**
   * Record ownership. Failures are swallowed on purpose: a directory that is
   * down must not take the editor down with it. The cost of a missing claim is
   * a misdirected call answered as `session_gone`, which is what a host
   * without a directory gets anyway.
   */
  #claim(sessionId: string): Promise<void> {
    const { directory, instanceId } = this.options
    if (!directory || !instanceId) return Promise.resolve()
    // Outlives the reaper's own cutoff, so the entry disappears because the
    // instance did, not because the session was idle.
    const ttl = this.options.quota.idleTimeoutMs * 2
    return directory.claim(sessionId, instanceId, ttl).catch(() => {})
  }

  #release(sessionId: string): Promise<void> {
    return this.options.directory?.release(sessionId).catch(() => {}) ?? Promise.resolve()
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
  async prepareSnapshot(identity: RequestIdentity): Promise<Snapshot> {
    // Unsaved work outranks the stored document, and does so silently. That is
    // Papan's own rule -- its WOPI GetFile serves a non-stale draft ahead of
    // storage -- and it is the difference between "your edits came back" and a
    // restore prompt asking a question the user cannot evaluate.
    const draft = await this.#freshDraft(identity)
    return draft
      ? this.#snapshotFromDraft(identity, draft)
      : this.#snapshotFromStorage(identity)
  }

  async #snapshotFromDraft(
    identity: RequestIdentity,
    draft: { bytes: Uint8Array; baseVersion: VersionToken },
  ): Promise<Snapshot> {
    const stored = await this.options.storage.head(identity.documentId)
    return {
      ...(await this.#snapshotFromBytes(draft.bytes, {
        version: stored.version,
        name: stored.name,
        displayPath: stored.displayPath,
      })),
      fromDraft: true,
    }
  }

  async #snapshotFromStorage(identity: RequestIdentity): Promise<Snapshot> {
    // Content-addressed storage is already a snapshot: a blob named by the
    // hash of its contents cannot change under an open session. Where the
    // adapter offers that, skip the copy entirely -- it is the difference
    // between every open costing a full duplicate of the workbook and costing
    // nothing.
    //
    // Below the draft check on purpose: the fast path is a pointer at what
    // storage holds, and a draft is by definition not that.
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
    return this.#snapshotFromBytes(stored.bytes, stored)
  }

  /**
   * The draft for this document, if there is one and it still applies.
   *
   * A draft records the storage version it was edited from. Once the document
   * has moved, those edits describe something that no longer exists, so the
   * draft is deleted rather than offered -- the same rule Papan applies with
   * `draftHash !== file.contentHash`.
   */
  async #freshDraft(
    identity: RequestIdentity,
  ): Promise<{ bytes: Uint8Array; baseVersion: VersionToken } | null> {
    const drafts = this.options.drafts
    if (!drafts) return null
    const draft = await drafts.get(identity)
    if (!draft) return null
    const stored = await this.options.storage.head(identity.documentId)
    if (draft.baseVersion === stored.version) return draft
    await drafts.delete(identity)
    return null
  }

  /** Write bytes into a private snapshot the sidecar can open. */
  async #snapshotFromBytes(
    bytes: Uint8Array,
    metadata: { version: VersionToken; name: string; displayPath?: string | undefined },
  ): Promise<Snapshot> {
    // Fail with something actionable before the sidecar turns this into an
    // EOCD error indistinguishable from corruption.
    assertOpenable(classifyWorkbookBytes(bytes))
    const dir = join(this.options.scratchDir, randomUUID())
    await mkdir(dir, { recursive: true })
    const snapshotPath = join(dir, sanitizeName(metadata.name))
    await writeFile(snapshotPath, bytes)
    return {
      snapshotPath,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      version: metadata.version,
      name: metadata.name,
      displayPath: metadata.displayPath,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    }
  }

  /**
   * Open this document for this caller, sharing the engine session where the
   * bytes are identical.
   *
   * The share key carries the storage version, so a client that opens after a
   * save gets its own engine rather than the pre-save one. A draft-backed open
   * is never shared: a draft is one user's unsaved work, and serving it to
   * someone else would hand them edits that are not theirs.
   */
  async open(identity: RequestIdentity): Promise<{
    session: WorkbookSession
    opened: OpenedWorkbook
    name: string
    displayPath: string | undefined
    fromDraft: boolean
    shared: boolean
  }> {
    const draft = await this.#freshDraft(identity)
    if (!draft) {
      const stored = await this.options.storage.head(identity.documentId)
      const key = shareKey(identity, stored.version)
      const existing = this.engines.get(key) ?? (await this.opening.get(key))
      if (existing) return { ...this.#attach(existing, identity), shared: true }

      const pending = this.#openEngine(identity, key, null)
      this.opening.set(key, pending)
      try {
        return { ...this.#attach(await pending, identity), shared: false }
      } finally {
        this.opening.delete(key)
      }
    }

    // Unique key: findable for cleanup, never matched by another open.
    const engine = await this.#openEngine(identity, `draft:${randomUUID()}`, draft)
    return { ...this.#attach(engine, identity), shared: false }
  }

  /** Give this caller a handle on an engine session, and count them in. */
  #attach(
    engine: EngineSession,
    identity: RequestIdentity,
  ): { session: WorkbookSession; opened: OpenedWorkbook; name: string; displayPath: string | undefined; fromDraft: boolean } {
    const sessionId = randomUUID()
    const session = new ClientSession(sessionId, identity.userId, identity.permission, engine)
    engine.clients.add(sessionId)
    this.sessions.set(sessionId, session)
    void this.#claim(sessionId)
    return {
      session,
      opened: engine.opened,
      name: engine.name,
      displayPath: engine.displayPath,
      fromDraft: engine.fromDraft,
    }
  }

  /** Take the snapshot and hand it to the sidecar. One per share key. */
  async #openEngine(
    identity: RequestIdentity,
    key: string,
    draft: { bytes: Uint8Array; baseVersion: VersionToken } | null,
  ): Promise<EngineSession> {
    // Only a new engine consumes quota: a second viewer of an open workbook
    // costs nothing that the quota exists to bound.
    this.enforceQuota(identity)
    const snapshot = draft ? await this.#snapshotFromDraft(identity, draft) : await this.#snapshotFromStorage(identity)
    try {
      const { sessionId, opened } = await this.options.pool.open(
        snapshot.snapshotPath,
        this.options.locale,
        undefined,
        (result) => openResultSchema.parse(result).sessionId,
        (result) => openResultSchema.parse(result),
      )
      const engine: EngineSession = {
        key,
        tenantId: identity.tenantId,
        documentId: identity.documentId,
        engineSessionId: sessionId,
        snapshotPath: snapshot.snapshotPath,
        byteLength: snapshot.byteLength,
        sha256: snapshot.sha256,
        openedFromVersion: snapshot.version,
        sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
        opened,
        name: snapshot.name,
        displayPath: snapshot.displayPath,
        fromDraft: snapshot.fromDraft === true,
        releaseSnapshot: snapshot.cleanup,
        clients: new Set(),
      }
      this.engines.set(key, engine)
      return engine
    } catch (error) {
      // The snapshot outlives a failed open only as garbage.
      await snapshot.cleanup()
      throw error
    }
  }

  /** Drop the engine when its last client leaves. */
  async #detach(session: ClientSession): Promise<void> {
    const engine = session.engine
    engine.clients.delete(session.sessionId)
    if (engine.clients.size > 0) return
    if (this.engines.get(engine.key) === engine) this.engines.delete(engine.key)
    await this.options.pool.close(engine.engineSessionId)
    await engine.releaseSnapshot()
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await this.#release(sessionId)
    await this.#detach(session)
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
  async reopenAfterSave(previous: WorkbookSession, saved: WorkbookMetadata): Promise<unknown> {
    const client = this.sessions.get(previous.sessionId)
    if (!client) {
      throw new SheetsError('session_gone', 'Workbook session is no longer open.')
    }
    const identity: RequestIdentity = {
      userId: client.userId,
      tenantId: client.tenantId,
      documentId: client.documentId,
      permission: client.permission,
    }

    // The saved bytes are a different share key, so this either joins whoever
    // already opened that version or becomes the engine everyone else joins.
    const key = shareKey(identity, saved.version)
    const engine = this.engines.get(key) ?? (await this.#openEngine(identity, key, null))

    // The client id does not change. Other clients still on the pre-save
    // engine keep it -- they are looking at bytes that still exist, and the
    // save's own push tells them the document moved.
    const stale = client.engine
    client.engine = engine
    engine.clients.add(client.sessionId)
    stale.clients.delete(client.sessionId)
    if (stale.clients.size === 0) {
      if (this.engines.get(stale.key) === stale) this.engines.delete(stale.key)
      await this.options.pool.close(stale.engineSessionId)
      await stale.releaseSnapshot()
    }

    return workbookFileSchema.parse({
      ...engine.opened,
      sessionId: client.sessionId,
      name: saved.name,
      path: workbookDisplayPath(saved.name, saved.displayPath),
      sha256: engine.sha256,
      fileBytes: engine.byteLength,
      readOnly: !canWrite(client.permission),
    })
  }

  /**
   * Which document each of these sessions belonged to, so a loss notice
   * reaches the right sockets. Called before `forget`, which discards them.
   */
  documentsFor(engineSessionIds: readonly string[]): Map<string, string[]> {
    const byDocument = new Map<string, string[]>()
    for (const engine of this.#enginesBySidecarId(engineSessionIds)) {
      const list = byDocument.get(engine.documentId) ?? []
      // The client is told about *its own* id: the sidecar's means nothing to
      // it, and one lost engine can take several viewers with it.
      list.push(...engine.clients)
      byDocument.set(engine.documentId, list)
    }
    return byDocument
  }

  /** The engines behind a set of sidecar session ids. */
  #enginesBySidecarId(engineSessionIds: readonly string[]): EngineSession[] {
    const wanted = new Set(engineSessionIds)
    return [...this.engines.values()].filter((engine) => wanted.has(engine.engineSessionId))
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

  /**
   * Drop sessions whose sidecar process died. Their snapshots still need
   * removing, and the pool is not asked to close what no longer exists.
   *
   * The ids are the sidecar's, so one of them can take several clients with it.
   */
  async forget(engineSessionIds: readonly string[]): Promise<void> {
    await Promise.allSettled(
      this.#enginesBySidecarId(engineSessionIds).map(async (engine) => {
        for (const sessionId of engine.clients) {
          this.sessions.delete(sessionId)
          await this.#release(sessionId)
        }
        engine.clients.clear()
        if (this.engines.get(engine.key) === engine) this.engines.delete(engine.key)
        await engine.releaseSnapshot()
      }),
    )
  }

  /**
   * Counted over engine sessions, not over clients.
   *
   * The quota bounds a resource, and the resource is the parsed workbook. Ten
   * people in one budget hold one workbook's worth of memory, and refusing the
   * tenth would be refusing something that costs nothing to grant.
   */
  private enforceQuota(identity: RequestIdentity): void {
    const { maxSessionsPerTenant, maxResidentBytesPerTenant } = this.options.quota
    let count = 0
    let bytes = 0
    for (const engine of this.engines.values()) {
      if (engine.tenantId !== identity.tenantId) continue
      count += 1
      bytes += engine.byteLength
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

  stats(): { sessions: number; workbooks: number; residentBytes: number } {
    let residentBytes = 0
    for (const engine of this.engines.values()) residentBytes += engine.byteLength
    // `sessions` is viewers, `workbooks` is what they are actually holding.
    return { sessions: this.sessions.size, workbooks: this.engines.size, residentBytes }
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

/**
 * What makes two opens the same open.
 *
 * The version is in the key on purpose: a client that opens after a save must
 * not join a session still holding the pre-save bytes. The tenant is in it
 * because a document id is only unique within one.
 */
function shareKey(identity: RequestIdentity, version: VersionToken): string {
  return `${identity.tenantId}\u0000${identity.documentId}\u0000${version}`
}
