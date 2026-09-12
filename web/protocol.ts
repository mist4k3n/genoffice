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

/**
 * Marker the open result carries when the session was restored from a draft.
 *
 * Stripped by the host bridge before the renderer sees the result, the same
 * way the Save As token is -- upstream's `workbookFileSchema` is `.strict()`
 * and the renderer has no concept of a draft.
 *
 * It exists because the dirty indicator would otherwise lie. A restored draft
 * leaves the edit journal empty -- the edits are in the bytes the sidecar
 * opened -- so the renderer honestly reports zero pending edits while the
 * document still differs from the version in storage. Papan persists dirty
 * state server-side for exactly this reason: it has to survive a session
 * ending.
 */
export const DRAFT_RESTORED_KEY = 'draftRestored'

/** Path of the one-shot download, relative to the router's mount point. */
export const exportPath = (token: string): string => `/export/${encodeURIComponent(token)}`

/**
 * Push channel for "the document moved underneath you".
 *
 * Not an upstream channel: the desktop has no equivalent, because there the
 * document is a file and the only writer is the app itself. Upstream's guard
 * is a re-hash at save time, which can only ever report the conflict *after*
 * the user has tried to save.
 *
 * The host knows earlier -- Papan learns it from its own realtime layer -- and
 * its banner exists to say so while there is still a choice to make. So this
 * is the host telling the server, and the server telling every session that is
 * now behind.
 */
export const CONFLICT_CHANNEL = 'sheets:document-conflict'

/**
 * What {@link CONFLICT_CHANNEL} carries.
 *
 * Addressed to sessions rather than to the socket, because a push reaches
 * every socket watching the document -- including the one whose own save
 * caused the change. Without `sessions`, saving in one tab would raise a
 * conflict banner in that same tab.
 */
export interface DocumentConflict {
  /** The version storage holds now, which these sessions did not produce. */
  readonly currentVersion: string
  /** Sessions that are behind it. A client not listed here is up to date. */
  readonly sessions: readonly string[]
  /**
   * Unsaved edits at stake, the largest across the listed sessions.
   *
   * Reported rather than acted on: a clean session can reload in silence, a
   * dirty one needs the person. Which of those to do is the host's call.
   */
  readonly pendingEdits: number
}

/**
 * One push, addressed to the sessions that are actually behind.
 *
 * Shared because two paths raise the same event: the host telling us its
 * storage moved, and our own save path telling the *other* tabs on a document
 * that it just moved storage itself.
 */
export function conflictFor(
  currentVersion: string,
  stale: readonly { sessionId: string; pendingEdits: number }[],
): DocumentConflict {
  return {
    currentVersion,
    sessions: stale.map((session) => session.sessionId),
    pendingEdits: Math.max(0, ...stale.map((session) => session.pendingEdits)),
  }
}

/**
 * Options a *host* attaches to a call, alongside the renderer's own argument.
 *
 * They travel as a second positional argument, which is unambiguous: upstream's
 * preload sends exactly one, so anything in `args[1]` came from this package.
 * That keeps upstream's `.strict()` request schemas intact -- adding a field to
 * the request the renderer builds would fail its own validation.
 */
export interface HostCallOptions {
  /**
   * Save over a document that moved. The version guard is replaced by a
   * compare-and-set against what storage holds *now*, so a document that moves
   * again mid-save still conflicts rather than silently clobbering.
   *
   * This is the banner's "overwrite". It is a decision a person made, which is
   * why it cannot originate in the renderer.
   */
  readonly overwrite?: boolean | undefined
}

/**
 * Header asking the server to open this connection read-only.
 *
 * A downgrade only: the server intersects it with what `identify()` returned,
 * so a client can give up rights it has and never claim rights it does not.
 * It exists for the conflict banner's "show saved version", which mounts a
 * second editor on the stored bytes beside the dirty one.
 */
export const READ_ONLY_HEADER = 'x-sheets-read-only'
