import type { DesktopApi } from '../../../apps/sheets/src/shared/desktop-api'

/**
 * Implementation status of every DesktopApi method, and the channel each one
 * uses.
 *
 * This table is the fork's drift detector. It is typed as
 * `Record<keyof DesktopApi, …>`, so the moment upstream adds, renames or
 * removes a method, `npm run typecheck` fails here and names it. That is
 * cheaper and more reliable than watching a diff, and it is the main reason
 * PLAN.md chose a typed shim over extracting packages.
 *
 * `channel` mirrors what apps/sheets/src/preload/index.ts passes to
 * ipcRenderer — some literal, some from IPC_CHANNELS. Kept verbatim so the
 * server can key routes off the same names.
 */
export type Status =
  /** implemented over HTTP invoke */
  | 'http'
  /** implemented as a WebSocket push subscription */
  | 'push'
  /** relays an Electron *shell* event that has no web source; permanent no-op */
  | 'shell'
  /** not yet implemented; calling it rejects with a named error */
  | 'todo'

export interface Entry {
  readonly status: Status
  readonly channel: string
  /** true when the renderer reaches it before the shell is interactive */
  readonly boot?: boolean | undefined
  readonly note?: string | undefined
}

export const COVERAGE: Record<keyof DesktopApi, Entry> = {
  // ── boot surface: the 17 the renderer touches before first paint ──────────
  getLanguage: { status: 'http', channel: 'app:get-language', boot: true },
  onLanguageChanged: { status: 'push', channel: 'app:language-changed', boot: true },
  getTheme: { status: 'http', channel: 'app:get-theme', boot: true },
  onThemeChanged: { status: 'push', channel: 'app:theme-changed', boot: true },
  getAutoSaveDefault: { status: 'http', channel: 'app:get-auto-save-default', boot: true },
  onAutoSaveDefaultChanged: {
    status: 'push',
    channel: 'app:auto-save-default-changed',
    boot: true,
  },
  getAiPanelPrefs: { status: 'http', channel: 'app:get-ai-panel-prefs', boot: true },
  onAiPanelPrefsChanged: { status: 'push', channel: 'app:ai-panel-prefs-changed', boot: true },
  notifyPendingEdits: { status: 'http', channel: 'sheets:pending-edits', boot: true },
  aiGskStatus: { status: 'http', channel: 'ai:gsk-status', boot: true },
  getAiSettings: { status: 'http', channel: 'ai:get-settings', boot: true },
  consumeNewBlankWorkbook: { status: 'http', channel: 'sheets:consume-new-blank', boot: true },
  hasQueuedWorkbook: { status: 'http', channel: 'sheets:has-queued-workbook', boot: true },

  // Shell relays: the Electron tab host pushes these; on the web there is no
  // source. Left as no-op subscriptions deliberately — see PLAN.md phase 01,
  // "decide this rather than stubbing and forgetting". Repoint them at web
  // equivalents (browser menu, beforeunload, rename UI) when those exist.
  onMenuAction: { status: 'shell', channel: 'sheets:menu-action', boot: true, note: 'native menu' },
  onCloseSaveRequest: {
    status: 'shell',
    channel: 'sheets:close-save-request',
    boot: true,
    note: 'tab close → beforeunload',
  },
  onWorkbookRenamed: {
    status: 'shell',
    channel: 'sheets:workbook-renamed',
    boot: true,
    note: 'rename from shell Home',
  },
  onRecoveryPrompt: {
    status: 'shell',
    channel: 'sheets:recovery-prompt',
    boot: true,
    note: 'crash recovery, phase 02',
  },
  onChromePressed: { status: 'shell', channel: 'sheets:chrome-pressed', note: 'tab strip press' },

  // ── document lifecycle (phase 02/03) ─────────────────────────────────────
  selectWorkbook: { status: 'todo', channel: 'sheets:select-workbook' },
  selectWorkbooksForMerge: { status: 'todo', channel: 'sheets:select-workbooks-merge' },
  openWorkbooksForMerge: { status: 'todo', channel: 'sheets:open-workbooks-merge' },
  closeWorkbook: { status: 'todo', channel: 'sheets:close-workbook' },
  readWorkbookRange: { status: 'todo', channel: 'workbook:read-range' },
  readWorkbookFormulas: { status: 'todo', channel: 'workbook:read-formulas' },
  readWorkbookMedia: { status: 'todo', channel: 'workbook:read-media' },
  readPivotDefinition: { status: 'todo', channel: 'workbook:read-pivot' },
  recalcWorkbook: { status: 'todo', channel: 'workbook:recalc' },

  // ── save (phase 03) ──────────────────────────────────────────────────────
  saveWorkbookEdits: { status: 'todo', channel: 'workbook:save' },
  beginSaveEditsTransfer: { status: 'todo', channel: 'workbook:save-transfer-begin' },
  sendSaveEditsChunk: { status: 'todo', channel: 'workbook:save-transfer-chunk' },
  abortSaveEditsTransfer: { status: 'todo', channel: 'workbook:save-transfer-abort' },
  writeWorkbookRecovery: { status: 'todo', channel: 'workbook:recovery-write' },
  replyRecoveryPrompt: { status: 'todo', channel: 'sheets:recovery-reply' },
  reportCloseSaveResult: { status: 'todo', channel: 'sheets:close-save-result' },
  autoRenameWorkbook: { status: 'todo', channel: 'sheets:auto-rename' },
  confirmCsvSave: { status: 'todo', channel: 'sheets:confirm-csv-save' },

  // ── export (phase 03, headless Chromium in phase 09) ─────────────────────
  exportPdf: { status: 'todo', channel: 'workbook:export-pdf' },
  exportCsv: { status: 'todo', channel: 'workbook:export-csv' },
  createDocument: { status: 'todo', channel: 'sheets:create-document' },

  // ── AI (phase 04) ────────────────────────────────────────────────────────
  aiStream: { status: 'todo', channel: 'ai:stream' },
  aiStreamCancel: { status: 'todo', channel: 'ai:stream-cancel' },
  onAiStream: { status: 'todo', channel: 'ai:stream-event' },
  aiChat: { status: 'todo', channel: 'ai:chat' },
  setAiSettings: { status: 'todo', channel: 'ai:set-settings' },
  aiGskLogin: { status: 'todo', channel: 'ai:gsk-login' },
  webSearch: { status: 'todo', channel: 'ai:web-search' },
  imageSearch: { status: 'todo', channel: 'ai:image-search' },
  generateImage: { status: 'todo', channel: 'ai:generate-image' },

  // ── assets and attachments (phase 03) ────────────────────────────────────
  readLocalImage: { status: 'todo', channel: 'sheets:read-local-image' },
  addPastedImage: { status: 'todo', channel: 'sheets:add-pasted-image' },
  fetchImage: { status: 'todo', channel: 'sheets:fetch-image' },
  pickAttachments: { status: 'todo', channel: 'sheets:pick-attachments' },
  addAttachmentPaths: { status: 'todo', channel: 'sheets:add-attachment-paths' },
  readAttachment: { status: 'todo', channel: 'sheets:read-attachment' },
  readAttachmentImage: { status: 'todo', channel: 'sheets:read-attachment-image' },
  getPathForFile: { status: 'todo', channel: 'sheets:get-path-for-file' },

  // ── no web equivalent ────────────────────────────────────────────────────
  captureScreenSources: {
    status: 'todo',
    channel: 'sheets:capture-sources',
    note: 'desktopCapturer; needs getDisplayMedia',
  },
  captureScreenSource: {
    status: 'todo',
    channel: 'sheets:capture-source',
    note: 'desktopCapturer; needs getDisplayMedia',
  },
  openExternal: { status: 'http', channel: 'sheets:open-external', note: 'window.open on the web' },
}

export const BOOT_SURFACE = (Object.keys(COVERAGE) as (keyof DesktopApi)[]).filter(
  (key) => COVERAGE[key].boot,
)

export function coverageSummary(): Record<Status, number> {
  const counts: Record<Status, number> = { http: 0, push: 0, shell: 0, todo: 0 }
  for (const entry of Object.values(COVERAGE)) counts[entry.status] += 1
  return counts
}
