/**
 * The browser's answer to the desktop close-save prompt.
 *
 * On the desktop, closing a tab with unsaved edits fires `closeSaveRequest`
 * from the shell and the renderer decides what to do. On the web there is no
 * shell, and `onCloseSaveRequest` is one of the permanent shell no-ops -- so
 * without this, closing a tab with pending edits loses them in silence.
 *
 * The renderer already tells us how many edits are pending: it calls
 * `notifyPendingEdits(count)` on every change, because the desktop shell uses
 * the same number to decide whether to block a window close. Watching that one
 * call is enough, and it needs no upstream change.
 *
 * What a browser permits here is deliberately limited: `beforeunload` can ask
 * the browser to show *its* confirmation dialog, with wording we do not
 * control, and only if the user has interacted with the page. That is the
 * whole mechanism -- we cannot save on the way out, and an async save started
 * here would not be allowed to finish.
 */

export interface UnsavedGuard {
  /** Called with the renderer's pending-edit count. */
  setPendingEdits(count: number): void
  pendingEdits(): number
  dispose(): void
}

export function installUnsavedGuard(target: Window = window): UnsavedGuard {
  let pending = 0

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (pending <= 0) return
    // Both forms: preventDefault is the standard, returnValue is what older
    // engines actually honour. The string is ignored by every modern browser,
    // which shows its own wording.
    event.preventDefault()
    event.returnValue = ''
  }

  target.addEventListener('beforeunload', onBeforeUnload)

  return {
    setPendingEdits(count) {
      pending = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
    },
    pendingEdits: () => pending,
    dispose() {
      target.removeEventListener('beforeunload', onBeforeUnload)
      pending = 0
    },
  }
}
