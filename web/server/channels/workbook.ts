import {
  IPC_CHANNELS,
} from '../../../apps/sheets/src/shared/ipc-channels'
import {
  workbookFileSchema,
  workbookRangeRequestSchema,
  workbookRangeResultSchema,
} from '../../../apps/sheets/src/shared/desktop-api'
import { SheetsError } from '../errors'
import type { ChannelHandler, ChannelTable } from '../router-types'

/**
 * open / read-range / close: the three channels the rest of the document
 * surface is built on.
 *
 * Validation uses upstream's own zod schemas on both sides of the sidecar --
 * the request the client sent and the result the sidecar returned. Upstream
 * validates the same way in sheets-main.ts, and reusing the schemas means a
 * tightened constraint arrives with the next rebase instead of being
 * reimplemented here and drifting.
 */

/**
 * The sidecar's open result, minus the two fields the caller supplies. Matches
 * sheets-main.ts's `sidecarOpenResultSchema`, which is not exported.
 */
const sidecarOpenResultSchema = workbookFileSchema.omit({ sha256: true, readOnly: true })

/**
 * `selectWorkbook` on the desktop shows a file dialog. On the web there is no
 * dialog and no choice to make: the document is whichever one this connection
 * is authorised for. The channel keeps its name so the renderer is unchanged.
 */
const selectWorkbook: ChannelHandler = async (context) => {
  const { identity, registry, pool, locale } = context
  const snapshot = await registry.prepareSnapshot(identity)

  try {
    const { sessionId, opened } = await pool.open(
      snapshot.snapshotPath,
      locale,
      undefined,
      (result) => sidecarOpenResultSchema.parse(result).sessionId,
      (result) => sidecarOpenResultSchema.parse(result),
    )

    registry.register({
      sessionId,
      documentId: identity.documentId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      snapshotPath: snapshot.snapshotPath,
      byteLength: snapshot.bytes.byteLength,
      sha256: snapshot.sha256,
      openedFromVersion: snapshot.version,
      sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
      canEdit: identity.canEdit,
      lastUsedAt: Date.now(),
      pendingEdits: 0,
    })

    return workbookFileSchema.parse({
      ...opened,
      name: snapshot.name,
      sha256: snapshot.sha256,
      fileBytes: snapshot.bytes.byteLength,
      // Read-only is an authorisation outcome here, not a filesystem one.
      readOnly: !identity.canEdit,
    })
  } catch (error) {
    // The snapshot outlives a failed open only as garbage.
    await snapshot.cleanup()
    throw error
  }
}

const readWorkbookRange: ChannelHandler = async (context) => {
  const request = workbookRangeRequestSchema.parse(context.args[0])
  context.registry.require(request.sessionId, context.identity)
  const result = await context.pool.withSession(request.sessionId, (client) =>
    client.readRange(request),
  )
  return workbookRangeResultSchema.parse(result)
}

const closeWorkbook: ChannelHandler = async (context) => {
  const sessionId = context.args[0]
  if (typeof sessionId !== 'string') {
    throw new SheetsError('invalid_request', 'closeWorkbook expects a session id.')
  }
  // Closing an already-closed session is not an error: a tab that reloads
  // during a close would otherwise surface a failure for something that
  // already happened.
  const known = context.registry.peek(sessionId)
  if (!known) return undefined
  context.registry.require(sessionId, context.identity)
  await context.registry.close(sessionId)
  return undefined
}

export const workbookChannels: ChannelTable = {
  [IPC_CHANNELS.selectWorkbook]: selectWorkbook,
  [IPC_CHANNELS.readWorkbookRange]: readWorkbookRange,
  [IPC_CHANNELS.closeWorkbook]: closeWorkbook,
}
