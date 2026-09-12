# Papan → GenOffice Sheets — integration briefing

**Date:** 2026-09-12
**Status:** Research answer. No decision, no commitment — this documents Papan as it exists today, for the benefit of a separate repo building a browser-delivered spreadsheet (a fork of GenOffice, an Electron office suite) served by a Hono router.
**Audience:** the GenOffice Sheets author, and anyone touching `features/collab` or `@papan/storage`.
**Companion:** `docs/plans/2026-09-11_OFFICE_ENGINE_MIGRATION.md` (#617) — read that first; see §0.

Citations are `path/to/file.ts:line` against `main` at commit `ded0db4c2`.

---

## 0. Read this first — there is a competing decision in flight

Papan decided on 2026-09-11 to migrate Collabora → upstream **OnlyOffice CE 9.4**. Design of
record: `docs/plans/2026-09-11_OFFICE_ENGINE_MIGRATION.md`, tracked in **#617**. Status line:
*"Decided. Spike, then build."* Nothing is built yet.

The motivation is the same as GenOffice Sheets' (the ~7-document ceiling) and the fix direction
is the same (move rendering to the client). The two efforts collide head-on. The framing in that
doc is the political constraint any alternative has to argue against:

> office editing is **not** the primary product — we optimise for server cost and operational
> simplicity over editor polish and whitelabel.

That document is also the most useful single artifact for this integration: §5 is a ~60-item
re-verification checklist of everything Collabora does today that *any* replacement must match.
It is 162 lines. Read it in full.

One asymmetry worth naming: #617 §2 accepts a fidelity loss as the price of client-side
rendering. GenOffice Sheets claims the opposite — byte-level fidelity by rewriting only the
changed parts of the `.xlsx` package (one `sheet1.xml`, not the whole archive). That is the
strongest argument available and it contradicts #617's stated trade-off directly.

---

## Section A — The VFS and how bytes are stored

### A1. Public API of the VFS

The package is `@papan/storage` (`shared/storage/src/index.ts`). The class is **`TreeStorage`**
(`shared/storage/src/tree-storage.ts:566`, 4852 lines). Obtain one via `getStorage(tenantId)`
(`features/files/core/storage.ts:141`) — cached per tenant, constructed against exactly one
tenant, with a `readonly tenantId` field so nothing can retarget an instance.

**`StorageBackend` / `TenantStorage` in `shared/storage/src/types.ts` are not the VFS.** They are
a lower, largely legacy key-value layer (local filesystem / R2). Do not build against them.

The methods that matter:

```ts
// shared/storage/src/tree-storage.ts
async write(parentId: string | null, name: string, content: Buffer, options: {
  actor?: VersionActor
  source: string
  description?: string
  mimeType?: string
  /** CAS precondition. Three-value semantics — see A3. */
  expectedPriorContentHash?: string | null
  freezeExempt?: WriteFreezeExemption
  capExempt?: StorageCapExemption
  modeExempt?: TenantModeExemption
}): Promise<WriteResult>                                       // :733

async writeById(fileId: string, content: Buffer, options: {
  actor?: VersionActor
  source: string
  description?: string
  sidecarHash?: string | null
  capExempt?: StorageCapExemption
}): Promise<WriteResult>                                       // :1458  ← no CAS parameter

async read(fileId: string): Promise<Buffer>                    // :1558
async readStream(...)                                          // :1643
async readVersion(fileId, versionId): Promise<Buffer>          // :1790
async getFile(fileId): Promise<FileNode | null>                // :1834
async getFileSize(fileId): Promise<number | null>              // :1780
async getPath(fileId): Promise<string | null>                  // :1895
async getBreadcrumbs(fileId): Promise<Array<{id, name}>>       // :1900
async getRealPath(fileId): Promise<string | null>              // :3073
async listVersions(fileId): Promise<FileVersion[]>             // :2280
async restoreVersion(fileId, versionId, actor)                 // :2297
async saveAs(sourceFileId, destParentId, destName, content, opts)  // :3556
async rename(...)                                              // :2124
async move(fileId, newParentId, actor?)                        // :2234
```

The exported types:

```ts
export interface WriteResult {          // tree-storage.ts:381
  fileId: string
  versionId: string
  contentHash: string
  size: number
  isNew: boolean
  file?: FileNode
}

export interface FileNode {             // tree-storage.ts:519
  id: string
  parentId: string | null
  name: string
  isFolder: boolean
  contentHash: string | null
  size: number
  mimeType: string | null
  createdAt: Date
  updatedAt: Date
  updatedBy: { type: string; id: string; name: string } | null
}

export interface FileVersion {          // tree-storage.ts:399
  id: string
  fileId: string
  versionNumber?: number
  contentHash: string
  size: number
  createdBy: VersionActor | null
  source: string
  description?: string
  appFolderId?: string
  createdAt: Date
}

export class WriteConflictError extends Error {}   // tree-storage.ts:237
export class MoveCycleError extends Error {}       // tree-storage.ts:250
export class MaxFolderDepthError extends Error {}  // tree-storage.ts:258
```

### A2. What identifies a file

A nanoid string `id`, **stable across rename and move**. `parentId` and `name` are mutable
columns; `id` is not. Drive root is `parentId === null`.

Two wrinkles:

- **Drive-root normalisation.** The realtime layer emits `parentId === papan_<tenantId>` for the
  drive root while the client cache uses `null`. Every event parent must pass through
  `normalizeEventParentId`, or a phantom cache key results. Guarded by
  `e2e/upload-realtime.spec.ts`.
- **Compound mount ids.** A file inside a mounted cross-tenant `.shared` / `.chain` folder is
  synthesised with the id `s_<mount>_<src>` and has **no row in the recipient's tenant**. It is
  resolved through `resolveMountFileForRead` (`features/files/api/mount-file.ts`). The WOPI token
  mint handles this at `features/collab/server/wopi-routes.ts:73`; any replacement must too, or
  Office documents inside received folders never open. That was a real, shipped bug (#405), and
  #617 §5.E calls it *"least-obvious, most security-sensitive."*

### A3. Version / revision / ETag — partial CAS, and the office path does not use it

- **The version token is `contentHash`** — SHA-256 of the content, on `FileNode`. Opaque,
  equality-compared, never ordered. That is the `VersionToken` equivalent.
- **Every write produces a new row in `versions`**, and version history is browsable and
  restorable: `listVersions` / `restoreVersion`, exposed as `GET /api/files/:id/versions` and
  `POST /api/files/:id/restore` (`features/files/client/index.ts:920`). Retention is a ladder
  resolved per file / ext / kind / tenant / platform (`features/files/client/index.ts:940`).
- **Conditional write exists on `write()` only.** Three-valued, documented at
  `shared/storage/src/tree-storage.ts:651`:

  ```
  absent  → unconditional write (legacy)
  null    → caller expects to *create* the file. Proceeds with creation; if the
            duplicate-key race triggers, throws WriteConflictError instead of
            silently downgrading to an unconditional update — that downgrade was
            the original "last writer wins" data-loss bug for parallel first-writes.
  string  → caller expects the file to exist with that content_hash. Update is
            CAS-protected; throws WriteConflictError on mismatch.
  ```

  The caller is expected to re-read and retry on `WriteConflictError`.

- **`writeById` has no `expectedPriorContentHash`** (`tree-storage.ts:1458`). It is
  unconditional. And `writeById` is exactly what the Collabora PutFile handler calls.
- **Today's office save is explicitly last-write-wins**, by decision rather than omission —
  `features/collab/server/wopi-routes.ts:558`:

  > `// No 409 conflict detection here — we handle conflicts ourselves via the conflict banner`
  > `// (useWopiConflict). Returning 409 triggers Collabora's native conflict popup which`
  > `// duplicates our UI. Always allow PutFile through.`

**Implication.** An optimistic-concurrency save survives contact with reality, but the parameter
has to be added to `writeById`. The mechanism is already there — per-blob advisory locks via
`withBlobLock` and `withTenantStorageWriteLock` (`tree-storage.ts:1502`) — so this is a small,
well-shaped change rather than a new subsystem. What must *not* change is the presentation:
Papan surfaces conflict as an in-app banner, never as a browser-native or editor-native dialog
(see B12).

### A4. Where bytes actually live

**Local filesystem, content-addressed.** Not S3/R2/GCS in practice.

```
{basePath}/content/{hash[0:2]}/{hash[2:4]}/{hash}   ← blobs, SHA-256, deduplicated
{basePath}/quarantine/{hash}
{basePath}/temp/
{basePath}/tree/{tenantId}/...                      ← mirrored real tree (TreeWriter)
```

See `shared/storage/src/content-store.ts:1` for the layout comment and `getTreeRoot()` at
`features/files/core/storage.ts:158`.

`R2StorageBackend` exists (`shared/storage/src/backends/r2.ts:23`) and declares an optional
`getSignedDownloadUrl`, but it is **not wired into `TreeStorage`**. There is no CDN and no
signed-URL read path; everything streams through Hono.

The mirrored real tree is what the agent sandbox bind-mounts into containers and what
`FileWatcher` watches for out-of-band edits.

**Consequence worth acting on:** a server-side snapshot of an open workbook can be a hardlink or
a direct read of `getRealPath(fileId)`. It does not need an HTTP fetch.

### A5. Size limits

- API body caps (`apps/api/src/body-limits.ts:41`): `/api/files/*` and `/api/wopi/*` are **2 GB**;
  every other `/api/*` route defaults to **1 MB**. The resolver returns the *smallest* matching
  rule, because every matching `bodyLimit` middleware runs and the first to trip wins.
- Draft-store cap `OFFICE_MAX_DRAFT_MB` defaults to **2 GB**, deliberately matched to coolwsd's
  own editable-document ceiling. Setting it lower silently loses edits to a valid large document.
- `TreeStorage.read()` returns a whole `Buffer`. `readStream` / `readVersionStream` exist, but the
  WOPI GetFile path deliberately uses the buffered read — the streaming change was reverted, with
  reasons, at `features/collab/server/wopi-routes.ts:700`.
- Tenant storage is **quota-enforced, never metered**: `assertStorageCapacity` fires at
  `createVersion` / `files.create`, and going over raises `StorageQuotaExceededError`, which the
  WOPI handler maps to **413** (see B9).
- Financial workbooks in the tens of MB: yes. `dw/test-corpus/` is the heavy-`.xlsx` corpus the
  #617 spike uses for client-device render cost.

### A6. Encryption at rest, and plaintext on disk

**There is no encryption at rest for file content.** Blobs sit as plaintext on the host
filesystem. A server-side scratch snapshot of an open workbook is therefore no worse than the
status quo: the agent sandbox already bind-mounts the real tree into containers, and Collabora
already receives complete plaintext bytes today.

Encryption exists only for *secrets*, via `@papan/keybook` — AES-256-GCM with HKDF-derived
per-tenant keys (`shared/auth/src/keybook-crypto.ts:1`). See I45.

One deployment fact that does bite a scratch directory: **`/tmp` is RAM** (tmpfs, half of RAM) on
gnexis and every host provisioned from Ubuntu 26.04 onward; 24.04 boxes have it on disk, and `df`
renders both identically — use `findmnt /tmp`. Anything above roughly 100 MB belongs in
`/var/tmp` or `/data`. Key the choice on size, not on whether the box is known to be tmpfs.

### A7. Per-file locks

**None. There is no WOPI Lock / Unlock.** Confirmed by absence in
`features/collab/server/wopi-routes.ts` and stated in #617 §5.F:

> There is **no WOPI Lock/Unlock today** (Collabora uses one shared broker; conflict is
> app-level). OnlyOffice uses its own co-editing/session model + CommandService `drop` for
> eviction — design it explicitly; don't assume a lock layer to lean on.

Concurrency today is one shared coolwsd broker per WOPISrc, with all co-editors multiplexed into
it.

### A8. Metadata a file carries

On `FileNode`: `name`, `parentId`, `size`, `mimeType`, `contentHash`, `createdAt`, `updatedAt`,
`updatedBy`. Path and breadcrumbs via `getPath` / `getBreadcrumbs`.

Beyond that there is a **`.pmeta` sidecar** — a real VFS file beside the source
(`data.csv` → `data.csv.pmeta`) holding editor-specific metadata
(`features/collab/server/persistence.ts:160`). It is created on the *first* save of an existing
document, which is a create performed by an edit — the reason the write-freeze needs an explicit
`companion-of-edit` exemption. If an editor persists view state, styles, or similar, `.pmeta` is
the existing convention.

---

## Section B — Save, Save As, and the dialog

### B9. What happens today when a user saves in Collabora

1. The host posts `Action_Save` into the iframe.
2. Collabora issues `POST /api/wopi/files/:fileId/contents?access_token=…`.
3. The handler (`features/collab/server/wopi-routes.ts:496`) validates the token, checks the
   token/file id match, requires `permissions === 'readwrite'`, and re-runs the pointer
   permission check.
4. **Header fork.** `x-cool-wopi-isautosave` or `x-cool-wopi-isexitsave` route the body to the
   **draft store**, not the file. Only explicit saves write a version.
5. Explicit save calls
   `storage.writeById(fileId, content, { actor, source: 'collabora', description })`.
6. Then `clearSessionDirty` + `deleteDraft`, a broadcast of
   `{ type: 'oo-dirty', fileId, isDirty: false }`, and `_markOfficeSave` so the `FileWatcher`
   does not mint a spurious "External edit" version for Papan's own write.
7. Errors: `ENOSPC` or `StorageQuotaExceededError` become **413** with
   `STORAGE_QUOTA_EXCEEDED_CODE`; everything else is a 500.

The 413 comment (`wopi-routes.ts:604`) is worth reading in full. An opaque 500 on a full disk
sent an investigation at the editor image, the kit jails, and the upstream Collabora version
before anyone ran `df` — roughly a day, on 2026-08-21, with the user's edits unsaved throughout.

**The three-way autosave / exit-save / explicit-save split is the load-bearing behaviour to
replicate.** #617 §3.1 flags it: re-derive it from whatever the new engine's save protocol is,
*"or we get version spam or silent exit-save data loss."*

### B10. The Save As dialog

Component: `features/workspace/ui/SaveAsDialog.tsx`, built on `PickerNavigator`
(`features/files/ui/PickerNavigator.tsx`), which is shared by every picker dialog — Open File,
Save As, Link Folder, Drive picker.

The user chooses a **destination folder and a filename**. There is no format choice. The wrapper
owns read-only detection with auto-jump to a writable folder, extension-mismatch confirmation,
conflict resolution, and recent-folder memory (localStorage,
`papan:export-recent-folder:<tenantId>`).

Default API (`features/files/client/index.ts:893`):

```ts
async saveAs(
  sourceFileId: string,
  destParentId: string | null,
  destName: string,
  keepBoth?: boolean,
  addVersion?: boolean,
): Promise<{ fileId: string; name: string }>
// → POST /api/files/save-as
```

**There is a `customSave` escape hatch, and it is the integration point:**

```ts
customSave?: (
  destParentId: string | null,
  destName: string,
  keepBoth: boolean,
  addVersion: boolean,
) => Promise<{ fileId: string; name: string }>
```

Supplying a `customSave` that writes patched bytes to a new file gives the whole picker for free —
no new dialog, and no need for a separate "create a new document" port. The HTML editor's
PDF export already does exactly this (`features/collab/ui/useSnapshotExport.tsx:124`).

The default server path routes through the Yjs websocket handler
(`features/collab/server/yjs-handler.ts:2593`) because it must capture the live Y.Doc including
unsaved changes, and then calls `storage.saveAs()`.

After a Save As the dialog calls `onSaved(newFileId)` and the caller decides what happens — there
is no forced navigation.

### B11. Autosave

Yes, and it is not optional. Two layers, and the first is counter-intuitive:

- **Collabora is configured with no periodic autosave.** `docker-compose.yml:167` sets
  `per_document.autosave_duration_secs=0` and `always_save_on_exit=false`. The **exit-save is the
  only automatic write.** This is load-bearing: `wopi-routes.ts:545` explains that a failed draft
  deliberately leaves the session dirty, because with no periodic draft to recover from, clearing
  the flag would be a *silent* discard.
- **Papan's own draft store is the safety net.** Disk-backed bytes, a Redis pointer, a 7-day TTL,
  and staleness detected by `contentHash` — a changed file evicts the stale draft on read. It is
  provider-agnostic and is explicitly **kept** through the OnlyOffice migration (#617 §4).

Dirty indicator: yes. `Doc_ModifiedStatus` → server `markSessionDirty` → `oo-dirty` broadcast →
`useWopiConflict.isDirty` → toolbar. Server-persisted, keyed `tenant:fileId`, so it survives a
session ending and stays coherent across api-0 and api-1.

**Recommendation:** an explicit save writes a version; a periodic autosave writes a draft and
never a version. Matching the existing split keeps version-retention from churning.

### B12. Conflict handling

Today it is an **app-level banner, deliberately not a 409**.
`features/collab/ui/useWopiConflict.ts` plus `ConflictBanner.tsx`. The hook exposes `isDirty`,
`isConflicted`, `conflictView`, `conflictGeneration`, `editorGeneration`, `showSavedVersion`,
`handleDiscard`, `handleOverwrite`. `showSavedVersion` mounts a **second, read-only editor
instance** side by side.

The trigger is a realtime `oo-conflict` broadcast: the file on disk changed while the room is
dirty.

There are **three distinct conflict systems, and #617 §5.D says do not conflate them**:

1. **Office live-edit conflict** — `useWopiConflict` / `ConflictBanner`. Keep-mine, overwrite,
   `showSavedVersion` toggle. *This is the relevant one.*
2. **AI conflict resolution** — `RevertConflictModal` → `ConflictChatView`, `revert.ts`. Merges
   live with a three-tab Original / Agent / Current view. Depends on the reload chain working.
3. **Not office** — the DatabaseViewer's per-cell mine/theirs, and HtmlEditor's Yjs
   `MSG_CONFLICT`. Separate systems that only share the vocabulary.

A 409 should therefore carry the current `contentHash` plus enough context for the banner to
offer keep-mine / overwrite / show-saved-version, and should be surfaced to the *host* as an
event, not to the editor as a protocol error.

### B13. Rename while open

Yes. `TreeStorage.rename()` (`tree-storage.ts:2124`) emits a realtime `file:*` event; the client
patches its cache via `patchListsFromFileEvent` rather than refetching. There is a realtime
WebSocket (`features/realtime`) to subscribe to, so the currently no-op rename-notification
channel has a real event source.

Note that the `.pmeta` sidecar rename is a companion effect (`CompanionEffects`,
`tree-storage.ts:419`) — the two rename together.

### B14. Audit log of saves

**Version history is the audit log.** Every version row carries `createdBy: VersionActor`,
`source` (for example `'collabora'`), `description`, and `createdAt`.

`VersionActor` kinds include `user`, `share`, `system` (with `mechanism: 'external'` and label
`'External edit'`), and app actors. It is constructed **only** via `resolveWriteActor`
(`shared/types/src/versions.ts`), re-exported from `@papan/storage` — the sole constructor, so
the actor type and its builder come from one place.

Any new write path must stamp a distinguishing `source` string so history stays legible.

`budget_audit` is a *money* audit table, append-only behind a database trigger. It is not for file
saves.

### B15. Abandoned changes and crash recovery

Covered by the draft store (B11) plus a warm-room window: a Yjs room's in-memory Y.Doc and epoch
survive **60 s** after the last client leaves (`ROOM_EVICTION_MS`,
`features/collab/server/yjs-handler.ts:47`), set equal to the client's `DISCONNECT_GRACE_MS`
because the two run sequentially rather than concurrently. A reconnect inside that window finds
the room warm — same epoch, no reload from Postgres, no content blip.

A periodic recovery copy is worth building. The precedent is unambiguous that it must be a
**draft, not a version**.

---

## Section C — Identity, permissions, tenancy

### C16. How the frontend authenticates

`shared/auth/src/middleware.ts:74`:

```ts
/**
 * Auth middleware: resolves the request identity.
 *
 * Priority:
 * 1. X-Api-Key header → validate against DB
 * 2. Better Auth session cookie → validate session
 * 3. x-tenant-id header → accept as legacy (when AUTH_REQUIRED !== 'true')
 * 4. None → 401
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  // If an earlier middleware (e.g. shareSessionAuth on /api/sqlite/*)
  // already resolved an auth principal, honor it and skip the standard
  // chain. Lets share-link recipients pass without owning a Drive
  // session or API key.
  if (c.get('auth')) return next()

  const authRequired = process.env.AUTH_REQUIRED === 'true'

  // 1. Try API key
  const apiKeyHeader = c.req.header('x-api-key')
  if (apiKeyHeader && isValidKeyFormat(apiKeyHeader)) {
    const auth = await resolveApiKey(apiKeyHeader, c)
    if (auth) {
      c.set('auth', auth)
      return next()
    }
    return c.json({ error: 'Invalid API key' }, 401)
  }

  // 2. Try Better Auth session cookie
  const sessionAuth = await resolveSession(c)
  if (sessionAuth) {
    c.set('auth', sessionAuth)
    return next()
  }

  // 3. Legacy fallback (dev mode only)
  if (!authRequired) {
    const tenantId = c.req.header('x-tenant-id')
    if (tenantId) { /* … synthetic legacy auth context … */ }
  }

  return c.json({ error: 'Authentication required' }, 401)
}
```

The context it establishes (`shared/auth/src/types.ts:20`):

```ts
export interface AuthContext {
  user: AuthUser
  tenantId: string
  /** The email identity for the active tenant. Set by resolveTenant.
   *  Don't read this directly with `?? user.email` — use getOrgEmail(auth). */
  orgEmail?: string
  source: 'session' | 'api-key' | 'legacy' | 'share'
  apiKey?: ApiKeyInfo
  sessionId?: string
  viaShareSession?: {
    shareId: string
    sharePermission: string
    rootFileId: string
    isLive: boolean
  }
}

export interface AuthUser {
  id: string
  email: string
  name: string
  personalTenantId: string
  role: string              // 'owner' | 'admin' | 'member'
  platformRole: string      // platform-level super admin
  emailVerified: boolean
  restrictedAt?: string | null
}
```

Two operational facts:

- **The session cookie is Better Auth's, and it is host-only on the `-api` origin.** Since #233
  the browser's `/api`, `/ws`, and `/s/` requests go **direct** to the `-api` / `preview-` origins,
  derived at runtime from the hostname (`shared/api-client/src/origin.ts`). A new stable hostname
  needs an entry in `origin.ts`, in `functions/_proxy.ts`, **and** in the two hand-copied static
  account pages `apps/web/public/__accounts/{embed,consent}.html` (no bundler runs over those).
  The failure chain is silent at every link: unknown host → same-origin → CF Pages answers the
  SPA shell with `200 text/html` → `r.json()` throws into a swallowed catch.
- **Never read `auth.orgEmail` directly.** Use `getOrgEmail(auth)`
  (`shared/auth/src/middleware.ts:14`); it throws when `resolveTenant` was skipped rather than
  silently misattributing an org action to a non-membership identity.

### C17. Per-document permission

`shared/database/src/repositories/permissions.ts:12` and `:594`:

```ts
export type FilePermission =
  | 'owner' | 'admin' | 'readwrite' | 'readcopy' | 'hidden' | 'none'

export async function resolveFilePermission(
  db: Database,
  userId: string,
  userTenantId: string,
  fileId: string,
  orgEmail?: string,
  opts?: ComputePermissionOptions,
): Promise<FilePermission>
```

Helpers: `canRead(p)` (`p !== 'none' && p !== 'hidden'`), `canWrite(p)`,
`canSee(p, isFolderLike)`.

Resolution order, from the doc comment at `permissions.ts:580`: explicit `folder_permissions`
(user beats team beats role; deepest match wins within each type) → base role → the Restricted
folder boundary. For cross-tenant access, keyed on the *acting* tenant: workspace link (closest
ancestor wins) → tenant-keyed share grant (deepest wins) → `'none'`.

**Read-only is a real state.** `readcopy` and `hidden` are distinct from `none`. WOPI maps it
directly — `UserCanWrite: tokenData.permissions === 'readwrite'`, with readonly additionally
setting `DisablePrint` / `HidePrintOption` (`wopi-routes.ts:466`). Map `readcopy` and `hidden`
onto the workbook's `readOnly` flag.

### C18. Tenancy

**`tenantId` is the grouping key.** A tenant is either personal (`p_…`) or an organization
(`o_…`). `TreeStorage` is per tenant; Postgres enforces RLS per tenant; cross-tenant reads must
use `getUnscopedDb()`.

Three axes that break a naive metering key:

- **`payer_tenant_id`** (`agent_usage`, `resource_usage`; nullable, `NULL` means same as
  `tenant_id`). Who paid is not who the work ran for. Every money read resolves
  `COALESCE(payer_tenant_id, tenant_id)`. Design:
  `docs/plans/2026-08-18_PLATFORM_ADMIN_PAYER_ATTRIBUTION.md`.
- **Identity-only tenants.** `TenantMode = 'full' | 'identity-only'` refuses all writes.
  **The resource tenant decides, never the actor's** — `assertTenantWritable` takes the tenant
  that *owns* the thing being written. `TreeStorage.assertModeWritable` is called first thing in
  every public mutator (`tree-storage.ts:645`), with a coverage test that fails when a mutator
  does not reach it. Design: `docs/plans/2026-08-11_IDENTITY_ONLY_TENANT_MODE.md`.
- **The write freeze** (manual billing's "uploads paused"). One gate at `repos.files.create`; it
  blocks *new* items only, so editing existing documents keeps working. That is why the `.pmeta`
  sidecar needs `freezeExempt: { reason: 'companion-of-edit' }`, verified against a real row.

### C19. How Collabora gets its credentials — WOPI

**Token mint.** `POST /api/wopi/token`, session-authenticated, returns `{ token, wopiSrc, expires }`.
1-hour TTL, stored in Redis (`features/collab/server/wopi-token.ts:82`, `:144`). Share-kind
tokens are additionally indexed under `wopi:share:<shareId>` so a share revoke can mass-delete
every outstanding token without scanning the keyspace.

**CheckFileInfo** — `features/collab/server/wopi-routes.ts:409`:

```ts
wopi.get('/files/:fileId', async (c: any) => {
  const token = c.req.query('access_token')
  const tokenData = await validateWopiToken(token)
  if (!tokenData) return c.json({ error: 'Invalid or expired token' }, 401)

  const { fileId } = parseFileIdParam(c.req.param('fileId'))
  if (tokenData.fileId !== fileId) return c.json({ error: 'Token/file mismatch' }, 403)

  const storage = getStorage(tokenData.tenantId)
  const file = await storage.getFile(fileId)
  if (!file) return c.json({ error: 'File not found' }, 404)

  // Pointer-provenance token: per-request access re-check, so a revoke 404s
  // now rather than at token expiry.
  if (tokenData.pointerFileId && tokenData.pointerTenantId) {
    if (await pointerAccessDenied(tokenData)) {
      return c.json({ error: 'File not found' }, 404)
    }
  }

  // Use file mtime as version — changes on every disk write, no I/O overhead.
  let liveVersion = file.contentHash || '0'
  try {
    const filePath = await storage.getQueryPath(fileId)
    if (filePath) {
      const { stat } = await import('fs/promises')
      const st = await stat(filePath)
      liveVersion = String(st.mtimeMs)
    }
  } catch { /* fall back to stored hash */ }

  // Fold the discard generation into Version: a discard reverts the document
  // IN PLACE on the SAME broker, so mtime alone stays constant and coolwsd
  // would keep serving its cached dirty copy.
  const discardGen = await getDiscardCount(tokenData.tenantId, fileId)
  const version = `${liveVersion}.${discardGen}`

  const canWrite = tokenData.permissions === 'readwrite'

  return c.json({
    BaseFileName: file.name,
    Size: file.size || 0,
    OwnerId: tokenData.userId,
    UserId: tokenData.userId,
    UserFriendlyName: tokenData.userName,
    UserCanWrite: canWrite,
    UserCanNotWriteRelative: true,
    PostMessageOrigin: (process.env.CORS_ORIGIN?.split(',')[0]) || '*',
    EnableOwnerTermination: true,
    DisablePrint: !canWrite,
    HidePrintOption: !canWrite,
    DisableExport: false,
    HideExportOption: false,
    DisableCopy: false,
    LastModifiedTime: file.updatedAt
      ? new Date(file.updatedAt).toISOString()
      : new Date().toISOString(),
    Version: version,
  })
})
```

Two decisions encoded there are worth carrying forward regardless of engine:

- **`Version` is mtime plus a discard generation, not the content hash.** A discard reverts in
  place on the same broker without changing storage, so mtime alone would not move and the editor
  would keep its cached dirty copy. Bumping a counter changes the change-detection key. The
  earlier approach — bumping the WOPISrc — spun a second fat process and deadlocked admission.
- **`UserCanNotWriteRelative: true`.** The editor is never permitted to create files. Save As is
  Papan's dialog, always.

**GetFile** — `wopi-routes.ts:659`. Serves, in order: a requested `versionId`; then a non-stale
draft (stale means `draftHash !== file.contentHash`, and the stale draft is deleted); then
`storage.read(fileId)`. Buffered rather than streamed, intentionally — the reasoning is at
`:700`.

**PutFile** — `wopi-routes.ts:496`, walked through in B9. The security core is two re-checks:

```ts
if (tokenData.permissions !== 'readwrite') {
  return c.json({ error: 'Read-only access' }, 403)
}
// Pointer-provenance write-through: every save re-requires a WRITEABLE mount
// resolution — a grant downgraded to read, or revoked, 403s the very next save;
// the 1h token TTL is only a backstop.
if (tokenData.pointerFileId || tokenData.pointerTenantId) {
  if (await pointerWriteDenied(tokenData)) {
    return c.json({ error: 'Read-only access' }, 403)
  }
}
```

**Every call re-resolves the grant; the TTL is only a backstop.** #617 §5.E lists this as
load-bearing and fail-closed.

Also on the router: `POST /discard`, `POST /resolve-conflict`, `POST /heartbeat`, `POST /close`,
`POST /drafts/mark-dirty`, `GET /drafts/:fileId/status`.

### C20. Anonymous and semi-authenticated callers

Yes — share links. `source: 'share'`, a synthetic user id `share:<linkId>[:<email>]`, and
`AuthContext.viaShareSession`. The auth context holds the **owner's** `tenantId` so handlers
operate on the real storage; the scope and permission cap come from `viaShareSession`.

Rules, from `wopi-routes.ts:60`:

- The requested `fileId` must equal `viaShareSession.rootFileId`.
- `sharePermission === 'edit'` lifts to `readwrite`; view and copy shares stay `read`.
- Writes stamp `actor.type = 'share'` so version-history readers do not FK-join to `users`.
- `isLive` decides whether the recipient joins the owner's live broker or gets a session-scoped
  snapshot broker.

Two sharing primitives, and the distinction matters: `.shared` is cross-tenant, governed, and
id-bound; `.chain` is a same-tenant pointer. Model:
`docs/plans/2026-05-15_SHARE_PRIMITIVE.md`.

---

## Section D — How Collabora is wired today

### D21. Embedding and the message protocol

**An iframe, driven by `postMessage(JSON.stringify({...}), '*')`.** URL shape:
`${COLLABORA_URL}/browser/dist/cool.html?WOPISrc=…&access_token=…`.

Core component `features/collab/ui/CollabDocModifier.tsx` (iframe, PostMessage API, token fetch,
dirty tracking, connectivity); wrappers `CollabExcelEditor`, `CollabDocEditor`,
`CollabSlidesEditor`; read-only `CollabDocViewer`.

Protocol (`docs/editor/COLLABORA.md:70`):

| MessageId | Direction | Purpose |
|---|---|---|
| `Host_PostmessageReady` | host → editor | sent on iframe load, enables communication |
| `Action_Save` | host → editor | trigger save (editor then calls WOPI PutFile) |
| `Hide_Menubar` | host → editor | hide menu in readonly mode |
| `Collapse_Notebookbar` | host → editor | collapse toolbar in readonly mode |
| `App_LoadingStatus` | editor → host | `Frame_Ready`, `Document_Loaded` |
| `Doc_ModifiedStatus` | editor → host | `Modified: true/false` — dirty state |
| `App_VersionRestore` | editor → host | `Pre_Restore_Ack` — reload acknowledged |
| `UI_Close` | editor → host | editor closing |

Custom build only (patches in `docker/collabora/patches/`):

| MessageId | Direction | Purpose |
|---|---|---|
| `Reload_From_Storage` | host → editor | in-place refresh without iframe teardown |
| `Get_View_State` / `Set_View_State` | host → editor | scroll position, zoom, active sheet |
| `Send_UNO_Command` | host → editor | dispatch a UNO command (`.uno:Undo`, `.uno:Redo`) |
| `Command_State_Changed` | editor → host | UNO command state (undo/redo enablement) |

Patch `0002` additionally adds `Get_Selection` / `Subscribe_Selection`, feeding the current cell
or shape to the AI chat as `papan:editor-selection-change`.

### D22. What the host needs from the editor

From the protocol above: dirty state; document-loaded and connectivity (`onConnectedChange`
drives a Wifi / WifiOff icon in the wrappers); acknowledgement of a host-initiated save;
undo/redo enablement for the toolbar; view state so a reload preserves scroll and active sheet;
the current selection for AI context; and close.

Of these, the **selection bridge** is the one most likely to be silently lost. #617 §5.A:

> **Editor selection → AI chat context** — Collabora patch `0002` fed the current cell/shape to
> the agent (`papan:editor-selection-change`). Rebuild on OnlyOffice's connector API, or the
> agent loses editor-selection context.

### D23. Deployment and scaling

**One shared container per deployment.** `docker-compose.yml:157`:
`papan/collabora:custom`, `platform: linux/amd64`, bound to `127.0.0.1:9980`, requiring
`MKNOD`, `SYS_CHROOT`, `SYS_ADMIN`, `FOWNER`, `CHOWN` and `seccomp:unconfined` for its jail
system. Branding CSS/JS/icons are bind-mounted read-only.

Not per tenant, and **no sticky sessions at the load balancer**. Instead there is a Redis-shared,
RAM-weighted admission store inside the app (`features/collab/server/office-brokers.ts`), because
both API instances mint tokens.

On Apple silicon the image is unpublished for arm64, so `docker compose up` skips it with a
`pull access denied` line and every failure after that is silent — the viewer mounts and no tiles
ever arrive. Build natively and clear the `platform` pin; do not emulate.

### D24. The actual bottleneck, with numbers

**Memory, per open document, inside the coolwsd process.** Not CPU, not connection count.

From `features/collab/server/office-brokers.ts:1` and `ecosystem.config.cjs`:

- Per-document RSS spans roughly **50–300 MB**; measured at about **145 MB settled / 280 MB peak**
  for a heavy `.xlsx`.
- **The unit is the broker, keyed by WOPISrc — not the session.** coolwsd multiplexes co-editors
  and live `.shared` opens into one broker holding one copy of the document. A second co-editor
  of a resident document adds zero RAM. Counting token mints over-counts.
- Production values, which must match across api-0 and api-1 because the store is Redis-shared:
  `OFFICE_BUDGET_MB=1200`, `OFFICE_EST_RSS_MB=280`, `OFFICE_ADMISSION_ENFORCE=1`, against a 2 GB
  container `mem_limit`. Invariant: budget + peak (1480) ≤ coolwsd's memproportion budget (1638)
  < 2048.
- On the free path (no reserve carve-out) that admits roughly **four distinct documents**.
- **#617 §2 states the real ceiling: about 7 concurrent documents across all tenants** on gnexis's
  7.6 GB box — *"a limit gnexis is hitting today, not a theoretical one."*
- Admission is a single `redis.eval` (`ADMIT_LUA`) so the existence check, budget sum, and write
  are atomic — otherwise two instances both admit into the last slot.
- **Liveness is a client heartbeat**, not a server signal. coolwsd emits no unload or idle event,
  and a reaper keyed on server-visible events would free a slot while the tab is still open —
  whereupon the next interaction makes coolwsd reload the document and re-spike. The mounted
  iframe posts `/heartbeat`; a broker is reclaimed only after missing beats for
  `OFFICE_BROKER_STALE_MS` (120 s). An open-idle tab holds budget on purpose.

**The target to design against, from #617 §2: roughly 100–200 documents on the same box, at about
8–15 MB of server memory per connection — a 15–20× improvement.**

### D25. What Collabora does well

- **Format breadth.** `.xlsx/.xls/.ods`, `.docx/.doc/.odt`, `.pptx/.ppt/.odp`, and PDF. A
  sheets-only replacement still leaves documents and slides needing an engine.
- **Password-protected / encrypted OOXML.** officecli cannot decrypt these; LibreOffice can. This
  is the *only* decryption path Papan has (`features/agent/tools/edit-office.ts:37`).
- **True concurrent co-editing** inside a single broker, for free.
- **Fidelity on the hard cases** — pivot tables, charts, conditional formatting — because
  LibreOffice owns the file format end to end.
- Export to PDF, print, and the whole `.uno:` command surface.
- The custom build's view-state preservation across an in-place reload.

---

## Section E — Embedding the new editor

### E26. iframe or React component

**A React component**, for reasons specific to Papan:

- The desktop shell **keeps every deck mounted and hides it with `display: none`**. It does not
  remount. A `useEffect(…, [])` fetch therefore runs once, ever — correct-looking stale figures
  with no error. There is a dedicated signal: `DeckVisibility` / `useRefreshWhenShown`
  (`shared/core-ui/ui/DeckVisibility.tsx`), driven from the same expression as the `display`
  style; it is a counter, never fires on mount, and is inert with no provider (mobile mounts real
  routes). An iframe would pay a full reload on every tab switch.
- Editors already register as lazy React components. The exact shape, from
  `features/collab/client/editors/sheets-registration.ts`:

  ```ts
  registerEditor({
    id: 'csv-editor',
    extensions: ['csv', 'tsv'],
    name: 'Spreadsheet Editor',
    component: LazySpreadsheetEditor,
  })
  ```
- Auth: same-origin means the session cookie rides along with no token mint. The WOPI token exists
  *because* of the iframe.
- Theming and i18n become free (E27).
- The SPA ships `frame-ancestors 'none'` (I47) — it is never legitimately framed.

The cost is bundle weight; the main bundle is already around 5.3 MB. Lazy-load aggressively.

**Persisted-contract gotcha:** `settings.preferredEditors[tab.type]` stores an **editor id**
(`features/workspace/ui/TabContent.tsx:396`). A stranded id falls back silently. Anything
displacing `collabora-*` must alias the old ids — #617 §5.H makes the same point for the
OnlyOffice rename.

### E27. Theming and i18n

**Theming.** Three themes: `dark`, `dim`, `light`. CSS variables live in `apps/web/src/index.css`
under `.theme-*`; `<ThemedArea area="drive|workspace|chat">` applies the class; use the `themed-*`
utility classes. Read state via `useTheme()` / `getThemeClass()`
(`shared/core-ui/ui/ThemeProvider.tsx:122`, `:150`). `theme.syncAll` makes every area follow
`workspace`.

**Anything rendered outside `ThemedArea` — modals, toasts, portals — has no CSS variables.** Apply
`getThemeClass(settings.theme.workspace)` yourself on the content element, and **not** on the
backdrop, which sets a solid background. An editor in the workspace panel should drive its own
tokens from `settings.theme.workspace`.

**i18n.** `react-i18next`. Languages are **`en`, `zh-CN`, `zh-TW`, `ms`** — four, not eleven.
Namespaces `common`, `files`, `core-ui`; resources under `shared/i18n/src/resources/{lang}/`.
Nested keys mirror component structure; `{{var}}` for interpolation. Every new string goes into
**all four** files.

Three ways a locale edit fails silently, two of which only `shared/i18n`'s own suite catches — and
that suite is **not run by package-scoped test commands**. Run `vitest run shared/i18n` after any
locale edit.

- **A locale entry wins over an inline `defaultValue`** — editing the component is a no-op for any
  key already present in `en/*.json`.
- **An orphaned key is invisible** (`promos.subtitle` beside the live `promo.subtitle`). Grep the
  source for the key after any rename.
- **A half-declared plural** (`foo` plus `foo_other`, no `foo_one`) renders the wrong branch.

Note also that i18n is browser-only: `NOTIFICATION_REGISTRY` and all email templates render
English by design, and fixing that for one type is explicitly not wanted.

### E28. Routing

`/t/:tenantId/workspace/:workspaceId?open=<fileId>`; personal tenants use the `/~` prefix instead
of `/t/<id>`. See `features/workspace/ui/WorkspaceView.tsx:375` — `searchParams.get('open')`,
deleted from the query string once consumed.

**There is no per-document route.** Documents are tabs inside a workspace, not pages.

Route patterns must be deep enough: one segment short does not 404, it falls through to `*` and
redirects to `/~/chat`. `billing-route-depth.test.ts` pins that for the billing deck; the trap is
general.

### E29. Existing UI shells

- **Workspace**: a three-panel layout — explorer / editor / chat — with drag-resize, rubber-band
  resistance past the minimum, and snap-to-collapse with hysteresis
  (`features/workspace/ui/WorkspaceView.tsx`). The editor is the middle panel.
- **Tab bar** above it; `TabContent.tsx` dispatches by editor id.
- **Terminology, which is enforced:** **Taskbar** is app-level nav (logo, drive/workspace nav,
  bell, avatar); **Activity bar** is the workspace-level VS Code-style UI. Never "top nav" or
  "sidebar", and never swap the two.
- Toolbar with the Wifi / WifiOff connectivity icon, `ConflictBanner`, share button, breadcrumbs.
- Console primitives (`Modal`, `ActionDisclosure`, `DirtyBar`) live in `@papan/core-ui` because
  `features/*` packages may not import each other.

**Import rule:** package aliases only (`@papan/core-ui/ui`, `@papan/i18n`, `@papan/files/ui`),
never relative paths across packages. `shared/*` never depends on `features/*`; `features/*` may
depend on `shared/*` and on other `features/*`.

---

## Section F — Collaboration and Yjs

### F30 / F31. Yjs today — the largest surprise in this document

**Papan has a full custom Yjs server, and it already has an xlsx persistence plugin.**

`features/collab/server/yjs-handler.ts` is **3788 lines**. It uses a raw `ws` `WebSocketServer` —
not y-websocket, not Hocuspocus — with a custom message protocol layered on y-protocols sync:

```ts
const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_SAVE = 2               // explicit save request from client
const MSG_ROOM_EPOCH = 3         // room identity — clients detect stale Y.Doc state
const MSG_DIRTY = 4              // server → client: dirty state broadcast
const MSG_DISCARD = 5            // client → server: discard unsaved, reset room from file
const MSG_BULK_UPDATE_START = 6  // server → client: suppress observers
const MSG_BULK_UPDATE_END = 7    // server → client: rebuild UI from Y.Doc
const MSG_CONFLICT = 8           // server → client: disk changed while room is dirty
const MSG_FORCE_SAVE = 10        // client → server: overwrite disk, bypass hash check
const MSG_WB_ADD_SHEET = 11
const MSG_WB_REMOVE_SHEET = 12
const MSG_WB_RESPONSE = 13
```

**Authentication** is in-handler (`yjs-handler.ts:9`): `getAuth`, API-key hashing, membership
lookups, `canRead` / `canWrite`, `parseMountFileId` / `createMountResolver` for cross-tenant
mounts, and share-link resolution. Frames sent before `verifyWsAuth()` resolves are buffered and
replayed — do not roll a separate mechanism.

**Persistence** goes through a plugin registry
(`features/collab/server/editor-registry.ts`):

```ts
export interface EditorPersistencePlugin {
  /** File extensions this plugin handles (lowercase, no dot) */
  extensions: string[]
  /** Load file content into a fresh Y.Doc */
  loadIntoDoc(doc: Y.Doc, content: Buffer, ctx?: PersistenceContext): void | Promise<void>
  /** Extract file content from Y.Doc for saving to disk */
  extractContent(doc: Y.Doc, ctx?: PersistenceContext): Buffer | null | Promise<Buffer | null>
  /** Extract editor-specific metadata for .editors/ persistence */
  extractMetadata(doc: Y.Doc, existing: EditorMetadata | null): EditorMetadata | null
  /** Restore metadata into Y.Doc on load */
  initFromMetadata(doc: Y.Doc, meta: EditorMetadata): void
  /** Reset a live room's Y.Doc to new content (for version restore) */
  resetDoc(doc: Y.Doc, newContent: Buffer, ctx?: PersistenceContext): void | Promise<void>
  /** Detect if a Y.Doc belongs to this editor type (rooms without file context) */
  detectDoc(doc: Y.Doc): boolean
}
```

Registered plugins: `csv` / `tsv` (`plugins/csv-plugin.ts:350`); `md txt html htm json pmeta ''`
(`plugins/text-plugin.ts:62`); and **`xlsx` / `xls`** (`plugins/xlsx-plugin.ts:1749`, a
1800-line module).

Rooms live in memory with debounced crash-recovery writes to Postgres
(`SAVE_DEBOUNCE_MS = 2000`), a 60 s warm eviction window, cross-instance fan-out through
`collabSync` over Redis, and editor metadata persisted to the `.pmeta` sidecar.

The Y.Doc sheet model already exists (`features/collab/server/yjs-sheet-model.ts:1`):

```
Y.Doc root:
  Y.Map('workbook')     — sheetOrder: string[], activeSheet: string
  Y.Map('sheets')       — container for per-sheet Y.Maps
    '{sheetId}' → Y.Map — per-sheet data
      'name'       → string
      'cells'      → Y.Map ("{r}:{c}" → string)
      'meta'       → Y.Map (rows, cols, colNames)
      'styles'     → Y.Map ("{r}:{c}", "__col:{n}", "__row:{n}", "h:{c}")
      'merges'     → Y.Map (idx → "startR:startC-endR:endC")
      'formulas'   → Y.Map ("{r}:{c}" → formula string)
      'drawings'   → Y.Map (drawingId → JSON drawing descriptor)
      'cellImages' → Y.Map ("{r}:{c}" → { p: document snapshot with inline drawings })
      'hyperlinks' → Y.Map ("{r}:{c}" → { id, row, col, payload, display })
      'notes'      → Y.Map ("{r}:{c}" → { id, row, col, note, width, height })
      'charts'     → Y.Map (chartId → JSON chart descriptor)
```

Alongside it: `formula-engine.ts`, `workbook-group-persistence.ts` (linked multi-file sheets),
and chart / style / conditional-formatting mapping modules.

### F32. Awareness and presence

Real and cross-instance. `room.awarenessStates: Map<WebSocket, Uint8Array>`
(`yjs-handler.ts:160`), broadcast to local clients and published to other instances via
`collabSync.publishAwareness(room.syncKey, update)` (`:1380`); existing states are replayed to a
joining client (`:2264`). Join this rather than building a second presence system.

### F33. How Yjs and Collabora coexist

**They are disjoint by extension, and only on the client.** Server-side both exist for xlsx.
Client-side:

```ts
// features/collab/client/editors/sheets-registration.ts
// CSV/TSV: Univer-based spreadsheet editor (view/edit toggle). Binary office
// formats (xlsx/xls/ods/...) are handled by Collabora — Univer is intentionally
// NOT registered for them.
registerEditor({ id: 'csv-editor', extensions: ['csv', 'tsv'], ... })
```

```ts
// features/collab/client/editors/office-registration.ts
/**
 * Office editor registration.
 * Collabora is the sole office editor (OnlyOffice removed 2026-06-10).
 * The WOPI backend (features/collab/server/wopi-*.ts) is provider-agnostic.
 */
import('./collabora-registration.js')
```

So the **xlsx Yjs plugin is live only as a stateless preview path**
(`plugins/xlsx-plugin.ts:1786`): parse the xlsx into a temporary Y.Doc, embed images as data
URLs, return `Y.encodeStateAsUpdate` as base64, and let the client render it with read-only
Univer. The comment is explicit — *"No rooms, no WebSocket, no persistence — fully stateless."*
The full edit machinery (`loadIntoDoc` / `extractContent` / `resetDoc` / `detectDoc`) is
registered, but no editing client for xlsx was ever wired.

**This matters more than anything else in this document for phase 06.** There is a mothballed Yjs
xlsx edit path — sheet model, formula engine, charts, styles, merges, awareness, conflict, the
save/discard protocol, `.pmeta` metadata — that a browser-rendering xlsx editor can plug into.
Whether its *fidelity* is adequate is a separate question, and one where GenOffice Sheets'
patch-only-`sheet1.xml` approach is deliberately different from a cell-model round trip. But the
**collaboration transport and persistence contract are already built.**

### F34. Expectations for a spreadsheet specifically

Live multi-user cell editing, matching the CSV editor's behaviour: awareness cursors, per-cell
Yjs merges, server-persisted dirty state, explicit save versus draft, discard, and a conflict
banner on external change. Not locking. The message ids and vocabulary are already fixed —
conform to `MSG_*` rather than introducing a parallel protocol.

---

## Section G — The AI agent

### G35. Where it lives

`features/agent` — `core/`, `api/routes/`, `server/`, `tools/` — plus
`apps/worker/src/processors/agent.ts`. Turns execute in the **worker**, not the API; `scripts.run`
execution moved off the API in #563.

Tools are Effect-based: `Tool.defineEffect(name, { ... })` with zod schemas
(`features/agent/tools/`). Multi-provider. `MODEL_CATALOG` (`shared/types/src/models.ts`) is
browser-safe data; `features/agent/core/providers.ts` is the metering authority for provider cost
and the default resale card, overridable per scope and currency by `model_pricing`.

### G36 / G37. How it reads and writes documents

**Through the VFS, via a bind-mounted real tree inside a gVisor sandbox container.** Not through
Collabora's WOPI layer.

Two office tools:

- **`office_tool`** (officecli) — plain `.xlsx` / `.docx` / `.pptx`. Dependency-aware and faster.
  `features/agent/tools/edit-office-cli.ts`.
- **`libre_office_tool`** — legacy MS (`.xls` / `.doc` / `.ppt`), ODF
  (`.ods` / `.odt` / `.odp`), **and password-protected / encrypted OOXML**. Python plus the
  LibreOffice UNO API, executed inside the Collabora container.
  `features/agent/tools/edit-office.ts`.

The UNO surface is full-fidelity, from that tool's own description:

```python
doc = load_doc("/papan/report.xlsx")
sheet = doc.Sheets.getByIndex(0)              # First sheet (0-based)
sheet.getCellByPosition(0, 0).setString("Name")    # A1 (col, row — 0-based)
sheet.getCellByPosition(1, 0).setValue(42)          # B1
sheet.getCellByPosition(2, 0).setFormula("=SUM(B:B)")
save_doc(doc, "/papan/report.xlsx")
```

> Preserves ALL features (pivot tables, charts, shared strings, formulas, formatting).

**Dependency worth flagging:** `libre_office_tool`'s soffice/pyuno base image is
`FROM papan/collabora:custom`. #617 §5.I: *"repackage if the Collabora image is retired (legacy +
password-protected docs only)."* Retiring Collabora without repackaging removes Papan's only
decryption path.

"Full access over the spreadsheet" means the whole list: read and answer questions about data,
edit cells, write formulas, create and delete sheets, build charts, apply formatting, handle
pivots.

The live-reflection chain is the fragile part, and #617 §5.C calls it *"the load-bearing
dependency"* of both the agent live preview and the AI conflict resolver:

```
agent office edit → worker publishCollabSync → API oo-conflict broadcast
                  → realtime → editor reload
```

with the rule that **`sheetsChanged` forces a FULL remount and everything else is a soft reload**
(structural versus content, computed worker-side). A soft-only reload leaves stale sheet tabs.

There is also an agent-edit **lease** in Redis (`agentEditLeaseKey(tenantId)`,
`shared/storage/src/index.ts:100`, #582): the worker refreshes it around every agent sandbox
write and the API `FileWatcher` skips "External edit" versioning while it is live. Without it one
bash loop minted nine spurious versions.

### G38. Existing tool schema

Yes — conform to it. `Tool.defineEffect` with a zod input schema, a `description` the model reads,
`systemPrompt` fragments, and optional `Skill` gating (a tool can reject-then-inject a skill
document and ask the model to retry — `libre_office_tool` does exactly that, and there is a
comment explaining that hiding the tool entirely made the model flail in bash instead).
`features/agent/tools/edit-office.ts:36` is the reference shape.

### G39. Whose credentials the agent runs with

**On behalf of the signed-in user, through the same permission checks.** Writes stamp a real
`VersionActor`, and the sandbox mounts that tenant's tree.

Three complications:

- **App turns** (PDApp, Mode B) run as a service **app principal** and always follow the app's own
  payer premise (owner or user), never the platform's.
- **Platform-admin support seats** stamp `payer_tenant_id` so the platform pays while the work
  runs inside the customer's tenant. The rule in the design doc is blunt, because this got the
  wrong wallet debited four separate times: *"STAMPING IS BOOKKEEPING; THE DRAW IS THE MONEY."*
- **Sessions are pinned to a wallet** (`session.payer_tenant_id`, SQLite migration 0007); sending
  on a mismatch is refused with 409 `SESSION_WALLET_MISMATCH` on all three send paths.

---

## Section H — Deployment and scale

### H40. Backend instances and affinity

**Two API instances by default** — `papan-api-0` on 3001 and `papan-api-1` on 3002, behind nginx
(`ecosystem.config.cjs`) — plus one worker.

They exist **for zero-downtime rolling restart, not throughput.** A host opts into a single
instance with `PAPAN_SINGLE_API=1`; gnexis measured api-1 at 809 MB across 29 restarts and
concluded it was pure cost on a churning small box.

**There is no session affinity and no sticky routing.** Any request can reach either instance,
and the codebase treats that as an invariant to satisfy rather than a problem to route around:
broker admission is a single Lua eval precisely because two instances could otherwise both admit
into the last slot, and #617 §5.G requires *"any Redis session/dirty/discard state stays atomic
across instances."*

### H41. Shared cache and message bus

**Redis is the shared substrate** (`redis://localhost:6379`). It carries WOPI tokens, session
dirty and discard state, draft pointers, broker admission (`office:bkr:*`, `office:brokers`,
`office:bkrefs:*`), Yjs cross-instance sync and awareness fan-out, BullMQ queues, and leader
election — `FileWatcher` runs on exactly one instance via `onAcquire` / `onRelease`
(`apps/api/src/index.ts:1593`), which is the local precedent for "exactly one instance owns this".

The three Redis connections are reported separately in telemetry: `redisReady: 1` beside
`redisSubReady: 0` means file events are dead behind a healthy-looking flag.

**And there is already a specified mechanism for exactly the pinning problem: issue #603, the
document-id shard router.** #617 §4 lists it under Keep:

> **The document-id shard router (#603)** — engine-agnostic and needed for OnlyOffice multi-node
> too, but **deferred**: OnlyOffice's higher single-box ceiling pushes the multi-box need far out.

An architecture that pins an open workbook to a specific engine process revives that need. Find
#603 before designing a second router.

### H42. Runtime

**Node, ESM (`"type": "module"`), `@hono/node-server` ^1.13, hono ^4.12.8.** Built with esbuild
to `dist/index.mjs` and run under **PM2** on a plain Hetzner VPS. No edge, no serverless. A Bun
worktree exists but is experimental and not in the main tree.

**Spawning child processes is routine and is not a constraint.** Docker containers via
`ContainerPool`, LibreOffice/soffice, officecli, Python. One caveat: **on servers gVisor is
mandatory and fail-closed** — `AGENT_SANDBOX_RUNTIME: 'runsc'`, with no silent runc fallback if
`runsc` is missing. Local dev uses runc.

A native Rust child process is therefore fine. The open question is whether it runs bare on the
host or inside the sandbox: everything else executable in Papan runs jailed under gVisor, and a
bare `spawn()` of a binary that parses untrusted `.xlsx` will attract review. Profile under
`runsc` before committing to either.

Operational note: `docker network create --driver bridge papan-sandbox-net` is required once per
machine (the worker also self-heals it).

### H43. Memory limits

From `ecosystem.config.cjs`, with the heap caps pinned by a test:

- **API: `--max-old-space-size=768`**, `max_memory_restart` 1 GB. The old-space cap exists because
  a spike can blow past the restart cap before PM2's sampler fires, and the kernel OOM killer then
  takes the whole pm2 unit down on a swap-exhausted box (#455/#456/#457).
- **Worker: heap cap 1408.**
- `MALLOC_ARENA_MAX: '2'` on both — glibc arena fragmentation was ratcheting `RssAnon` toward the
  cap. It must be a real PM2 env var; node's `--env-file` loads too late for libc.
- `DB_POOL_MAX: '12'` per process. Postgres runs `max_connections=100`, and exhausting it makes PG
  *refuse* connections — not an OOM, so nothing restarts to clear it.
- Collabora container `mem_limit` 2 GB, office budget 1200 MB.
- Boxes: gnexis 7.6 GB, golink 8 GB. Swap, infra memory caps, and boot/OOM drop-ins are baseline
  governance (`docker-compose.governance.yml`; `assert_governed()` fails the deploy on drift).

**A parsed-workbook-per-process budget is genuinely tight here.** 768 MB of API heap on a 7.6 GB
box already shared with Postgres, Redis, the agent worker, and sandbox containers. Whatever the
resident model, it needs the same kind of admission accounting `office-brokers.ts` performs — and
#617 §5.G explicitly says *"503-busy / idle-release UX: decide, don't just delete."*

### H44. Observability

Every long-lived process emits a **`vitals` line per beat (30 s tick)** and the API a **`req` line
per request**. Package `@papan/observability`, with wrappers `api-vitals.ts` and
`worker-vitals.ts`. Reference: `docs/OPERATIONAL_METRICS.md`.

**A field without a doc entry fails a test, in both directions.** Adding a metric means adding a
doc entry.

Rules that bite:

- **A missing field means "not measurable" and is never `0`.** `dbPoolIdle: 0` is saturation;
  `qAgentOldestSec: 0` is a real state. An API instance emitting no `sandbox*` fields is now
  *correct* (`sandboxFields()` returns `{}` when `pools === 0`).
- **`extra` is synchronous and must stay so.** Anything needing a round trip goes in `refresh`,
  which rides the next beat; a refresh still running is skipped, and a failed one drops its fields
  rather than repeating stale values. A hung Redis must not silence the heartbeat.
- **A gauge and a window are not interchangeable** (`dbPoolWaiting` versus
  `dbWaitAvgMs` / `dbWaitMaxMs`). Lag, latency, and acquisition windows **reset every beat** — a
  second caller steals the samples.
- **The access log logs `c.req.routePath`, never the raw URL.** Share tokens and query-string
  emails were going to stdout. Anything added to that line follows the same rule — document ids in
  a path would be logged if this is broken.
- Durations are `...Ms` everywhere. Percentiles are per-window and do not average across ticks.
- Nothing here is a billing row; `resource_usage` quantities sum, so a non-billable feature there
  becomes a permanent $0 line on every spend screen.

---

## Section I — Security and compliance

### I45. Password-protected workbooks

**There is no password prompt and no per-file password store today.** The only decryption is
`libre_office_tool` passing `load_doc(password=...)` inside an agent-authored Python script in a
sandbox — the model supplies the password. There is no user-facing flow.

**Where one belongs: `@papan/keybook`.** That is the secrets vault, and it is properly built
(`shared/auth/src/keybook-crypto.ts:1`):

```
K_tenant = HKDF(masterKey_v{m}, salt = tenantId, info = 'papan-keybook-v{tenantKeyVersion}')

AES-256-GCM. Ciphertext base64 (ct||tag); IV base64, 12 bytes. Both the master-key
version and the tenant-key version are stored per row.

Two orthogonal rotation knobs:
  - tenant key rotation: bump tenantKeyVersion, re-encrypt that tenant's rows
  - master key rotation: deploy a new master version; future writes adopt it,
    old blobs decrypt under their stored masterKeyVersion until a backfill runs

Audience: API + worker. Browser never has a master key.
```

Master keys come from a `MasterKeyProvider` (`shared/auth/src/master-key-provider.ts`) —
**env-backed today, KMS-backed later**. The package provides collections, entries, per-entry
permissions, a kill switch, and `resolveCredential`.

Recommendation: prompt the user by default, and offer keybook-backed storage as opt-in. Do not
introduce a third secret store.

### I46. Compliance constraints

Nothing in code mandates residency, retention, or customer-managed keys. The honest position:

- one deployment per client (whitelabel), so residency is a per-host fact
- no encryption at rest for file content (A6)
- the agent sandbox already bind-mounts plaintext
- master keys are env-backed rather than KMS-backed — the real gap

A server-side scratch snapshot is consistent with all of this. The one deployment constraint that
does apply is the `/tmp`-is-RAM issue in A6.

### I47. CSP on the Papan frontend

`apps/web/public/_headers` (Cloudflare Pages):

```
/*
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
```

That is the whole policy for the app. **`frame-ancestors` only** — no `script-src`, no
`worker-src`, no `default-src`. Canvas workers using `blob:` are not blocked.

Two consequences:

- **The SPA can never be framed**, which argues against an iframe embed rather than for it.
- `/__accounts/embed` and `/__accounts/embed.html` unset the inherited deny and set
  `frame-ancestors https:` — exact paths, deliberately not a glob, so a future sibling cannot
  silently inherit relaxed framing.

CF Pages **merges** matching rules and comma-joins a header set twice; there is no override, only
`! Header` to unset an inherited one.

Strict per-response CSPs do exist elsewhere — `features/files/api/preview.ts` (`buildPreviewCsp`)
and `preview-serve.ts` for user-content previews, plus a `Content-Security-Policy: sandbox`
opaque-origin path for app hosting. Those are a different surface and should not be confused with
the app shell.

### I48. Upload scanning

Yes, pluggable. `features/files/server/scanner/` with `clamav.ts` and `noop.ts` implementations:

```ts
export interface Scanner {
  readonly name: string
  isAvailable(): Promise<boolean>
  scanBuffer(buffer: Buffer, options?: ScanOptions): Promise<ScanResult>
  scanFile(filePath: string, options?: ScanOptions): Promise<ScanResult>
  scanStream(stream: NodeJS.ReadableStream, options?: ScanOptions): Promise<ScanResult>
}

export interface AggregateScanner extends Scanner {
  addScanner(scanner: Scanner): void
  removeScanner(name: string): void
  listScanners(): string[]
}
```

A file is clean only if **all** registered scanners report clean.

Call sites: `POST /api/files/upload` (`features/files/api/routes.ts:3262`) and the tus path
(`apps/api/src/upload/tus.ts:442`). An infected file goes to `{basePath}/quarantine/{hash}` with
`listQuarantine` / `restoreFromQuarantine` / `deleteQuarantined` on `TreeStorage`; the client sees
a `MalwareDetectedError`. There is a rescan job at `features/files/server/jobs/rescan.ts`.

**Editor saves are not scanned today** — WOPI PutFile goes straight to `writeById`. That is
defensible (the bytes originate from an editor operating on already-scanned content) and it is the
existing precedent. Any divergence should be deliberate and stated.

---

## Section J

### J49. What I wish someone had said first

1. **#617 exists.** This would be the third office engine. OnlyOffice was shipped and removed on
   2026-06-10 (`635722b5d`) and is now being revived.
   `git show 635722b5d^:features/collab/ONLYOFFICE.md` is a 411-line design document covering
   exactly this problem — doc-key strategy, save model, dirty tracking, conflict, connection
   management. Read it before writing code.
2. **The Yjs xlsx plugin already exists** and is wired only as a stateless preview. See F33.
3. **The hard parts of this integration are not storage.** They are the `.shared` / `.chain`
   compound-id re-keying (#405), the reload chain, and the three-way save / draft / version split.
   #617 §5 is the list, and every item on it is a bug someone has already paid for.
4. **Every Collabora fix is a scar**: #405, #455, #542, #544, #565, #572, #582, #586, #591. #617's
   meta-rule is that none of them are assumed to port.
5. **Several guards are tests that grep source.** `no-raw-display-rate-reads`,
   `no-second-seat-predicate`, `single-brand-mechanism`, `notification-action-reachable` and
   others run over comment-stripped source in JS, and **any grep-shaped guard in this repo needs
   `--untracked`** — git grep skips new files otherwise. A new "one implementation" rule needs its
   own guard.
6. **Never hardcode the brand, the currency, or a price.** Papan deploys one instance per client,
   each with its own brand, Stripe account and currency. One mechanism only: `@papan/brand` with
   `BRAND_KEY`. `BRAND_NAME` / `brandName()` / `brandSlug()` are gone (#428). The worst case is a
   string that prints on a Stripe invoice.
7. **`pnpm build` before any push to a deploy branch** — the server build can fail silently and
   keep the old bundle. Every deploy to any remote needs explicit approval, each time; prior
   approval in the same conversation does not carry.
8. **Do not `cat` or open secret-bearing files**: `scripts/hosts/<host>/*`, any `.env.local` or
   `.env.production`, the server's `/app/.env.production` and `docker-compose.override.yml`.
   `grep <pattern>` is `cat` when the matching line is the one you want; `docker inspect`'s
   `Config.Env` and `git remote -v` both print secrets. If a secret reaches a transcript, say so
   immediately — it cannot be redacted afterwards.
9. **Run `nginx -t` and `systemctl reload nginx` as separate statements, never joined by `&&`** —
   under `set -e` the left side of `&&` is exempt from errexit. nginx serves from memory, so a
   broken file detonates at the *next* restart, days later; a nightly apt upgrade took golink down
   for about 4.5 hours that way. The diagnostic signature is HTTP **521** on origin-proxied paths
   (`/api/*`, `auth-*`) while the SPA root still returns 200 from CF Pages and `/health` stays
   green — so always probe an origin-proxied path.

### J50. Reading list, in order

1. `docs/plans/2026-09-11_OFFICE_ENGINE_MIGRATION.md` — 162 lines. The decision in flight, and the
   checklist any replacement must satisfy.
2. `git show 635722b5d^:features/collab/ONLYOFFICE.md` — 411 lines. The prior client-rendered
   engine integration.
3. `docs/editor/COLLABORA.md` — 1276 lines. What exists today, end to end.
4. `features/collab/server/wopi-routes.ts` — 887 lines. Read the comments, not just the code; they
   are incident post-mortems.
5. `CLAUDE.md` — the project rulebook. Dense, and every line is a scar.
6. `docs/MINI_APP_SECURITY.md` and `docs/plans/2026-05-15_SHARE_PRIMITIVE.md` — the sharing model
   the permission checks sit inside.
7. `docs/OPERATIONAL_METRICS.md` — before emitting a single metric.

There is also a knowledge graph at `graphify-out/`: `graphify query "<question>"`,
`graphify path "<A>" "<B>"`, `graphify explain "<concept>"`, and `graphify-out/wiki/index.md` for
navigation.

---

## Assumptions in the original brief that do not hold

**1. "Papan has an internal SDK for the Collabora↔VFS path."**
It does not. There is `@papan/storage` (the VFS) and there are WOPI routes, and nothing between
them: `wopi-routes.ts` calls `getStorage(tenantId).read()` / `.writeById()` directly. There is no
adapter to conform to, which means the seam is still open to design.

**2. "Save As means creating a new document and there is no port for it."**
`SaveAsDialog` accepts a **`customSave` callback** that overrides the server path entirely
(`features/workspace/ui/SaveAsDialog.tsx:49`). The 501 is a small fix, not a new port. The PDF
exporter already uses this hook.

**3. "If the VFS cannot compare-and-swap, the alternative is a lock or last-write-wins."**
It *can* CAS — three-valued, raising `WriteConflictError` — but only on
`write(parentId, name, …)`, and **the office path uses `writeById`, which has no CAS at all**. So
today's behaviour is last-write-wins by explicit decision, and there is no lock layer to fall back
on (there is no WOPI Lock/Unlock — #617 §5.F). A 409 design is an improvement rather than a port.
But Papan wants the conflict presented as a **banner** with keep-mine / overwrite /
show-saved-version, not a native editor dialog — a raw 409 to the editor is exactly what was
removed.

**4. "Collabora saturates around 10 concurrent clients."**
It saturates at roughly **7 concurrent *documents* across all tenants**, and the unit is the
*broker*, not the client. Co-editors of the same document cost approximately zero additional RAM.
"10 clients" could be 2 documents (comfortable) or 10 (already over budget). Size a process pool
in **resident workbooks**, not sessions. The target from #617 is ~100–200 documents at ~8–15 MB
per connection.

**5. "Yjs is for other document types; collaboration is phase 06 work."**
There is a 3788-line custom Yjs server with a **registered `xlsx` / `xls` persistence plugin**, a
complete Y.Doc sheet model (cells, formulas, styles, merges, charts, notes, hyperlinks,
drawings), a formula engine, cross-instance awareness, and a save / dirty / discard / conflict
message protocol. The xlsx *edit client* was simply never wired; the plugin is live only as a
stateless read-only preview. Phase 06 may be mostly wiring.

**6. "A spreadsheet is opened at a document URL."**
There is no per-document route. Documents are **tabs** inside
`/t/:tenant/workspace/:workspaceId?open=<fileId>`, and the desktop shell **keeps every deck
mounted and hides it with `display: none`** — mount-time effects run once, ever. Use
`DeckVisibility` / `useRefreshWhenShown`.

**7. "`worker-src blob:` is the CSP directive most likely to block the editor."**
The SPA ships `frame-ancestors 'none'` and nothing else — no `script-src`, no `worker-src`.
Canvas workers are fine. The real CSP constraint is the opposite one: **the SPA can never be
framed**, which argues against the iframe option rather than for it.

**8. "`identify(request) → { userId, tenantId, documentId, canEdit }` is sufficient."**
Four gaps. (a) Permission must be **re-checked on every read and every save**, not only at mint —
a revoked grant must fail on the next call, fail-closed. (b) `canEdit` is not a boolean: the
lattice is `owner | admin | readwrite | readcopy | hidden | none`, and `readcopy` / `hidden` are
distinct read states. (c) The caller may be a **share principal** with a synthetic id and no row
in `users`, so write attribution must use `actor.type = 'share'` or version history FK-joins and
breaks. (d) `documentId` may be a **compound mount id** `s_<mount>_<src>` with no row in the
requesting tenant, which must be re-keyed onto the source tenant.

**9. "Tenant is the right metering key."**
Mostly — but `tenant_id` alone disagrees with the 402 enforcement path. Every money read resolves
`COALESCE(payer_tenant_id, tenant_id)`. Separately, an **identity-only** tenant refuses writes
entirely, and that decision follows the tenant that *owns the resource*, never the actor's.

**10. "Bytes are in object storage; reads should use a signed-URL or CDN path."**
Storage is the local filesystem with content-addressed SHA-256 blobs plus a mirrored real tree.
The R2 backend exists and is not wired into `TreeStorage`. There is no CDN and no signed URL —
everything streams through Hono. **Which means a server-side snapshot can be a hardlink or a
direct read of `getRealPath(fileId)`, not an HTTP fetch.**

**11. "Autosave comes free because Collabora autosaves on a timer."**
Collabora is configured `autosave_duration_secs=0` and `always_save_on_exit=false`. There is no
periodic autosave; the **exit-save is the only automatic write**, which is why a failed draft
deliberately leaves the session dirty — clearing it would be a silent discard. Papan's disk-backed
draft store is the actual safety net, is provider-agnostic, and is explicitly kept through the
migration. **A draft is not a version** — a 30-second recovery copy must not enter version
history.

**12. "Multiple instances means sticky sessions are needed."**
There are two API instances, they exist for rolling restarts rather than throughput, there is **no
affinity**, and the codebase treats "any request can hit any instance" as an invariant satisfied
with atomic Redis (a Lua eval for admission; leader election for the file watcher). There is also
a specified-but-deferred **document-id shard router, #603** — engine-agnostic, parked because
OnlyOffice defers the multi-box need. Pinning an open workbook to an engine process revives it;
find that issue rather than designing a second one.
