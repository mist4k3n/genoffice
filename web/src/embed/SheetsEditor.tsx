import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { App } from '../../../apps/sheets/src/renderer/App'
import { HostApiProvider } from '../../../apps/sheets/src/renderer/host-api'
import { LocaleProvider, setModuleLang } from '../../../apps/sheets/src/renderer/i18n/locale'
import type { Lang } from '../../../packages/i18n/src/index'
import type { SheetsEditorProps, SheetsSelection } from './host-api'
import { HostTransportError } from '../host/transport'
import { observeSelection, type UniverApiLike } from './selection'
import { installGlobalsOnce } from './globals'
import { createHttpDesktopApi } from '../host/desktop-api'
import type { DesktopApi } from '../../../apps/sheets/src/shared/desktop-api'
import { claimContainerId, enqueueMount, releaseContainerId, whenGridReady } from './singletons'
import { installUnsavedGuard } from '../host/unsaved-guard'

/**
 * The spreadsheet as a mountable React component.
 *
 * Upstream's `main.tsx` is a side-effect bootstrap: it demands `#root`, makes
 * its own React root, and stamps `lang` and `data-theme` onto `<html>`. None of
 * that is appropriate inside a host application, so this replaces it —
 * additively, in `web/`, importing the same exported `App`.
 *
 * ## Several editors on one page
 *
 * Each editor gets its own host bridge, passed to `App` as a prop rather than
 * read from `window.desktopApi` — that is the upstream change recorded in
 * `web/UPSTREAM-CHANGES.md`. The container element id is still a page-level
 * global upstream, so `singletons.ts` hands it to one editor at a time; that
 * part needs no upstream change.
 */
export function SheetsEditor(props: SheetsEditorProps): React.JSX.Element {
  const { documentId, apiBase, theme = 'system', locale = 'en', visible = true } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  // Host callbacks change identity on every host render; reading them through
  // a ref keeps that from tearing down the editor.
  const handlers = useRef(props)
  handlers.current = props

  // Identity for singleton ownership. Stable for this editor's lifetime.
  const token = useMemo(() => Symbol('sheets-editor'), [])
  const apiRef = useRef<DesktopApi | null>(null)
  // This editor's own Univer runtime, so the selection bridge reports the
  // right document when a page holds several editors.
  const univerApiRef = useRef<UniverApiLike | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await installGlobalsOnce()
      if (cancelled) return
      setModuleLang(locale as Lang)
      apiRef.current = createHttpDesktopApi({
        baseUrl: apiBase,
        documentId,
        unsavedGuard: installUnsavedGuard(),
        observer: (event) => reportToHost(event, handlers.current),
      })
      // Start-up is serialised: see enqueueMount. The editor does not render
      // until its turn, and holds the queue until its grid exists.
      await enqueueMount(async () => {
        if (cancelled) return
        setReady(true)
        const root = containerRef.current
        if (root) await whenGridReady(root, () => cancelled)
      })
    })()
    return () => {
      cancelled = true
    }
  }, [apiBase, documentId, locale, token])

  /**
   * Take the singletons before upstream's `useEffect` resolves the container
   * id. A parent layout effect runs ahead of a child's passive effect, which
   * is the whole reason this ordering works.
   */
  useLayoutEffect(() => {
    const root = containerRef.current
    if (!root || !ready) return
    // Claimed on mount as well as on becoming visible: an editor needs the
    // container id while *it* initialises, not only while it is on screen.
    claimContainerId(token, root)
    return () => releaseContainerId(token, root)
  }, [ready, visible, token])

  /**
   * The selection bridge. Papan fed the active cell to its AI chat from a
   * patched Collabora build, and its own migration notes call this the thing
   * most likely to be silently lost when the engine changes -- so it is part
   * of the component's contract rather than a patch.
   */
  useEffect(() => {
    if (!ready || !visible) return
    return observeSelection(
      () => univerApiRef.current,
      (selection: SheetsSelection | null) => handlers.current.onSelectionChange?.(selection),
    )
  }, [ready, visible])

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
      {ready && apiRef.current ? (
        // The provider wraps LocaleProvider too: it renders above App and
        // reads the bridge through the same hook, so it must be inside.
        <HostApiProvider value={apiRef.current}>
          <LocaleProvider initial={locale as Lang}>
            <App
              api={apiRef.current}
              onRuntime={(runtime) => {
                univerApiRef.current =
                  (runtime?.univerAPI as unknown as UniverApiLike | undefined) ?? null
              }}
            />
          </LocaleProvider>
        </HostApiProvider>
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
