import type { MenuAction } from '../../../apps/sheets/src/shared/desktop-api'

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
  /** The `onMenuAction` implementation handed to the renderer. */
  subscribe(listener: (action: MenuAction) => void): () => void
  /** True once the renderer is listening, so a caller can wait rather than lose the action. */
  readonly connected: boolean
}

export function createHostCommandBus(): HostCommandBus {
  const listeners = new Set<(action: MenuAction) => void>()
  return {
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
