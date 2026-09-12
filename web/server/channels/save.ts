import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { SaveEditsTransferStore } from '../../../apps/sheets/src/main/save-edits-transfer'
import {
  saveEditsChunkArraySchema,
  workbookSaveEditsAbortSchema,
  workbookSaveEditsBeginSchema,
  workbookSaveEditsChunkSchema,
  workbookSaveRequestSchema,
  type WorkbookSaveRequest,
} from '../../../apps/sheets/src/shared/desktop-api'
import { IPC_CHANNELS } from '../../../apps/sheets/src/shared/ipc-channels'
import { SheetsError, VersionConflictError } from '../errors'
import { exportIdentityKey } from '../exports'
import {
  CONFLICT_CHANNEL,
  conflictFor,
  type HostCallOptions,
  type WorkbookSaveExportResult,
} from '../../protocol'
import type { WorkbookSession } from '../sessions'
import type { ChannelContext, ChannelHandler, ChannelTable } from '../router-types'
import { writeWorkbookTo, type SaveMutation } from './save-plan'

/**
 * The save pipeline: journal in, part surgery through the sidecar, bytes out
 * through the StorageAdapter, version token bumped.
 *
 * Upstream's desktop version guards an in-place save by re-hashing the file
 * and refusing when it changed under the session. The web has a better tool
 * for the same job -- the storage version token the session recorded when it
 * opened -- and a better answer than an error string: a 409 carrying the
 * current version, so the client can rebase rather than only be told no.
 */

/**
 * Chunked edit uploads, shared by every session on this server.
 *
 * Upstream keeps one store per browser tab and can therefore treat a tab's
 * transfers as trusted. Here one store is shared, so every operation is keyed
 * by sessionId as well as transferId -- which upstream's store already
 * enforces internally (`transfer.sessionId !== request.sessionId` rejects), so
 * sharing it is safe rather than merely convenient.
 */
const transfers = new SaveEditsTransferStore()

/** Inline edits or a completed transfer, never both. */
function resolveTransferredEdits(request: WorkbookSaveRequest): WorkbookSaveRequest {
  if (request.editsTransferId === undefined) return request
  if (request.edits.length > 0) {
    throw new SheetsError('invalid_request', 'Save request mixes inline and transferred edits.')
  }
  return { ...request, edits: transfers.take(request.editsTransferId, request.sessionId) }
}

const saveWorkbookEdits: ChannelHandler = async (context) => {
  const request = resolveTransferredEdits(workbookSaveRequestSchema.parse(context.args[0]))
  const session = context.registry.require(request.sessionId, context.identity)

  if (!session.canEdit) {
    throw new SheetsError('forbidden', 'This workbook is open read-only.')
  }

  if (request.mode === 'save-as') return exportPatchedBytes(context, session, request)

  // The web equivalent of upstream's "the file changed on disk" guard. Same
  // intent, better outcome: the client is handed the version it lost to.
  //
  // `overwrite` is the conflict banner's own button, so it does not skip the
  // check -- it moves it. The save becomes a compare-and-set against what
  // storage holds *now*, which means a document that moves again between this
  // read and the write still conflicts. What the person approved was
  // overwriting the version they were shown, not whatever arrives next.
  const current = await context.storage.head(session.documentId)
  const overwrite = hostOptions(context).overwrite === true
  if (!overwrite && current.version !== session.openedFromVersion) {
    throw new VersionConflictError(current.version)
  }
  const expectedVersion = overwrite ? current.version : session.openedFromVersion

  const assembled = await assemble(context, session, request, current.name)
  const { mutation } = assembled
  const bytes = await readFile(assembled.path).finally(() => assembled.discard())

  // Only now does the document change. A failure above leaves storage
  // untouched and the session still usable.
  const saved = await context.storage.put(session.documentId, bytes, expectedVersion)

  // The sidecar session still streams the pre-save bytes. Upstream swaps it
  // for a fresh session over the saved file so later reads match what was
  // written; the same is true here, and skipping it would serve stale cells
  // for the rest of the session.
  const file = await context.registry.reopenAfterSave(session, saved, context.pool, context.locale)

  // Two tabs on one document is the conflict case the host cannot see: its
  // realtime layer learns about writes through *its* storage, and this write
  // went through ours. Telling the other sessions now is the difference
  // between a banner and a rejected save ten minutes later.
  //
  // Runs after the reopen so this session is already at the new version and is
  // therefore not among the stale ones.
  const stale = context.registry.staleSessions(session.documentId, saved.version)
  if (stale.length > 0) {
    context.push.send(session.documentId, CONFLICT_CHANNEL, conflictFor(saved.version, stale))
  }

  return { canceled: false, file, touchedEntries: mutation.touchedEntries }
}

/**
 * Part surgery into a scratch file.
 *
 * Shared by the two saves because they differ only in what happens to the
 * bytes afterwards: an in-place save uploads them and bumps the version, a
 * Save As hands them to the host. Both must run inside one sidecar session --
 * writeWorkbookTo issues a manifest read, entry extractions and the archive
 * assembly, and they all have to land on the process holding this session's
 * snapshot.
 *
 * The caller owns the result and must call `discard()`; a throw in here cleans
 * up on its own.
 */
async function assemble(
  context: ChannelContext,
  session: WorkbookSession,
  request: WorkbookSaveRequest,
  name: string,
): Promise<{ mutation: SaveMutation; path: string; workDir: string; discard(): void }> {
  const workDir = join(context.scratchDir, `save-${randomUUID()}`)
  const targetPath = join(workDir, name)
  const discard = () => void rm(workDir, { recursive: true, force: true }).catch(() => {})
  try {
    const mutation = await context.pool.withSession(request.sessionId, async (client) => {
      await mkdir(workDir, { recursive: true })
      return writeWorkbookTo(client, session, request, targetPath)
    })
    return { mutation, path: targetPath, workDir, discard }
  } catch (error) {
    discard()
    throw error
  }
}

/**
 * Save As: the patched bytes, without persisting them.
 *
 * Deliberately not a write. Save As means "put a copy somewhere else", and
 * where else is the host application's question -- Papan's picker already
 * takes a `customSave` callback, and its documents are tree nodes this package
 * has no port to create. So the answer is bytes and a suggested name, fetched
 * once from `GET /export/:token`.
 *
 * Three consequences, all of them the point:
 *
 *  - **No version guard.** Nothing is written to this document, so a
 *    concurrent save elsewhere cannot conflict with a copy.
 *  - **The session keeps its identity and its journal.** The renderer reads
 *    the `canceled: true` half of upstream's result -- which is accurate,
 *    since nothing was saved *here* -- and leaves the edits pending. That is
 *    upstream's own CSV-Save-As semantics, verbatim.
 *  - **The sidecar session is not reopened.** It still streams the stored
 *    bytes, which are still what storage holds.
 */
async function exportPatchedBytes(
  context: ChannelContext,
  session: WorkbookSession,
  request: WorkbookSaveRequest,
): Promise<WorkbookSaveExportResult> {
  const current = await context.storage.head(session.documentId)
  const assembled = await assemble(context, session, request, current.name)
  try {
    const slot = await context.exports.register({
      path: assembled.path,
      workDir: assembled.workDir,
      name: current.name,
      identityKey: exportIdentityKey(context.identity),
    })
    return { canceled: true, export: { ...slot, touchedEntries: assembled.mutation.touchedEntries } }
  } catch (error) {
    assembled.discard()
    throw error
  }
}

/**
 * The chunked transfer. Edits above SAVE_EDITS_INLINE_MAX arrive as ordered
 * JSON slices rather than one request, then the save references the transfer
 * id. Upstream's store does the accumulating, expiry and re-interning.
 */
const beginSaveEditsTransfer: ChannelHandler = async (context) => {
  const request = workbookSaveEditsBeginSchema.parse(context.args[0])
  requireEditableSession(context, request.sessionId)
  transfers.begin(request)
  return undefined
}

const sendSaveEditsChunk: ChannelHandler = async (context) => {
  const request = workbookSaveEditsChunkSchema.parse(context.args[0])
  requireEditableSession(context, request.sessionId)
  // The chunk arrives as a flat JSON string -- that is the point of the
  // transfer, since a live object graph crossing the boundary is what it
  // exists to avoid. The edits stay untrusted until they pass the cell-edit
  // schema, exactly as upstream treats them.
  transfers.addChunk({
    sessionId: request.sessionId,
    transferId: request.transferId,
    seq: request.seq,
    edits: saveEditsChunkArraySchema.parse(JSON.parse(request.editsJson)),
  })
  return undefined
}

// Best-effort cleanup from the renderer's failure paths; a no-op when the
// transfer was already consumed or has expired.
const abortSaveEditsTransfer: ChannelHandler = async (context) => {
  const request = workbookSaveEditsAbortSchema.parse(context.args[0])
  requireEditableSession(context, request.sessionId)
  transfers.discard(request.transferId, request.sessionId)
  return undefined
}

function requireEditableSession(context: ChannelContext, sessionId: string): void {
  const session = context.registry.require(sessionId, context.identity)
  if (!session.canEdit) throw new SheetsError('forbidden', 'This workbook is open read-only.')
}

export const saveChannels: ChannelTable = {
  [IPC_CHANNELS.saveWorkbook]: saveWorkbookEdits,
  [IPC_CHANNELS.saveEditsBegin]: beginSaveEditsTransfer,
  [IPC_CHANNELS.saveEditsChunk]: sendSaveEditsChunk,
  [IPC_CHANNELS.saveEditsAbort]: abortSaveEditsTransfer,
}

/** Exposed so the server can drop a departing session's queued upload. */
export function discardTransfersForSession(sessionId: string): void {
  transfers.discardSession(sessionId)
}

/**
 * The host's own options, which ride in `args[1]`.
 *
 * Upstream's preload sends exactly one argument per channel, so a second one
 * is unambiguously ours. That is what keeps upstream's `.strict()` request
 * schemas usable verbatim: a flag added to the request the renderer builds
 * would fail the renderer's own validation before it ever left the browser.
 */
function hostOptions(context: ChannelContext): HostCallOptions {
  const options = context.args[1]
  if (typeof options !== 'object' || options === null) return {}
  return options as HostCallOptions
}
