import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
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
import type { ChannelContext, ChannelHandler, ChannelTable } from '../router-types'
import { writeWorkbookTo } from './save-plan'

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

  // Save As means "create a different document", which needs a storage port
  // this package does not have. Refusing explicitly beats silently writing
  // over the document the user was trying to branch from.
  if (request.mode === 'save-as') {
    throw new SheetsError(
      'not_implemented',
      'Save As needs a document-create port; use the host application to copy the document.',
    )
  }

  // The web equivalent of upstream's "the file changed on disk" guard. Same
  // intent, better outcome: the client is handed the version it lost to.
  const current = await context.storage.head(session.documentId)
  if (current.version !== session.openedFromVersion) {
    throw new VersionConflictError(current.version)
  }

  const workDir = join(context.scratchDir, `save-${randomUUID()}`)
  const targetPath = join(workDir, current.name)
  const { mutation, bytes } = await context.pool
    .withSession(request.sessionId, async (client) => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(workDir, { recursive: true })
      // One sidecar, one save: writeWorkbookTo issues a manifest read, entry
      // extractions and the archive assembly, and they must all land on the
      // process holding this session's snapshot.
      const result = await writeWorkbookTo(client, session, request, targetPath)
      return { mutation: result, bytes: await readFile(targetPath) }
    })
    .finally(() => rm(workDir, { recursive: true, force: true }))

  // Only now does the document change. A failure above leaves storage
  // untouched and the session still usable.
  const saved = await context.storage.put(session.documentId, bytes, session.openedFromVersion)

  // The sidecar session still streams the pre-save bytes. Upstream swaps it
  // for a fresh session over the saved file so later reads match what was
  // written; the same is true here, and skipping it would serve stale cells
  // for the rest of the session.
  const file = await context.registry.reopenAfterSave(session, saved, context.pool, context.locale)

  return { canceled: false, file, touchedEntries: mutation.touchedEntries }
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
