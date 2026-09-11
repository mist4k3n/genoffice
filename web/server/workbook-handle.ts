import { SheetsError } from './errors'

/**
 * The `path` the renderer is given for an open workbook.
 *
 * On the desktop this is a real filesystem path. Here it must not be: the
 * server's scratch snapshot lives in a temp directory whose name means nothing
 * to the user and whose existence is nobody's business.
 *
 * It cannot simply be omitted either. `CELL("filename")` returns the empty
 * string without it, which the renderer treats as "never saved" -- and the
 * `=MID(CELL("filename"),FIND("]",...)+1,31)` sheet-name idiom, which is
 * everywhere in real spreadsheets, quietly stops working.
 *
 * And it cannot be an opaque `doc://<uuid>`, because the renderer parses it
 * structurally: `cell-function.ts` cuts at the last `/` or `\` to split
 * directory from filename. PLAN.md anticipated exactly this -- "if one does,
 * issue a path-shaped token instead of editing upstream" -- so that is what
 * this builds.
 */

/** Path segments that must never reach a browser. */
const FORBIDDEN = [/^[A-Za-z]:[\\/]/, /^\/(?:tmp|var|private|home|Users|root|etc)\b/]

/**
 * A path-shaped handle whose basename is the document's real filename.
 *
 * `displayPath` from the storage adapter wins when it is present and safe --
 * the host knows where the document actually lives for the user. Otherwise the
 * name alone is enough to make the formula behave.
 */
export function workbookDisplayPath(name: string, displayPath?: string | undefined): string {
  if (displayPath === undefined || displayPath === '') return `/${name}`

  if (!displayPath.startsWith('/')) {
    throw new SheetsError('internal', `displayPath must be absolute: ${displayPath}`)
  }
  if (FORBIDDEN.some((pattern) => pattern.test(displayPath))) {
    // A storage adapter handing back a real server path is a bug in the host,
    // and silently forwarding it would leak the server's layout to every
    // viewer of the document.
    throw new SheetsError('internal', 'displayPath looks like a server filesystem path')
  }
  const basename = displayPath.slice(displayPath.lastIndexOf('/') + 1)
  // The renderer shows the basename in brackets; a displayPath whose last
  // segment disagrees with the workbook name would display the wrong file.
  return basename === name ? displayPath : `${displayPath.replace(/\/+$/, '')}/${name}`
}
