import type { DesktopApi } from '../../../apps/sheets/src/shared/desktop-api'

/**
 * DesktopApi methods the browser answers itself.
 *
 * Some of what the preload does is not a request to a backend at all -- it is
 * the desktop shell doing a local thing. Opening a link is the clearest case:
 * routing it through the server would cost a round trip to learn a URL the
 * browser already has, and the browser is the only thing that can open it.
 *
 * These are the 'local' entries in the coverage table. Keeping them there
 * rather than quietly special-casing them in the API builder means the drift
 * detector still covers them, and `npm run check:server` still knows they are
 * deliberately unserved rather than forgotten.
 */

export type LocalHandler = (...args: never[]) => unknown

export const LOCAL_HANDLERS: Partial<Record<keyof DesktopApi, LocalHandler>> = {
  /**
   * `shell.openExternal` on the desktop. Here it is a new tab.
   *
   * `noopener` is not optional: without it the opened page gets a handle on
   * this window through `window.opener` and can navigate it somewhere else.
   *
   * A blocked popup is reported rather than worked around. The alternative --
   * assigning `location` -- would navigate the user out of a spreadsheet with
   * unsaved edits to a URL the document chose, which is worse than not opening
   * it.
   */
  openExternal: ((url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Promise.reject(new Error(`Not a valid URL: ${url}`))
    }
    // A workbook is untrusted input, and its hyperlinks are attacker-supplied
    // strings. javascript: and data: URLs in a new tab run in this origin.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
      return Promise.reject(new Error(`Refusing to open a ${parsed.protocol} URL`))
    }
    const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
    if (!opened && parsed.protocol !== 'mailto:') {
      console.warn(`[host] the browser blocked opening ${parsed.href}`)
    }
    return Promise.resolve()
  }) as LocalHandler,

  /**
   * Electron's webUtils hands back a real filesystem path for a dropped File.
   * The browser has no such thing and never will -- a File is bytes plus a
   * name. Upstream uses the result to pass a path to the main process, so the
   * empty string reads as "no path", which is the truth.
   */
  getPathForFile: (() => '') as LocalHandler,
}
