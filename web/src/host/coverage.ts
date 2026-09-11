import { IPC_CHANNELS } from '../../../apps/sheets/src/shared/ipc-channels'
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
 * Channels are **imported from upstream's IPC_CHANNELS**, not retyped. An
 * earlier revision spelled them out as string literals and 32 of the 59 were
 * wrong — invented rather than mirrored — which nothing caught, because a
 * channel is just a string. Importing makes a renamed constant a compile error
 * and a changed value follow automatically.
 *
 * A dozen channels are string literals in the preload too (`app:*`, the two
 * `sheets:*` queue probes, `ai:web-search`). Those are the residual risk, and
 * `npm run check:channels` re-derives every entry here from the preload source
 * to catch them.
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
  /** Upstream's wire channel, or null when the preload answers without IPC. */
  readonly channel: string | null
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
  notifyPendingEdits: { status: 'http', channel: IPC_CHANNELS.pendingEditsChanged, boot: true },
  aiGskStatus: { status: 'http', channel: IPC_CHANNELS.aiGskStatus, boot: true },
  getAiSettings: { status: 'http', channel: IPC_CHANNELS.aiGetSettings, boot: true },
  consumeNewBlankWorkbook: { status: 'http', channel: 'sheets:consume-new-blank', boot: true },
  hasQueuedWorkbook: { status: 'http', channel: 'sheets:has-queued-workbook', boot: true },

  // Shell relays: the Electron tab host pushes these; on the web there is no
  // source. Left as no-op subscriptions deliberately — see PLAN.md phase 01,
  // "decide this rather than stubbing and forgetting". Repoint them at web
  // equivalents (browser menu, beforeunload, rename UI) when those exist.
  onMenuAction: { status: 'shell', channel: IPC_CHANNELS.menuAction, boot: true, note: 'native menu' },
  onCloseSaveRequest: {
    status: 'shell',
    channel: IPC_CHANNELS.closeSaveRequest,
    boot: true,
    note: 'tab close → beforeunload',
  },
  onWorkbookRenamed: {
    status: 'shell',
    channel: IPC_CHANNELS.workbookRenamed,
    boot: true,
    note: 'rename from shell Home',
  },
  onRecoveryPrompt: {
    status: 'shell',
    channel: IPC_CHANNELS.recoveryPrompt,
    boot: true,
    note: 'crash recovery, phase 02',
  },
  onChromePressed: { status: 'shell', channel: 'app:chrome-pressed', note: 'tab strip press' },

  // ── document lifecycle (phase 02/03) ─────────────────────────────────────
  // On the web there is no file dialog: the document is whichever one the
  // connection is authorised for, so this opens it rather than asking.
  selectWorkbook: { status: 'http', channel: IPC_CHANNELS.selectWorkbook },
  selectWorkbooksForMerge: { status: 'todo', channel: IPC_CHANNELS.selectWorkbooksForMerge },
  openWorkbooksForMerge: { status: 'todo', channel: IPC_CHANNELS.openWorkbooksForMerge },
  closeWorkbook: { status: 'http', channel: IPC_CHANNELS.closeWorkbook },
  readWorkbookRange: { status: 'http', channel: IPC_CHANNELS.readWorkbookRange },
  readWorkbookFormulas: { status: 'todo', channel: IPC_CHANNELS.readWorkbookFormulas },
  readWorkbookMedia: { status: 'todo', channel: IPC_CHANNELS.readWorkbookMedia },
  readPivotDefinition: { status: 'todo', channel: IPC_CHANNELS.readPivotDefinition },
  recalcWorkbook: { status: 'todo', channel: IPC_CHANNELS.recalcWorkbook },

  // ── save (phase 03) ──────────────────────────────────────────────────────
  saveWorkbookEdits: { status: 'todo', channel: IPC_CHANNELS.saveWorkbook },
  beginSaveEditsTransfer: { status: 'todo', channel: IPC_CHANNELS.saveEditsBegin },
  sendSaveEditsChunk: { status: 'todo', channel: IPC_CHANNELS.saveEditsChunk },
  abortSaveEditsTransfer: { status: 'todo', channel: IPC_CHANNELS.saveEditsAbort },
  writeWorkbookRecovery: { status: 'todo', channel: IPC_CHANNELS.writeWorkbookRecovery },
  replyRecoveryPrompt: { status: 'todo', channel: IPC_CHANNELS.recoveryPromptReply },
  reportCloseSaveResult: { status: 'todo', channel: IPC_CHANNELS.closeSaveResult },
  autoRenameWorkbook: { status: 'todo', channel: IPC_CHANNELS.autoRenameWorkbook },
  confirmCsvSave: { status: 'todo', channel: IPC_CHANNELS.csvSaveConfirm },

  // ── export (phase 03, headless Chromium in phase 09) ─────────────────────
  exportPdf: { status: 'todo', channel: IPC_CHANNELS.exportPdf },
  exportCsv: { status: 'todo', channel: IPC_CHANNELS.exportCsv },
  createDocument: { status: 'todo', channel: IPC_CHANNELS.createDocument },

  // ── AI (phase 04) ────────────────────────────────────────────────────────
  aiStream: { status: 'todo', channel: IPC_CHANNELS.aiStream },
  aiStreamCancel: { status: 'todo', channel: IPC_CHANNELS.aiStreamCancel },
  onAiStream: { status: 'todo', channel: IPC_CHANNELS.aiStreamChunk },
  aiChat: { status: 'todo', channel: IPC_CHANNELS.aiChat },
  setAiSettings: { status: 'todo', channel: IPC_CHANNELS.aiSetSettings },
  aiGskLogin: { status: 'todo', channel: IPC_CHANNELS.aiGskLogin },
  webSearch: { status: 'todo', channel: 'ai:web-search' },
  imageSearch: { status: 'todo', channel: IPC_CHANNELS.aiImageSearch },
  generateImage: { status: 'todo', channel: IPC_CHANNELS.aiGenerateImage },

  // ── assets and attachments (phase 03) ────────────────────────────────────
  readLocalImage: { status: 'todo', channel: IPC_CHANNELS.readLocalImage },
  addPastedImage: { status: 'todo', channel: IPC_CHANNELS.filesAddPastedImage },
  fetchImage: { status: 'todo', channel: IPC_CHANNELS.aiFetchImage },
  pickAttachments: { status: 'todo', channel: IPC_CHANNELS.filesPick },
  addAttachmentPaths: { status: 'todo', channel: IPC_CHANNELS.filesAdd },
  readAttachment: { status: 'todo', channel: IPC_CHANNELS.filesRead },
  readAttachmentImage: { status: 'todo', channel: IPC_CHANNELS.filesReadImage },

  // ── no web equivalent ────────────────────────────────────────────────────
  getPathForFile: {
    status: 'todo',
    channel: null,
    note: 'preload uses webUtils.getPathForFile; a browser File has no path',
  },
  captureScreenSources: {
    status: 'todo',
    channel: IPC_CHANNELS.captureScreenSources,
    note: 'desktopCapturer; needs getDisplayMedia',
  },
  captureScreenSource: {
    status: 'todo',
    channel: IPC_CHANNELS.captureScreenSource,
    note: 'desktopCapturer; needs getDisplayMedia',
  },
  openExternal: {
    status: 'http',
    channel: IPC_CHANNELS.openExternal,
    note: 'window.open on the web',
  },
}

export const BOOT_SURFACE = (Object.keys(COVERAGE) as (keyof DesktopApi)[]).filter(
  (key) => COVERAGE[key].boot,
)

export function coverageSummary(): Record<Status, number> {
  const counts: Record<Status, number> = { http: 0, push: 0, shell: 0, todo: 0 }
  for (const entry of Object.values(COVERAGE)) counts[entry.status] += 1
  return counts
}
