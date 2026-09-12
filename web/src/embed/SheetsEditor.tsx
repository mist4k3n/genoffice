import { useEffect, useRef, useState } from 'react'

import { App } from '../../../apps/sheets/src/renderer/App'
import { LocaleProvider, setModuleLang } from '../../../apps/sheets/src/renderer/i18n/locale'
import type { Lang } from '../../../packages/i18n/src/index'
import type { SheetsEditorProps, SheetsSelection } from './host-api'
import { HostTransportError } from '../host/transport'
import { observeSelection } from './selection'
import { installGlobalsOnce } from './globals'
import { installDesktopApi } from '../host/desktop-api'
import { createHttpDesktopApi } from '../host/desktop-api'
import { installUnsavedGuard } from '../host/unsaved-guard'

/**
 * The spreadsheet as a mountable React component.
 *
 * Upstream's `main.tsx` is a side-effect bootstrap: it demands `#root`, makes
 * its own React root, and stamps `lang` and `data-theme` onto `<html>`. None of
 * that is appropriate inside a host application, so this replaces it —
 * additively, in `web/`, importing the same exported `App`.
 *
 * ## One instance per page
 *
 * This mounts a single spreadsheet, and that is a real constraint rather than
 * an oversight. Two hard singletons sit underneath:
 *
 *  - `window.desktopApi` is a global, and the transport baked into it carries
 *    the document id. Two documents would need two of them.
 *  - `App` renders `<div id="univer-container">`, which Univer resolves by id
 *    (`createUniver({ container: 'univer-container' })`) and which
 *    `shape-draw.ts`, the formula-bar toggle and the keyboard handler all find
 *    with `getElementById`. Two instances produce two elements with one id, and
 *    every one of those lookups silently returns the first.
 *
 * That is the Electron model showing through: one window, one workbook. Making
 * it injectable is a small, well-shaped upstream change — thread an id through
 * `App` → `ExcelShell` and the three helpers — and until then a host with tabs
 * mounts the active document only.
 */
export function SheetsEditor(props: SheetsEditorProps): React.JSX.Element {
  const { documentId, apiBase, theme = 'system', locale = 'en', visible = true } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  // Host callbacks change identity on every host render; reading them through
  // a ref keeps that from tearing down the editor.
  const handlers = useRef(props)
  handlers.current = props

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await installGlobalsOnce()
      if (cancelled) return
      setModuleLang(locale as Lang)
      installDesktopApi(
        createHttpDesktopApi({
          baseUrl: apiBase,
          documentId,
          unsavedGuard: installUnsavedGuard(),
          observer: (event) => reportToHost(event, handlers.current),
        }),
      )
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [apiBase, documentId, locale])

  /**
   * The selection bridge. Papan fed the active cell to its AI chat from a
   * patched Collabora build, and its own migration notes call this the thing
   * most likely to be silently lost when the engine changes -- so it is part
   * of the component's contract rather than a patch.
   */
  useEffect(() => {
    if (!ready) return
    return observeSelection((selection: SheetsSelection | null) =>
      handlers.current.onSelectionChange?.(selection),
    )
  }, [ready])

  /**
   * A canvas inside a `display: none` subtree has no size, so Univer's
   * skeleton measures zero and stays that way — the resize it listens for
   * never fires, because nothing resized. Nudging the window once on the
   * transition to visible is what makes the grid re-measure.
   */
  useEffect(() => {
    if (!visible || !ready) return
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(frame)
  }, [visible, ready])

  return (
    <div
      ref={containerRef}
      className="genoffice-sheets-embed"
      // Scoped, not stamped on <html>: the tokens key off a bare [data-theme]
      // attribute selector, so descendants pick it up. 'system' cannot be
      // scoped -- its fallback is a :root media query -- so resolve it here.
      data-theme={theme === 'system' ? resolveSystemTheme() : theme}
      style={{ display: 'contents' }}
    >
      {ready ? (
        <LocaleProvider initial={locale as Lang}>
          <App />
        </LocaleProvider>
      ) : null}
    </div>
  )
}

/**
 * Translate one host call into the host-facing event it implies.
 *
 * The renderer is unmodified and knows nothing about a host, so its own
 * traffic is the only signal available -- which is enough, because every state
 * a host wants to show corresponds to a call it already makes.
 */
function reportToHost(
  event: { method: string; args: readonly unknown[]; result?: unknown; error?: unknown },
  handlers: SheetsEditorProps,
): void {
  if (event.error) {
    // A version conflict is the host's to present, not the editor's: Papan
    // shows an in-app banner with keep-mine / overwrite / show-saved-version
    // and deliberately removed the editor-native path because it duplicated
    // that UI.
    if (event.error instanceof HostTransportError && event.error.code === 'version_conflict') {
      const detail = (event.error as { detail?: { currentVersion?: string } }).detail
      handlers.onConflict?.({
        currentVersion: detail?.currentVersion ?? '',
        message: event.error.message,
      })
      return
    }
    handlers.onError?.(event.error instanceof Error ? event.error : new Error(String(event.error)))
    return
  }

  switch (event.method) {
    case 'selectWorkbook': {
      const file = event.result as Parameters<NonNullable<SheetsEditorProps['onLoaded']>>[0] | null
      if (file) handlers.onLoaded?.(file)
      return
    }
    case 'notifyPendingEdits': {
      const [count] = event.args
      handlers.onDirtyChange?.(typeof count === 'number' ? count : 0)
      return
    }
    case 'saveWorkbookEdits': {
      const saved = event.result as
        | { canceled?: boolean; file?: unknown; touchedEntries?: string[] }
        | undefined
      if (saved && saved.canceled !== true && saved.file) {
        handlers.onSaved?.({
          file: saved.file as Parameters<NonNullable<SheetsEditorProps['onSaved']>>[0]['file'],
          touchedEntries: saved.touchedEntries ?? [],
        })
      }
      return
    }
    default:
  }
}

function resolveSystemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
