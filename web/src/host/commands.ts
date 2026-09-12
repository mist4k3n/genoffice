import type { MenuAction } from '../../../apps/sheets/src/shared/desktop-api'
import type { HostCallOptions } from '../../protocol'

/**
 * The host's way in.
 *
 * `onMenuAction` is how upstream's shell drives the renderer from outside:
 * ⌘S, ⇧⌘S, ⌘O and the File menu all arrive as one of these. On the desktop the
 * source is a native menu, which is why COVERAGE first marked it 'shell' and
 * left it a no-op -- and why that entry's comment said to repoint it at a web
 * equivalent once one existed.
 *
 * This is that equivalent. The embedding application's own chrome is the menu
 * now, and dispatching an action here is exactly what the Electron main
 * process does when someone picks File > Save As.
 *
 * Using the renderer's own command path matters more than it looks. Save As
 * needs the pending edit journal, and the journal lives inside the renderer:
 * collecting it means the ~600 lines in `save-actions.ts` that walk the Univer
 * state, batch the structural ops, and chunk the upload. Reaching for the
 * result of that work through a channel the renderer already listens on costs
 * nothing; reimplementing it host-side would be a second save path to keep
 * correct forever.
 *
 * One bus per editor instance. A page with two workbooks open has two, and an
 * action dispatched at one must not reach the other.
 */
export interface HostCommandBus {
  /** Drive the renderer. No-op until it has subscribed. */
  dispatch(action: MenuAction): void
  /**
   * Drive the renderer with the host's intent attached.
   *
   * Only a person can decide to overwrite a document that moved, so the
   * decision cannot originate in the renderer -- and `onMenuAction` carries an
   * action and nothing else, by upstream's design. The intent is therefore
   * latched here and claimed by the bridge on the call the action produces.
   *
   * One-shot on purpose. An overwrite that survived into the *next* save would
   * be a flag nobody set clobbering a document nobody looked at.
   */
  dispatchWith(action: MenuAction, options: HostCallOptions): void
  /** Claim the pending intent, if the action that set it is the one calling. */
  takeOptions(): HostCallOptions
  /** The `onMenuAction` implementation handed to the renderer. */
  subscribe(listener: (action: MenuAction) => void): () => void
  /** True once the renderer is listening, so a caller can wait rather than lose the action. */
  readonly connected: boolean
}

/** How long a dispatched intent stays claimable. See dispatchWith. */
const INTENT_TTL_MS = 30_000

export function createHostCommandBus(): HostCommandBus {
  const listeners = new Set<(action: MenuAction) => void>()
  let pending: { options: HostCallOptions; expiresAt: number } | null = null
  return {
    dispatchWith(action, options) {
      // The intent expires. Collecting a large journal and chunking it takes
      // time, so it cannot be cleared on the next tick -- but a command the
      // renderer returned early from produces no call at all, and an overwrite
      // left standing would attach itself to whatever saved next. An autosave
      // inheriting a person's decision about a document they are no longer
      // looking at is the failure this window exists to close.
      pending = { options, expiresAt: Date.now() + INTENT_TTL_MS }
      this.dispatch(action)
    },
    takeOptions() {
      const claimed = pending
      pending = null
      return claimed && claimed.expiresAt > Date.now() ? claimed.options : {}
    },
    dispatch(action) {
      for (const listener of [...listeners]) {
        try {
          listener(action)
        } catch (error) {
          // One listener throwing must not swallow the action for the others,
          // and must not surface as a rejection at the dispatch site -- the
          // desktop's IPC send is fire-and-forget too.
          console.error(`[host] menu action ${action} listener threw`, error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get connected() {
      return listeners.size > 0
    },
  }
}
