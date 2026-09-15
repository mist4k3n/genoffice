import { z } from 'zod'

import { readArchiveEntryText } from '../../../apps/sheets/src/gateway/xlsx-package-io'
import { parsePivotDefinition } from '../../../apps/sheets/src/gateway/xlsx-pivot'
import {
  workbookFormulaCellsRequestSchema,
  workbookFormulaCellsResultSchema,
  workbookMediaRequestSchema,
  workbookMediaResultSchema,
  workbookPivotDefinitionSchema,
  workbookPivotRequestSchema,
  workbookRecalcRequestSchema,
  workbookRecalcResultSchema,
} from '../../../apps/sheets/src/shared/desktop-api'
import { IPC_CHANNELS } from '../../../apps/sheets/src/shared/ipc-channels'
import { SheetsError } from '../errors'
import type { ChannelHandler, ChannelTable } from '../router-types'

/**
 * The read channels beyond a plain cell range: formulas, embedded media,
 * pivot definitions, and IronCalc recalculation.
 *
 * All four read from the session's **snapshot**, never the live document, for
 * the same reason the open does: what the renderer shows must come from one
 * consistent set of bytes even if someone else saves the document underneath.
 */

const readWorkbookFormulas: ChannelHandler = async (context) => {
  const request = workbookFormulaCellsRequestSchema.parse(context.args[0])
  const session = context.registry.require(request.sessionId, context.identity)
  const result = await context.pool.withSession(session.engineSessionId, (client) =>
    client.readFormulaCells({ ...request, sessionId: session.engineSessionId }),
  )
  return workbookFormulaCellsResultSchema.parse(result)
}

/**
 * Images and other embedded binaries, addressed by the visual id the open
 * result already handed the renderer. It never names a package path, so there
 * is no path for a caller to point somewhere else.
 */
const readWorkbookMedia: ChannelHandler = async (context) => {
  const request = workbookMediaRequestSchema.parse(context.args[0])
  const session = context.registry.require(request.sessionId, context.identity)
  const result = await context.pool.withSession(session.engineSessionId, (client) =>
    client.readMedia({ ...request, sessionId: session.engineSessionId }),
  )
  return workbookMediaResultSchema.parse(result)
}

/**
 * A pivot table's definition and its cache, parsed out of two package parts.
 *
 * Unlike the others this request *does* carry package paths, chosen by the
 * renderer from the visuals in the open result. They are read out of the
 * session's own snapshot, so a path can only ever address a part of the
 * document the caller already has open -- but they are still caller-supplied
 * strings, so they are checked for package shape before use.
 */
const readPivotDefinition: ChannelHandler = async (context) => {
  const request = workbookPivotRequestSchema.parse(context.args[0])
  const session = context.registry.require(request.sessionId, context.identity)
  assertPackagePath(request.path)
  assertPackagePath(request.cachePath)

  const [pivotXml, cacheXml] = await context.pool.withSession(session.engineSessionId, (client) =>
    Promise.all([
      readArchiveEntryText(client, session.snapshotPath, request.path),
      readArchiveEntryText(client, session.snapshotPath, request.cachePath),
    ]),
  )
  return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml, cacheXml))
}

/**
 * The sidecar's recalc reply. Mirrors `sidecarRecalcResultSchema` in
 * sheets-main.ts, which is declared inline in the handler and not exported.
 */
const sidecarRecalcResultSchema = z
  .object({
    cells: z.array(
      z
        .object({
          sheet: z.string(),
          row: z.number().int().nonnegative(),
          column: z.number().int().nonnegative(),
          formatted: z.string(),
          number: z.number().optional(),
          isFormula: z.boolean(),
        })
        .strict(),
    ),
    cached: z.boolean().optional(),
  })
  .strict()

/**
 * IronCalc recalculation.
 *
 * Sheet ids resolve through the session's own name map in both directions, so
 * the renderer never sees a path, and a sheet added this session -- which has
 * no part in the file yet -- fails closed before reaching the engine.
 */
const recalcWorkbook: ChannelHandler = async (context) => {
  const request = workbookRecalcRequestSchema.parse(context.args[0])
  const session = context.registry.require(request.sessionId, context.identity)

  const fileSheetName = (sheetId: string): string => {
    const name = session.sheetNames.get(sheetId)
    if (name === undefined) {
      throw new SheetsError('invalid_request', `Unknown sheet for recalculation: ${sheetId}`)
    }
    return name
  }

  const result = sidecarRecalcResultSchema.parse(
    await context.pool.withSession(session.engineSessionId, (client) =>
      client.recalcCells({
        path: session.snapshotPath,
        edits: request.edits.map((edit) => ({
          sheet: fileSheetName(edit.sheetId),
          row: edit.row,
          column: edit.column,
          input: edit.input,
        })),
        reads: request.reads.map((read) => ({
          sheet: fileSheetName(read.sheetId),
          range: read.range,
        })),
      }),
    ),
  )

  const idsByName = new Map([...session.sheetNames].map(([id, name]) => [name, id]))
  return workbookRecalcResultSchema.parse({
    cells: result.cells.flatMap((cell) => {
      const sheetId = idsByName.get(cell.sheet)
      if (sheetId === undefined) return []
      return [
        {
          sheetId,
          row: cell.row,
          column: cell.column,
          formatted: cell.formatted,
          ...(cell.number === undefined ? {} : { number: cell.number }),
          isFormula: cell.isFormula,
        },
      ]
    }),
  })
}

/**
 * A path inside an OOXML package: relative, no traversal, no absolute form.
 *
 * On the desktop these strings never leave the machine. Here they arrive over
 * HTTP, and while the read is scoped to the session's snapshot archive, a
 * caller-supplied path deserves checking on its own terms rather than relying
 * on that scoping to hold forever.
 */
function assertPackagePath(path: string): void {
  const invalid =
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '..' || segment === '.')
  if (invalid) throw new SheetsError('invalid_request', `Invalid package path: ${path}`)
}

export const readChannels: ChannelTable = {
  [IPC_CHANNELS.readWorkbookFormulas]: readWorkbookFormulas,
  [IPC_CHANNELS.readWorkbookMedia]: readWorkbookMedia,
  [IPC_CHANNELS.readPivotDefinition]: readPivotDefinition,
  [IPC_CHANNELS.recalcWorkbook]: recalcWorkbook,
}
