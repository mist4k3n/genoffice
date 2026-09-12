import type { DesktopApi, MenuAction } from '../../../apps/sheets/src/shared/desktop-api'
import { DRAFT_RESTORED_KEY, exportPath, type WorkbookSaveExportResult } from '../../protocol'
import type { HostCommandBus } from './commands'
import { COVERAGE, type Entry } from './coverage'
import { LOCAL_HANDLERS } from './local-api'
import { createRangePrefetcher, type RangePrefetcher } from './range-prefetch'
import type { UnsavedGuard } from './unsaved-guard'
import { createHttpTransport, type HostTransport, type HttpTransportOptions } from './transport'

/**
 * `window.desktopApi`, implemented over HTTP + WebSocket instead of Electron IPC.
 *
 * The renderer is imported unmodified and cannot tell the difference: the
 * methods have the same names, the same shapes, and subscriptions still return
 * an unsubscribe function synchronously.
 *
 * Coverage is driven by the COVERAGE table rather than 59 hand-written stubs —
 * that table is `Record<keyof DesktopApi, …>`, so it fails to compile the
 * moment upstream changes the contract.
 */

export class NotImplementedError extends Error {
  readonly method: string
  /** null for methods the Electron preload answers without an IPC channel. */
  readonly channel: string | null

  constructor(method: string, entry: Entry) {
    const note = entry.note ? ` (${entry.note})` : ''
    const where = entry.channel ? ` — channel ${entry.channel}` : ''
    super(`desktopApi.${method}() is not implemented yet${where}${note}`)
    this.name = 'NotImplementedError'
    this.method = method
    this.channel = entry.channel
  }
}

export interface HttpDesktopApiOptions extends HttpTransportOptions {
  /**
   * Called whenever the renderer reaches a method that is not implemented yet.
   * Phase 01 uses this to keep the probe panel honest; later phases can route
   * it at telemetry.
   */
  readonly onNotImplemented?: ((method: string, entry: Entry) => void) | undefined
  /**
   * Watches `notifyPendingEdits` so a tab close with unsaved work warns first.
   * The call still goes to the server, which uses the count for its own idle
   * accounting; this only observes it on the way past.
   */
  readonly unsavedGuard?: UnsavedGuard | undefined
  /**
   * Read ahead in the scroll direction. Off by default: it is a latency
   * optimisation for real networks and pure overhead against a local server.
   */
  readonly prefetchRanges?: boolean | undefined
  /**
   * Sees every HTTP call and its outcome, so a host can derive its own UI
   * state (loaded, saved, conflicted) without the renderer knowing a host
   * exists. Read-only: it cannot change what the renderer receives.
   */
  readonly observer?: HostObserver | undefined
  /**
   * How the embedding application drives the renderer -- its Save As button,
   * its keyboard shortcuts. Absent in a standalone page, where the renderer's
   * own ribbon is the only chrome.
   */
  readonly commands?: HostCommandBus | undefined
  /**
   * Receives the bytes a Save As produced. Called for every save-as,
   * whoever started it: the host's own command, or the ribbon's Save As
   * button, which a user can click at any time.
   */
  readonly onExport?: ((event: ExportedWorkbook) => void) | undefined
}

/** A Save As, resolved to bytes the host can write wherever it likes. */
export interface ExportedWorkbook {
  readonly bytes: Uint8Array
  /** The document's own file name, to seed the host's picker. */
  readonly suggestedName: string
  /** Package parts the patch rewrote. Empty when nothing was pending. */
  readonly touchedEntries: readonly string[]
}

export interface HostObserver {
  (event: {
    readonly method: string
    readonly channel: string
    readonly args: readonly unknown[]
    readonly result?: unknown
    readonly error?: unknown
  }): void
}

/** Methods that are subscriptions: called synchronously, return an unsubscribe. */
const isSubscription = (entry: Entry) =>
  entry.status === 'push' || entry.status === 'shell' || entry.status === 'host'

export function createHttpDesktopApi(options: HttpDesktopApiOptions): DesktopApi {
  const transport = createHttpTransport(options)
  return buildDesktopApi(transport, {
    onNotImplemented: options.onNotImplemented,
    unsavedGuard: options.unsavedGuard,
    prefetchRanges: options.prefetchRanges,
    observer: options.observer,
    commands: options.commands,
    onExport: options.onExport,
  })
}

export interface BuildOptions {
  readonly onNotImplemented?: ((method: string, entry: Entry) => void) | undefined
  readonly unsavedGuard?: UnsavedGuard | undefined
  readonly prefetchRanges?: boolean | undefined
  readonly observer?: HostObserver | undefined
  readonly commands?: HostCommandBus | undefined
  readonly onExport?: ((event: ExportedWorkbook) => void) | undefined
  /**
   * The session opened from unsaved work rather than from storage.
   *
   * Worth a callback of its own because the edit journal is empty in that
   * case -- the edits are already in the bytes -- so the renderer's own
   * pending-edit count honestly reports zero for a document that differs from
   * what storage holds.
   */
  readonly onDraftRestored?: (() => void) | undefined
}

/**
 * Methods that need behaviour beyond "post the arguments at the channel".
 *
 * Kept as a named seam rather than conditionals inside the loop below: each
 * one is a deliberate deviation from the transparent shim, and they should be
 * easy to count. There are two.
 */
interface Interceptors {
  readonly unsavedGuard: UnsavedGuard | undefined
  readonly prefetcher: RangePrefetcher | undefined
  readonly observer: HostObserver | undefined
  readonly transport: HostTransport
  readonly onExport: ((event: ExportedWorkbook) => void) | undefined
  readonly commands: HostCommandBus | undefined
  readonly onDraftRestored: (() => void) | undefined
}

export function buildDesktopApi(
  transport: HostTransport,
  options: BuildOptions = {},
): DesktopApi {
  const api: Record<string, unknown> = {}
  const { onNotImplemented, unsavedGuard } = options

  // The channel comes from the coverage table, never retyped here -- a literal
  // would reintroduce exactly the drift `npm run check:channels` exists to
  // catch, and this one would only show up as a 501 while scrolling.
  const rangeChannel = COVERAGE.readWorkbookRange.channel
  const prefetcher =
    options.prefetchRanges && rangeChannel !== null
      ? createRangePrefetcher((request) => transport.invoke(rangeChannel, request))
      : undefined
  const interceptors: Interceptors = {
    unsavedGuard,
    prefetcher,
    observer: options.observer,
    transport,
    onExport: options.onExport,
    commands: options.commands,
    onDraftRestored: options.onDraftRestored,
  }

  for (const [method, entry] of Object.entries(COVERAGE)) {
    // Only 'todo' may carry a null channel. Asserting per branch rather than
    // once up front keeps the narrowing real instead of casting it away.
    const { channel } = entry
    const wire = () => {
      if (channel === null) {
        throw new Error(`COVERAGE.${method} is '${entry.status}' but declares no channel`)
      }
      return channel
    }

    switch (entry.status) {
      case 'http': {
        const target = wire()
        api[method] = observed(method, target, httpMethod(method, target, transport, interceptors), interceptors)
        break
      }

      case 'push': {
        const target = wire()
        api[method] = (listener: (...args: unknown[]) => void) =>
          transport.subscribe(target, listener)
        break
      }

      case 'local': {
        const handler = LOCAL_HANDLERS[method as keyof typeof LOCAL_HANDLERS]
        if (!handler) {
          throw new Error(`COVERAGE.${method} is 'local' but local-api.ts has no handler`)
        }
        api[method] = handler
        break
      }

      case 'shell':
        // No web source for this event. Returning a no-op unsubscribe is the
        // correct behaviour, not a placeholder: upstream's own standalone
        // renderer mode runs the same way.
        api[method] = () => () => {}
        break

      case 'host': {
        // The embedding application is the source. Without one -- a standalone
        // page, a test -- this is a 'shell' entry again, and the renderer's own
        // ribbon still works, because it calls the same handlers directly.
        const commands = options.commands
        api[method] = commands
          ? (listener: (action: MenuAction) => void) => commands.subscribe(listener)
          : () => () => {}
        break
      }

      case 'todo':
        api[method] = isSubscription(entry)
          ? () => {
              onNotImplemented?.(method, entry)
              return () => {}
            }
          : (...args: unknown[]) => {
              void args
              onNotImplemented?.(method, entry)
              return Promise.reject(new NotImplementedError(method, entry))
            }
        break
    }
  }

  // One cast, at the boundary. Everything above is driven by a table the
  // compiler has already checked covers every key of DesktopApi.
  return api as unknown as DesktopApi
}

/**
 * Report each call's outcome to the host without altering it.
 *
 * Range reads are excluded: they fire on every scroll step, and a host has no
 * use for them. Everything else is rare enough that observing it is free.
 */
function observed(
  method: string,
  channel: string,
  call: (...args: unknown[]) => Promise<unknown>,
  interceptors: Interceptors,
): (...args: unknown[]) => Promise<unknown> {
  const { observer } = interceptors
  if (!observer || method === 'readWorkbookRange') return call
  return async (...args: unknown[]) => {
    try {
      const result = await call(...args)
      observer({ method, channel, args, result })
      return result
    } catch (error) {
      observer({ method, channel, args, error })
      throw error
    }
  }
}

/** Reads that a prefetcher may answer; everything else invalidates it. */
const READ_ONLY_METHODS = new Set([
  'readWorkbookRange',
  'readWorkbookFormulas',
  'readWorkbookMedia',
  'readPivotDefinition',
  'getLanguage',
  'getTheme',
  'getAutoSaveDefault',
  'getAiPanelPrefs',
  'getAiSettings',
  'aiGskStatus',
  'hasQueuedWorkbook',
])

function httpMethod(
  method: string,
  channel: string,
  transport: HostTransport,
  interceptors: Interceptors,
): (...args: unknown[]) => Promise<unknown> {
  const { unsavedGuard, prefetcher } = interceptors

  if (method === 'notifyPendingEdits' && unsavedGuard) {
    return (...args: unknown[]) => {
      const [count] = args
      // Observed on the way past, not intercepted: the server still gets the
      // count for its own idle accounting.
      unsavedGuard.setPendingEdits(typeof count === 'number' ? count : 0)
      return transport.invoke(channel, ...args)
    }
  }

  if (method === 'saveWorkbookEdits') {
    return saveOrExport(channel, transport, interceptors)
  }

  if (method === 'selectWorkbook') {
    return openWorkbook(channel, transport, interceptors)
  }

  if (method === 'readWorkbookRange' && prefetcher) {
    return (...args: unknown[]) =>
      prefetcher.read(args[0] as Parameters<RangePrefetcher['read']>[0])
  }

  if (prefetcher && !READ_ONLY_METHODS.has(method)) {
    // A save, a recalc, a close -- anything that could change what a
    // speculative read would have returned.
    return (...args: unknown[]) => {
      prefetcher.invalidate()
      return transport.invoke(channel, ...args)
    }
  }

  return (...args: unknown[]) => transport.invoke(channel, ...args)
}

/**
 * Install on `window`. `apps/sheets/src/renderer/env.d.ts` declares the
 * property readonly, so defineProperty is the honest way in — changing that
 * declaration would mean editing upstream.
 */
export function installDesktopApi(api: DesktopApi): void {
  Object.defineProperty(window, 'desktopApi', {
    value: api,
    writable: false,
    configurable: true,
  })
}

/**
 * Save, or Save As -- which on the web are two different operations behind one
 * upstream method.
 *
 * A plain save writes through and comes back as upstream's result, untouched.
 * A Save As cannot write through: the destination is a document this package
 * has no port to create, and on Papan it is a tree node its own picker
 * chooses. So the server assembles the patched bytes, parks them, and answers
 * with a token; this fetches them and hands them to the host.
 *
 * What the renderer receives is `{ canceled: true }` -- upstream's own shape,
 * and the honest one. Nothing was saved to *this* document, so the journal
 * stays pending and the session keeps its identity, which is exactly what
 * upstream does for its CSV Save As (`save-actions.ts`: "the journal stays
 * pending; the session keeps its identity (a copy semantics)"). The `export`
 * half never reaches the renderer, so upstream's strict result schema stays
 * satisfied on the only side that parses it.
 */
function saveOrExport(
  channel: string,
  transport: HostTransport,
  interceptors: Interceptors,
): (...args: unknown[]) => Promise<unknown> {
  const { prefetcher, onExport, commands } = interceptors
  return async (...args: unknown[]) => {
    prefetcher?.invalidate()
    // The host's intent for *this* save, claimed from the command that started
    // it. It rides as a second argument, which upstream never sends, so the
    // request the renderer built stays exactly what its schema expects.
    const options = commands?.takeOptions() ?? {}
    const result = await transport.invoke<unknown>(
      channel,
      ...(Object.keys(options).length > 0 ? [args[0], options] : args),
    )
    if (!isExportResult(result)) return result

    const { token, name, touchedEntries } = result.export
    const bytes = await transport.fetchBytes(exportPath(token))
    // After the fetch, never before: a host told the export succeeded and then
    // handed nothing would have no way to tell which half failed.
    onExport?.({ bytes, suggestedName: name, touchedEntries })
    return { canceled: true }
  }
}

const isExportResult = (value: unknown): value is WorkbookSaveExportResult =>
  typeof value === 'object' &&
  value !== null &&
  (value as WorkbookSaveExportResult).canceled === true &&
  typeof (value as WorkbookSaveExportResult).export?.token === 'string'

/**
 * Open, minus the one field the renderer must not see.
 *
 * Upstream's `workbookFileSchema` is `.strict()` and its renderer has no
 * concept of a draft, so the marker is read here and removed. The host learns
 * what the renderer cannot tell it: the journal is empty, and the document is
 * still unsaved.
 */
function openWorkbook(
  channel: string,
  transport: HostTransport,
  interceptors: Interceptors,
): (...args: unknown[]) => Promise<unknown> {
  const { prefetcher, onDraftRestored } = interceptors
  return async (...args: unknown[]) => {
    prefetcher?.invalidate()
    const result = await transport.invoke<unknown>(channel, ...args)
    if (typeof result !== 'object' || result === null) return result
    const file = result as Record<string, unknown>
    if (file[DRAFT_RESTORED_KEY] !== true) return result
    delete file[DRAFT_RESTORED_KEY]
    onDraftRestored?.()
    return file
  }
}
