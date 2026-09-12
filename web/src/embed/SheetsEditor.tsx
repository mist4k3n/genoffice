import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { App } from '../../../apps/sheets/src/renderer/App'
import { HostApiProvider } from '../../../apps/sheets/src/renderer/host-api'
import { LocaleProvider, setModuleLang } from '../../../apps/sheets/src/renderer/i18n/locale'
import type { Lang } from '../../../packages/i18n/src/index'
import type { SheetsEditorProps, SheetsExport, SheetsHandle, SheetsSelection } from './host-api'
import { HostTransportError } from '../host/transport'
import { observeSelection, type UniverApiLike } from './selection'
import { installGlobalsOnce } from './globals'
import { buildDesktopApi, type ExportedWorkbook } from '../host/desktop-api'
import { createHttpTransport, type HostTransport } from '../host/transport'
import { createHostCommandBus } from '../host/commands'
import type { DesktopApi, MenuAction } from '../../../apps/sheets/src/shared/desktop-api'
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

  // How the host drives the renderer: one bus per editor, so an action aimed
  // at this document cannot reach the one in the next tab.
  const commands = useMemo(createHostCommandBus, [])
  // Bumped by reload(): re-runs the effect below, which tears the bridge down
  // and opens a fresh session over whatever storage holds now.
  const [generation, setGeneration] = useState(0)
  // Mirrors notifyPendingEdits, so pendingEdits() can answer synchronously
  // the way a host reading it during a close prompt needs.
  const pendingEditsRef = useRef(0)
  // Callers of save()/exportBytes() waiting on the renderer to come back.
  const awaitingSave = useRef(createWaiters<void>())
  const awaitingExport = useRef(createWaiters<SheetsExport>())

  useEffect(() => {
    let cancelled = false
    let transport: HostTransport | null = null
    void (async () => {
      await installGlobalsOnce()
      if (cancelled) return
      setModuleLang(locale as Lang)
      // The transport is built here rather than inside createHttpDesktopApi so
      // that unmounting can close its socket. Without that, every editor a
      // host ever mounted keeps a WebSocket open for the life of the page.
      transport = createHttpTransport({ baseUrl: apiBase, documentId })
      apiRef.current = buildDesktopApi(transport, {
        unsavedGuard: installUnsavedGuard(),
        observer: (event) => {
          trackLocally(event, pendingEditsRef, {
            save: awaitingSave.current,
            export: awaitingExport.current,
          })
          reportToHost(event, handlers.current)
        },
        commands,
        onExport: (exported) => deliverExport(exported, awaitingExport.current, handlers.current),
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
      transport?.dispose()
      apiRef.current = null
      // Anyone still waiting is waiting on a renderer that no longer exists.
      awaitingSave.current.abandon(new Error('The editor was closed.'))
      awaitingExport.current.abandon(new Error('The editor was closed.'))
    }
  }, [apiBase, documentId, locale, token, commands, generation])

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
   * Every command goes the way ⌘S goes: `onMenuAction`, which upstream's
   * native menu drives on the desktop and the host drives here. The renderer
   * subscribes as part of its boot effect, so a command issued before it is
   * listening would be dropped -- hence the wait.
   */
  const dispatch = useCallback(
    async (action: MenuAction): Promise<void> => {
      if (!commands.connected) await waitFor(() => commands.connected, 'The editor is still opening.')
      commands.dispatch(action)
    },
    [commands],
  )

  useImperativeHandle(
    props.ref,
    (): SheetsHandle => ({
      async save() {
        // Upstream's save returns early, silently, when the journal is empty
        // (`appNoEditsToSave`). Answering that here rather than waiting for a
        // request that will never be made is the difference between a no-op
        // and a hung promise.
        if (pendingEditsRef.current === 0) return
        const landed = awaitingSave.current.next()
        await dispatch('save')
        return landed
      },
      async exportBytes() {
        const exported = awaitingExport.current.next()
        await dispatch('save-as')
        return exported
      },
      async exportCsv() {
        await dispatch('export-csv')
      },
      async reload() {
        setReady(false)
        setGeneration((current) => current + 1)
      },
      pendingEdits: () => pendingEditsRef.current,
    }),
    [dispatch, props.ref],
  )

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

/**
 * One-shot waiters for a command whose result arrives later, on another path.
 *
 * `save()` and `exportBytes()` both drive the renderer through a fire-and-
 * forget event and learn the outcome from the traffic it produces. Queueing
 * the waiters rather than keeping one means a host that calls twice gets two
 * answers instead of one lost promise.
 */
interface Waiters<T> {
  next(): Promise<T>
  settle(value: T): void
  fail(error: Error): void
  /** The editor is gone; reject everyone still queued. */
  abandon(error: Error): void
  /** True while someone is waiting, so an unprompted result can be routed elsewhere. */
  readonly pending: boolean
}

/**
 * Long enough for part surgery on a large workbook over a slow link. This is
 * a stuck-promise backstop, not a budget: the renderer has several early
 * returns (a refused CSV format prompt, an unreadable sheet order) that end a
 * save without ever reaching the server, and a host awaiting one of those
 * would otherwise wait forever.
 */
const COMMAND_TIMEOUT_MS = 120_000

function createWaiters<T>(): Waiters<T> {
  const queue: { resolve: (value: T) => void; reject: (error: Error) => void; timer: number }[] = []
  const shift = () => queue.shift()
  return {
    next() {
      return new Promise<T>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: window.setTimeout(() => {
            const index = queue.indexOf(entry)
            if (index >= 0) queue.splice(index, 1)
            reject(new Error('The editor did not answer the command.'))
          }, COMMAND_TIMEOUT_MS),
        }
        queue.push(entry)
      })
    },
    settle(value) {
      const entry = shift()
      if (!entry) return
      window.clearTimeout(entry.timer)
      entry.resolve(value)
    },
    fail(error) {
      const entry = shift()
      if (!entry) return
      window.clearTimeout(entry.timer)
      entry.reject(error)
    },
    abandon(error) {
      while (queue.length > 0) this.fail(error)
    },
    get pending() {
      return queue.length > 0
    },
  }
}

/** Poll a condition the renderer sets from outside React. */
async function waitFor(ready: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => window.setTimeout(resolve, 25))
  }
}

/**
 * State the component keeps for itself, read off the same traffic the host
 * events are derived from.
 */
function trackLocally(
  event: { method: string; args: readonly unknown[]; result?: unknown; error?: unknown },
  pendingEdits: { current: number },
  awaiting: { save: Waiters<void>; export: Waiters<SheetsExport> },
): void {
  if (event.method === 'notifyPendingEdits' && !event.error) {
    const [count] = event.args
    pendingEdits.current = typeof count === 'number' ? count : 0
    return
  }
  if (event.method !== 'saveWorkbookEdits') return
  // A save-as answers the export queue; deliverExport settles it on success,
  // so only the failure is this function's to report. Nothing reaches
  // deliverExport when the assembly or the fetch threw.
  const [request] = event.args as [{ mode?: string } | undefined]
  const queue: Waiters<unknown> = request?.mode === 'save-as' ? awaiting.export : awaiting.save
  if (event.error) {
    queue.fail(event.error instanceof Error ? event.error : new Error(String(event.error)))
    return
  }
  if (request?.mode !== 'save-as') awaiting.save.settle(undefined)
}

/**
 * A Save As came back with bytes.
 *
 * Whoever asked gets them: `exportBytes()` if a caller is waiting, the host's
 * `onSaveAsRequest` otherwise -- which is how the ribbon's own Save As button
 * reaches a host that never called the handle.
 */
function deliverExport(
  exported: ExportedWorkbook,
  awaitingExport: Waiters<SheetsExport>,
  handlers: SheetsEditorProps,
): void {
  const event: SheetsExport = {
    bytes: exported.bytes,
    suggestedName: exported.suggestedName,
    touchedEntries: exported.touchedEntries,
  }
  if (awaitingExport.pending) {
    awaitingExport.settle(event)
    return
  }
  handlers.onSaveAsRequest?.(event)
}
