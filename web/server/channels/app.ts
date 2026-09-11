import { IPC_CHANNELS } from '../../../apps/sheets/src/shared/ipc-channels'
import type { ChannelHandler, ChannelTable } from '../router-types'

/**
 * The boot surface: the channels the renderer calls before it paints.
 *
 * They are settings lookups rather than document work, so they read from the
 * server's preferences rather than touching a sidecar. Getting them wrong
 * stalls the shell, which is why they are implemented before anything else.
 */

const getLanguage: ChannelHandler = async (context) => context.preferences.language
const getTheme: ChannelHandler = async (context) => context.preferences.theme
const getAutoSaveDefault: ChannelHandler = async (context) => context.preferences.autoSave
const getAiPanelPrefs: ChannelHandler = async (context) => context.preferences.aiPanel

/**
 * The renderer reports its unsaved-edit count so the desktop shell can block a
 * window close. The browser equivalent is `beforeunload`, which the renderer
 * cannot reach from here -- but the count is still worth holding: an idle sweep
 * that evicts a session with pending edits should be able to say so.
 */
const notifyPendingEdits: ChannelHandler = async (context) => {
  const [count] = context.args
  context.registry.notePendingEdits(context.identity, typeof count === 'number' ? count : 0)
  return undefined
}

/** AI is phase 04. Answer honestly rather than pretending a provider exists. */
const aiGskStatus: ChannelHandler = async () => ({ loggedIn: false })
const getAiSettings: ChannelHandler = async (context) => context.preferences.aiSettings

/**
 * Desktop-only handshake. The shell can queue a file for a tab that has not
 * mounted yet; `consume` clears that one-shot flag.
 *
 * On the web there is no queue, because a connection is already bound to
 * exactly one document -- so `hasQueuedWorkbook` is always true, and that is
 * what makes the workbook open by itself. The renderer calls it on mount and
 * opens whatever it gets (App.tsx: `if (queued) void handleInspectWorkbook()`).
 */
const consumeNewBlankWorkbook: ChannelHandler = async () => false
const hasQueuedWorkbook: ChannelHandler = async () => true

/**
 * Opening a link is the browser's job, not the server's. The renderer already
 * awaits this call, so returning the URL lets the host decide -- and keeps the
 * channel from being a silent no-op.
 */
const openExternal: ChannelHandler = async (context) => {
  const [url] = context.args
  if (typeof url !== 'string') return undefined
  return { url }
}

export const appChannels: ChannelTable = {
  'app:get-language': getLanguage,
  'app:get-theme': getTheme,
  'app:get-auto-save-default': getAutoSaveDefault,
  'app:get-ai-panel-prefs': getAiPanelPrefs,
  'sheets:consume-new-blank': consumeNewBlankWorkbook,
  'sheets:has-queued-workbook': hasQueuedWorkbook,
  [IPC_CHANNELS.pendingEditsChanged]: notifyPendingEdits,
  [IPC_CHANNELS.aiGskStatus]: aiGskStatus,
  [IPC_CHANNELS.aiGetSettings]: getAiSettings,
  [IPC_CHANNELS.openExternal]: openExternal,
}
