import type { UiTheme, WorkbookFile } from '../../../apps/sheets/src/shared/desktop-api'

/**
 * The contract between a host application and an embedded spreadsheet.
 *
 * Papan embeds editors as lazy React components rather than iframes — its SPA
 * ships `frame-ancestors 'none'` and can never be framed — so this is a
 * component API, not a postMessage protocol. The events mirror what its
 * Collabora wrapper already consumes from the iframe, because the surrounding
 * UI (dirty indicator, conflict banner, connectivity icon, AI context) is
 * built against those and should not have to change.
 */

export interface SheetsSelection {
  readonly sheetName: string
  /** A1-style reference for the active range, e.g. "B2" or "B2:D8". */
  readonly range: string
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

export interface SheetsSavedEvent {
  readonly file: WorkbookFile
  /** Package parts the save rewrote. Empty for a no-op save. */
  readonly touchedEntries: readonly string[]
}

export interface SheetsConflictEvent {
  /** The version the document is at now, which this session did not produce. */
  readonly currentVersion: string
  readonly message: string
}

/**
 * Events the host listens to. Every one of these has a counterpart in Papan's
 * Collabora integration, named after what the host does with it rather than
 * after the editor's internals.
 */
export interface SheetsHostEvents {
  /**
   * Unsaved-edit count. Drives the dirty indicator, and is the same number the
   * desktop shell uses to decide whether a close may proceed.
   */
  readonly onDirtyChange?: ((pendingEdits: number) => void) | undefined
  readonly onLoaded?: ((file: WorkbookFile) => void) | undefined
  readonly onSaved?: ((event: SheetsSavedEvent) => void) | undefined
  /**
   * The document changed underneath this session.
   *
   * Deliberately an event and not a rejected save: Papan presents conflict as
   * an in-app banner with keep-mine / overwrite / show-saved-version, and
   * removed the editor-native 409 path precisely because it duplicated that.
   */
  readonly onConflict?: ((event: SheetsConflictEvent) => void) | undefined
  /**
   * The active cell or range.
   *
   * This is the AI context bridge. Papan fed it from a patched Collabora build
   * (`papan:editor-selection-change`), and its own migration notes flag it as
   * the thing most likely to be silently lost when the engine changes. Here it
   * is part of the contract rather than a patch.
   */
  readonly onSelectionChange?: ((selection: SheetsSelection | null) => void) | undefined
  readonly onError?: ((error: Error) => void) | undefined
}

/** Imperative commands, reached through a ref. */
export interface SheetsHandle {
  /** Explicit save. Writes a version. */
  save(): Promise<void>
  /**
   * Produce the patched bytes without persisting them, so the host's own Save
   * As dialog can write them wherever the user chose.
   *
   * This exists because Papan's picker already takes a `customSave` callback,
   * so "Save As" is the host's flow with our bytes — not a second dialog and
   * not a create-document port on our side.
   */
  exportBytes(): Promise<Uint8Array>
  /** Download the active sheet as CSV, through the browser. */
  exportCsv(): Promise<void>
  /** Discard local state and reload from storage. */
  reload(): Promise<void>
  pendingEdits(): number
}

export interface SheetsEditorProps extends SheetsHostEvents {
  /** Opaque document identifier, passed through to the storage adapter. */
  readonly documentId: string
  /** Base URL the Sheets router is mounted at. */
  readonly apiBase: string
  /**
   * Applied to this component's own container, not to `<html>`.
   *
   * The design tokens key off a bare `[data-theme]` attribute selector, so
   * scoping works — but only for an explicit theme. 'system' resolves through
   * a `:root`-scoped media query that a container cannot reach, so a host
   * passing 'system' gets it resolved here instead.
   */
  readonly theme?: UiTheme | undefined
  readonly locale?: string | undefined
  /**
   * False while the host keeps this mounted but hidden.
   *
   * Papan's shell hides decks with `display: none` rather than unmounting, and
   * a canvas grid inside a `display: none` subtree measures zero. Telling the
   * component when it becomes visible is what lets it re-measure; a
   * mount-time effect never fires again.
   */
  readonly visible?: boolean | undefined
}
