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
  /** answered by the browser itself; never reaches the server (see local-api.ts) */
  | 'local'
  /**
   * driven by the embedding application rather than by either side of the
   * wire: the host dispatches, the renderer listens (see commands.ts)
   */
  | 'host'
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
  // Repointed from 'shell', as that comment said to: the embedding
  // application's chrome is the menu on the web, and its Save As needs to
  // reach the renderer's own save path. See commands.ts.
  onMenuAction: {
    status: 'host',
    channel: IPC_CHANNELS.menuAction,
    boot: true,
    note: 'host chrome dispatches',
  },
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
  onDocumentThemeChanged: {
    status: 'shell',
    channel: 'app:document-theme-changed',
    note: 'the dark page is the host\u2019s decision; theme arrives as a prop',
  },
  onUserDisplayNameChanged: {
    status: 'shell',
    channel: 'app:author-name-changed',
    note: 'no shell Home to rename the author',
  },
  onAiSettingsChanged: {
    status: 'shell',
    channel: IPC_CHANNELS.aiSettingsChanged,
    note: 'nothing changes them while the AI surface is off',
  },
  onMcpCommand: {
    status: 'shell',
    channel: IPC_CHANNELS.mcpCommand,
    note: 'the desktop shell pushes these; Papan has its own assistant',
  },
  // Not permanent, unlike its neighbours: the engine pool *does* know when a
  // sidecar dies. Wiring it as a push would make recovery positive instead of
  // inferred from a session guard's error text -- PAPAN-INTEGRATION.md, D3.
  onSidecarCrashed: {
    status: 'shell',
    channel: IPC_CHANNELS.sidecarCrashed,
    note: 'the pool could push this; until it does, a crash is inferred',
  },

  // ── document lifecycle (phase 02/03) ─────────────────────────────────────
  // On the web there is no file dialog: the document is whichever one the
  // connection is authorised for, so this opens it rather than asking.
  selectWorkbook: { status: 'http', channel: IPC_CHANNELS.selectWorkbook },
  selectWorkbooksForMerge: { status: 'todo', channel: IPC_CHANNELS.selectWorkbooksForMerge },
  openWorkbooksForMerge: { status: 'todo', channel: IPC_CHANNELS.openWorkbooksForMerge },
  closeWorkbook: { status: 'http', channel: IPC_CHANNELS.closeWorkbook },
  readWorkbookRange: { status: 'http', channel: IPC_CHANNELS.readWorkbookRange },
  readWorkbookFormulas: { status: 'http', channel: IPC_CHANNELS.readWorkbookFormulas },
  readWorkbookMedia: { status: 'http', channel: IPC_CHANNELS.readWorkbookMedia },
  readPivotDefinition: { status: 'http', channel: IPC_CHANNELS.readPivotDefinition },
  recalcWorkbook: { status: 'http', channel: IPC_CHANNELS.recalcWorkbook },
  // Pairs with onSidecarCrashed: re-open a known path through the normal open
  // path to adopt a live session. The server has that pipeline already.
  reopenWorkbook: { status: 'todo', channel: IPC_CHANNELS.reopenWorkbook },
  // Find run inside the engine over the file's chunk index rather than over
  // what the viewport happens to hold -- the streamed-workbook case, which is
  // every heavy workbook on the web.
  findWorkbookCells: { status: 'todo', channel: IPC_CHANNELS.findWorkbookCells },
  readWorkbookRowOutline: { status: 'todo', channel: IPC_CHANNELS.readWorkbookRowOutline },

  // ── save ─────────────────────────────────────────────────────────────────
  saveWorkbookEdits: { status: 'http', channel: IPC_CHANNELS.saveWorkbook },
  beginSaveEditsTransfer: { status: 'http', channel: IPC_CHANNELS.saveEditsBegin },
  sendSaveEditsChunk: { status: 'http', channel: IPC_CHANNELS.saveEditsChunk },
  abortSaveEditsTransfer: { status: 'http', channel: IPC_CHANNELS.saveEditsAbort },
  // Unsaved work, written every 30s while dirty -- and never a version. See
  // ports.ts, DraftAdapter, for why that distinction is the whole point.
  writeWorkbookRecovery: { status: 'http', channel: IPC_CHANNELS.writeWorkbookRecovery },
  replyRecoveryPrompt: { status: 'todo', channel: IPC_CHANNELS.recoveryPromptReply },
  reportCloseSaveResult: { status: 'todo', channel: IPC_CHANNELS.closeSaveResult },
  autoRenameWorkbook: { status: 'todo', channel: IPC_CHANNELS.autoRenameWorkbook },
  confirmCsvSave: { status: 'todo', channel: IPC_CHANNELS.csvSaveConfirm },

  // ── export (phase 03, headless Chromium in phase 09) ─────────────────────
  // Phase 09: upstream renders PDF through a hidden Electron window, which
  // has no browser counterpart — it needs headless Chromium server-side.
  exportPdf: { status: 'todo', channel: IPC_CHANNELS.exportPdf },
  // Browser download: the renderer already serialized the sheet, so a server
  // round trip would only hand the bytes back again.
  exportCsv: { status: 'local', channel: IPC_CHANNELS.exportCsv },
  createDocument: { status: 'todo', channel: IPC_CHANNELS.createDocument },
  // Printing is Electron's: a browser has no printer list and no silent
  // print. The web answer to both is export-PDF plus the browser's own print.
  listPrinters: { status: 'todo', channel: IPC_CHANNELS.listPrinters },
  printWorkbook: { status: 'todo', channel: IPC_CHANNELS.printWorkbook },
  // The shell's headless-export handshake: it queues an out path before the
  // renderer boots and waits for the result. Pairs with exportPdf above.
  // Answered in the browser: there is no shell to queue an export path, and
  // the renderer asks on every boot, so a rejection would be an uncaught error
  // on every open rather than a feature gap.
  consumeHeadlessExport: { status: 'local', channel: 'sheets:consume-headless-export' },
  headlessExportDone: { status: 'todo', channel: 'sheets:headless-export-done' },

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
  setAiPanelPrefs: { status: 'todo', channel: 'app:set-ai-panel-prefs' },
  openAiModelSettings: { status: 'todo', channel: IPC_CHANNELS.aiOpenModelSettings },
  openSkillsSettings: { status: 'todo', channel: 'ai:open-skills-settings' },
  skillsList: { status: 'todo', channel: 'ai:skills-list' },
  skillText: { status: 'todo', channel: 'ai:skill-text' },

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
    status: 'local',
    channel: null,
    note: 'a browser File has no filesystem path; answers with the empty string',
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
    status: 'local',
    channel: IPC_CHANNELS.openExternal,
    note: 'window.open; a round trip to learn a URL we already have is waste',
  },
  openSourcePath: {
    status: 'todo',
    channel: 'home:open-path',
    note: 'shell file navigation; a host routes its own documents',
  },
  getDocumentTheme: {
    status: 'todo',
    channel: 'app:get-document-theme',
    note: 'the embed resolves the dark page from its own container, not from a setting',
  },
  getUserDisplayName: {
    status: 'local',
    channel: IPC_CHANNELS.userDisplayName,
    note: "threaded-comment authorship; answers '' until the server serves identify()'s user",
  },
  // Sends, not requests: the bridge installs against a no-op `onMcpCommand`
  // and then announces into nothing. A send with no listener is a no-op.
  reportMcpResult: {
    status: 'local',
    channel: IPC_CHANNELS.mcpResult,
    note: 'the desktop MCP bridge; no web counterpart',
  },
  signalMcpReady: {
    status: 'local',
    channel: IPC_CHANNELS.mcpReady,
    note: 'the desktop MCP bridge; no web counterpart',
  },
}

export const BOOT_SURFACE = (Object.keys(COVERAGE) as (keyof DesktopApi)[]).filter(
  (key) => COVERAGE[key].boot,
)

export function coverageSummary(): Record<Status, number> {
  const counts: Record<Status, number> = { http: 0, push: 0, shell: 0, local: 0, host: 0, todo: 0 }
  for (const entry of Object.values(COVERAGE)) counts[entry.status] += 1
  return counts
}
