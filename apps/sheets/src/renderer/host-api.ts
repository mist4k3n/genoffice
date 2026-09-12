import { createContext, useContext } from 'react'

import type { DesktopApi } from '../shared/desktop-api'

/**
 * The host bridge, resolved per editor instance.
 *
 * The renderer historically read `window.desktopApi` directly, which is
 * correct in Electron: a window holds exactly one workbook, so a page-level
 * global and an editor instance are the same thing. Embedding several editors
 * in one browser page breaks that equivalence — every instance would share one
 * bridge and therefore one document.
 *
 * Two ways to reach the bridge, matching how the renderer is written:
 *
 *  - React components call {@link useHostApi}.
 *  - Non-React modules read it from the per-instance state they already
 *    receive (`LazyWorkbookState.api`).
 *
 * Both fall back to `window.desktopApi`, so the desktop app and any code that
 * has not been threaded behave exactly as before.
 */

const HostApiContext = createContext<DesktopApi | null>(null)

export const HostApiProvider = HostApiContext.Provider

/** The bridge for the editor instance this component belongs to. */
export function useHostApi(): DesktopApi {
  return useContext(HostApiContext) ?? window.desktopApi
}

/** The bridge outside React, when no instance is in hand. */
export function defaultHostApi(): DesktopApi {
  return window.desktopApi
}
