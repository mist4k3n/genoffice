/**
 * The ports a host application plugs into.
 *
 * Nothing here knows about S3, Postgres, or any particular auth scheme. The
 * Hono app supplies implementations; this package supplies the spreadsheet
 * behaviour. PLAN.md, "Phase 02": never bake in a storage vendor.
 */

/** Opaque, storage-defined version token. Compare for equality, never order. */
export type VersionToken = string

export interface StoredWorkbook {
  readonly bytes: Uint8Array
  readonly version: VersionToken
  /** Display name; becomes the workbook's name and the basename of its path. */
  readonly name: string
  /** See {@link WorkbookMetadata.displayPath}. */
  readonly displayPath?: string | undefined
}

export interface WorkbookMetadata {
  readonly version: VersionToken
  readonly name: string
  readonly byteLength: number
  /**
   * Where this document lives, as the *user* would describe it --
   * "/Finance/2026/Q1/budget.xlsx", not a path on your server.
   *
   * The renderer surfaces it through Excel's `CELL("filename")`, which splits
   * it at the last separator to produce `dir/[budget.xlsx]Sheet1`. That is why
   * it must be path-shaped: the very common
   * `=MID(CELL("filename"),FIND("]",...)+1,31)` sheet-name idiom parses it.
   *
   * Optional. Without it the server synthesizes one from the document name, so
   * the formula still works and no server path is ever exposed.
   */
  readonly displayPath?: string | undefined
}

/**
 * Durable document storage.
 *
 * `put` takes the version the writer believed it was editing, so a concurrent
 * save is rejected rather than silently clobbering. Implementations should map
 * that to a conditional write (S3 `If-Match`, a row version, a CAS token) and
 * throw {@link VersionConflictError} when it fails.
 */
export interface StorageAdapter {
  head(documentId: string): Promise<WorkbookMetadata>
  get(documentId: string): Promise<StoredWorkbook>
  put(
    documentId: string,
    bytes: Uint8Array,
    expectedVersion: VersionToken | null,
  ): Promise<WorkbookMetadata>

  /**
   * Optional fast path: an absolute path to **immutable** bytes for this
   * document, which the engine may read directly.
   *
   * A session normally works from a private snapshot the server writes, so
   * that everything it serves comes from one consistent set of bytes even if
   * the document changes underneath. Content-addressed storage already
   * guarantees that: a blob named by the hash of its contents cannot change,
   * so it *is* a snapshot and copying it buys nothing.
   *
   * Returning a path therefore removes a full copy of every opened workbook
   * from both disk and the open path's latency. For a 30MB financial workbook
   * on a host where the scratch directory is a tmpfs, that copy is 30MB of
   * RAM per open document.
   *
   * **The contract is immutability, not merely existence.** If anything can
   * rewrite these bytes in place while a session holds them open, do not
   * implement this method -- return `null` and let the server take its own
   * copy. The server never writes to this path and never deletes it.
   */
  localPath?(documentId: string): Promise<LocalWorkbookRef | null>
}

export interface LocalWorkbookRef {
  /** Absolute path to immutable bytes. Never written to, never deleted. */
  readonly path: string
  readonly version: VersionToken
  readonly name: string
  readonly byteLength: number
  readonly displayPath?: string | undefined
  /**
   * SHA-256 of the bytes, hex, if storage already knows it.
   *
   * The renderer is given this as the workbook's identity. In a
   * content-addressed store it is usually the version token itself -- but only
   * usually, so it is a separate field rather than an assumption. When absent
   * the server streams the file to hash it, which is cheap next to copying it.
   */
  readonly sha256?: string | undefined
}

/** Who is asking, and for which document. Resolved per request by the host. */
export interface RequestIdentity {
  readonly userId: string
  /** Groups quota accounting. Use the userId when there is no tenancy. */
  readonly tenantId: string
  readonly documentId: string
  /** When false, every mutating channel is rejected before it reaches a session. */
  readonly canEdit: boolean
}

/**
 * Password supply for encrypted workbooks.
 *
 * Separate from StorageAdapter on purpose: a document's bytes and the secret
 * that opens them should not live behind the same credential. Returning null
 * means "no password on file", which surfaces to the client as a prompt rather
 * than an error.
 */
export interface SecretsAdapter {
  workbookPassword(documentId: string): Promise<string | null>
}

/**
 * Somewhere to put unsaved work that is not a version of the document.
 *
 * The distinction is the point, and it is not ours -- it is what Papan's
 * Collabora deployment already does, and #617 flags reproducing it as
 * load-bearing: *"or we get version spam or silent exit-save data loss."*
 * A 30-second recovery copy must never enter version history; a person
 * pressing Save must always create one.
 *
 * Upstream draws the same line, which is why nothing here needed inventing.
 * Its renderer writes a crash-recovery copy on its own 30-second timer through
 * a *separate* channel (`workbook:write-recovery`) that never touches the
 * document. On the desktop that copy lands under userData. Here it lands in
 * whatever the host gives us.
 *
 * Optional. Without it the recovery channel reports failure, which is what
 * upstream's renderer already expects from a best-effort write, and nothing
 * else changes.
 */
export interface DraftAdapter {
  /**
   * Store unsaved bytes for this document.
   *
   * `baseVersion` is the storage version they were edited from. It is what
   * makes staleness decidable later: a draft whose base no longer matches the
   * document describes edits to something that no longer exists.
   */
  put(
    identity: RequestIdentity,
    bytes: Uint8Array,
    baseVersion: VersionToken,
  ): Promise<void>
  /** The stored draft, or null. */
  get(identity: RequestIdentity): Promise<{ bytes: Uint8Array; baseVersion: VersionToken } | null>
  /** Drop it. Called when a real save supersedes it, and when it goes stale. */
  delete(identity: RequestIdentity): Promise<void>
}

export interface QuotaOptions {
  /** Concurrent open sessions per tenant. */
  readonly maxSessionsPerTenant: number
  /** Resident snapshot bytes per tenant, across all its sessions. */
  readonly maxResidentBytesPerTenant: number
  /** A session with no traffic for this long is closed and its scratch removed. */
  readonly idleTimeoutMs: number
}

export interface SidecarOptions {
  /**
   * Warm processes. Sessions are pinned to one, so this is the ceiling on
   * concurrent *workbooks* that can be served without queueing behind each
   * other, not on concurrent requests.
   */
  readonly poolSize: number
  /** Absolute path to the xlsx-sidecar binary. Defaults to XLSX_SIDECAR_PATH. */
  readonly binaryPath?: string | undefined
  /** Directory for snapshots. Defaults to a directory under the OS temp dir. */
  readonly scratchDir?: string | undefined
}

/**
 * Boot-time settings the renderer asks for before it paints. Plain values, not
 * an adapter: they are read once per page load and a host that wants them
 * per-user can close over the request in `identify` and pass them in.
 */
export interface AppPreferences {
  readonly language: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar'
  readonly theme: 'light' | 'dark' | 'system'
  readonly autoSave: boolean
  /** Shape owned by @genoffice/ui's AiPanelPrefs; an empty object is valid. */
  readonly aiPanel: Record<string, unknown>
  /** Returned by ai:get-settings. AI itself is phase 04. */
  readonly aiSettings: Record<string, unknown>
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  language: 'en',
  theme: 'system',
  autoSave: false,
  aiPanel: {},
  aiSettings: { provider: 'none', model: '', spellcheck: true },
}

export interface SheetsServerOptions {
  readonly storage: StorageAdapter
  /** Resolve the caller. Throw to reject; the router maps the throw to 401. */
  readonly identify: (request: Request) => RequestIdentity | Promise<RequestIdentity>
  readonly secrets?: SecretsAdapter | undefined
  /**
   * Where unsaved work goes between saves. Without one, the editor's recovery
   * timer is a no-op and an interrupted session loses whatever was pending.
   */
  readonly drafts?: DraftAdapter | undefined
  readonly preferences?: Partial<AppPreferences> | undefined
  readonly sidecar?: Partial<SidecarOptions> | undefined
  readonly quota?: Partial<QuotaOptions> | undefined
  /** UI language passed to the sidecar; affects number and date formatting. */
  readonly locale?: string | undefined
  /**
   * How long a document may have no connected sockets before its sessions are
   * closed. Must exceed the client's reconnect backoff. Defaults to 45s.
   */
  readonly socketIdleGraceMs?: number | undefined
  /**
   * How long an assembled Save As stays fetchable. The browser asks for it
   * immediately, so this is an abandonment timeout, not a budget. Defaults to
   * 60s.
   */
  readonly exportTtlMs?: number | undefined
}

export const DEFAULT_QUOTA: QuotaOptions = {
  maxSessionsPerTenant: 16,
  maxResidentBytesPerTenant: 512 * 1024 * 1024,
  idleTimeoutMs: 15 * 60_000,
}

export const DEFAULT_SIDECAR: Pick<SidecarOptions, 'poolSize'> = {
  poolSize: 4,
}
