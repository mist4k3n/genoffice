import {
  IPC_CHANNELS,
} from '../../../apps/sheets/src/shared/ipc-channels'
import {
  workbookFileSchema,
  workbookRangeRequestSchema,
  workbookRangeResultSchema,
} from '../../../apps/sheets/src/shared/desktop-api'
import { SheetsError } from '../errors'
import { canWrite } from '../ports'
import { DRAFT_RESTORED_KEY } from '../../protocol'
import { workbookDisplayPath } from '../workbook-handle'
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
 * `selectWorkbook` on the desktop shows a file dialog. On the web there is no
 * dialog and no choice to make: the document is whichever one this connection
 * is authorised for. The channel keeps its name so the renderer is unchanged.
 */
const selectWorkbook: ChannelHandler = async (context) => {
  const { identity, registry } = context
  // The registry decides whether this is a new workbook in the engine or
  // another viewer of one already open; the answer is invisible from here.
  const { session, opened, name, displayPath, fromDraft } = await registry.open(identity)

  const file = workbookFileSchema.parse({
    ...opened,
    // The client's own handle, not the sidecar's -- several clients share one
    // sidecar session, and a save swaps it underneath them.
    sessionId: session.sessionId,
    name,
    // A path-shaped handle, never the server's snapshot path. See
    // workbook-handle.ts for why it cannot be opaque.
    path: workbookDisplayPath(name, displayPath),
    sha256: session.sha256,
    fileBytes: session.byteLength,
    // Read-only is an authorisation outcome here, not a filesystem one.
    readOnly: !canWrite(identity.permission),
  })
  // Added after the parse, and only when true, so an ordinary open is
  // byte-identical to what it was. The host bridge strips it again before
  // the renderer sees the result -- see protocol.ts.
  return fromDraft ? { ...file, [DRAFT_RESTORED_KEY]: true } : file
}

const readWorkbookRange: ChannelHandler = async (context) => {
  const request = workbookRangeRequestSchema.parse(context.args[0])
  const session = context.registry.require(request.sessionId, context.identity)
  // The id the client holds is ours; the sidecar knows only its own, and a
  // save swaps which one that is. Substituting it here is what makes a shared
  // session invisible from the browser.
  const result = await context.pool.withSession(session.engineSessionId, (client) =>
    client.readRange({ ...request, sessionId: session.engineSessionId }),
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
