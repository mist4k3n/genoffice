/**
 * Wire shapes this package adds to upstream's IPC contract.
 *
 * Everything else on the wire is upstream's, verbatim -- the channel names,
 * the request schemas, the result schemas. This file is the short list of
 * things the desktop has no equivalent for, so it is worth keeping small and
 * worth reading in full.
 *
 * It sits at the root rather than under `server/` or `src/` because both
 * halves import it, and a shared contract that lives inside one of the two
 * sides tends to grow the assumptions of that side.
 */

/** An assembled Save As, waiting at `GET /export/:token`. */
export interface ExportSlot {
  readonly token: string
  /** File name to suggest to the user, from the document's own metadata. */
  readonly name: string
  readonly size: number
}

/**
 * What `saveWorkbookEdits` returns for `mode: 'save-as'`.
 *
 * `canceled: true` is upstream's shape and is accurate: nothing was saved to
 * this document. The renderer reads only that field and leaves its journal
 * pending, which is the copy semantics Save As wants. The `export` half is
 * ours, and the host bridge strips it before the renderer ever sees the
 * result -- so upstream's strict result schema stays satisfied on the only
 * side that parses it.
 */
export interface WorkbookSaveExportResult {
  readonly canceled: true
  readonly export: ExportSlot & {
    /** Package parts the patch rewrote. Empty when the journal was empty. */
    readonly touchedEntries: readonly string[]
  }
}

/** Path of the one-shot download, relative to the router's mount point. */
export const exportPath = (token: string): string => `/export/${encodeURIComponent(token)}`
