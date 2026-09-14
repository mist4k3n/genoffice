import type { WorkbookFile } from '../../../apps/sheets/src/shared/desktop-api'
import type { HostTheme } from './theme'

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

/**
 * A Save As that produced bytes and no destination.
 *
 * Where the copy goes is the host's question: Papan's picker already takes a
 * `customSave` callback, and its documents are tree nodes this package has no
 * port to create. The editor's own document is untouched and its unsaved
 * edits stay pending -- this is a copy, not a move.
 */
export interface SheetsExport {
  readonly bytes: Uint8Array
  /** The document's current file name, to seed the host's picker. */
  readonly suggestedName: string
  /** Package parts the patch rewrote. Empty when nothing was pending. */
  readonly touchedEntries: readonly string[]
}

export interface SheetsConflictEvent {
  /** The version the document is at now, which this session did not produce. */
  readonly currentVersion: string
  readonly message: string
  /** Unsaved edits at stake. Zero means reloading costs the user nothing. */
  readonly pendingEdits: number
  /**
   * How this was learned.
   *
   * `'announced'` arrives while the document is still open and nothing has
   * been attempted -- this is the banner's trigger, and the state Papan's
   * `useWopiConflict` is built around. `'rejected'` is a save that already
   * failed, which is the same conflict found late.
   */
  readonly source: 'announced' | 'rejected'
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
  /**
   * Someone asked for Save As from inside the editor -- its ribbon button, or
   * ⇧⌘S -- and here are the bytes.
   *
   * Not fired for `handle.exportBytes()`, which returns them to the caller
   * instead. This is the unprompted half: a host that offers Save As only
   * through its own chrome still needs to answer the button that is already
   * on the ribbon, or it does nothing.
   */
  readonly onSaveAsRequest?: ((event: SheetsExport) => void) | undefined
  /**
   * This session opened from unsaved work rather than from the stored
   * document, so it is dirty before anyone has typed anything.
   *
   * A host that shows a dirty indicator needs this, because `onDirtyChange`
   * cannot supply it: restoring a draft leaves the edit journal empty -- the
   * edits are already in the bytes -- so the editor honestly reports zero
   * pending edits for a document that differs from what storage holds. Papan
   * persists its dirty flag server-side for the same reason.
   */
  readonly onDraftRestored?: (() => void) | undefined
  readonly onError?: ((error: Error) => void) | undefined
}

/**
 * Imperative commands, reached through a ref.
 *
 * Every one of these drives the renderer through the same path its own
 * keyboard shortcuts use -- upstream's `onMenuAction`, repointed from the
 * native menu at the host (see `web/src/host/commands.ts`). That is not an
 * implementation detail worth hiding: it is why Save As here collects the
 * pending edit journal correctly, rather than by a second implementation of
 * the several hundred lines that do it.
 */
export interface SheetsHandle {
  /**
   * Explicit save. Writes a version. Resolves when the save has landed.
   *
   * `overwrite` is the conflict banner's own button: it replaces the
   * open-version guard with a compare-and-set against what storage holds now,
   * so a document that moves *again* mid-save still conflicts. Only a person
   * can make that choice, which is why it enters here and not in the editor.
   */
  save(options?: { overwrite?: boolean }): Promise<void>
  /**
   * Produce the patched bytes without persisting them, so the host's own Save
   * As dialog can write them wherever the user chose.
   *
   * This exists because Papan's picker already takes a `customSave` callback,
   * so "Save As" is the host's flow with our bytes — not a second dialog and
   * not a create-document port on our side.
   */
  exportBytes(): Promise<SheetsExport>
  /**
   * Download the active sheet as CSV, through the browser.
   *
   * Resolves once the editor has the request; the download itself is the
   * browser's, and it does not report back.
   */
  exportCsv(): Promise<void>
  /**
   * Discard local state and reload from storage.
   *
   * Unsaved edits are lost, which is the point -- this is the other half of a
   * conflict banner's "discard mine". The host is expected to have asked.
   */
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
   * Both palettes are bound to an explicit `[data-theme]` attribute, so either
   * one scopes to a subtree. `'system'` cannot be scoped -- it is answered by
   * a `prefers-color-scheme` block guarded on `:root`, and a container is not
   * `:root` -- so it is resolved here, live, as the OS appearance changes.
   *
   * `'dim'` is accepted and resolved to dark: see {@link HostTheme}. Changing
   * this prop is an event, not a remount -- the renderer's own listeners hear
   * it, so Univer's canvas repaints with the chrome.
   */
  readonly theme?: HostTheme | undefined
  /**
   * Any BCP-47 tag. It is mapped onto upstream's dictionary key by upstream's
   * own `normalizeLang`, so `'zh-CN'`, `'zh-TW'`, `'ms-MY'` and `'en-GB'` all
   * land somewhere real and an unknown tag falls back to English rather than
   * rendering keys. Like `theme`, changing it is an event, not a remount.
   */
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
  /**
   * Open this editor read-only, whatever rights the viewer has.
   *
   * A downgrade the server intersects with its own decision, so it can only
   * give up rights. This is what the conflict banner's "show saved version"
   * needs: a second editor on the stored bytes, mounted beside the dirty one
   * and unable to write.
   */
  readonly readOnly?: boolean | undefined
  /**
   * Run this editor in its own frame.
   *
   * Needed only when two editors must be **visible at the same time** -- a
   * compare view, a split. Univer names its internal editor hosts with fixed
   * element ids, so two visible grids collide in one realm and a frame is the
   * only second realm available. Several editors with one visible at a time
   * work inline and should stay inline: a frame costs another copy of the
   * bundle and another React tree.
   *
   * Everything else about the component is unchanged -- same props, same ref,
   * same events -- so this is a one-word switch rather than a second API.
   */
  readonly isolate?: boolean | undefined
  /**
   * Where the frame's page is served, when `isolate` is set.
   *
   * Relative by default, so it resolves against whatever serves the bundle. A
   * host serving it from another origin must also send its session cookie with
   * `SameSite=None`: the frame makes its own API calls.
   */
  readonly frameSrc?: string | undefined
  /** Imperative commands. React 19 passes a ref as a plain prop. */
  readonly ref?: React.Ref<SheetsHandle> | undefined
}
