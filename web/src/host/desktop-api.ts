import type { DesktopApi } from '../../../apps/sheets/src/shared/desktop-api'
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
}

/** Methods that are subscriptions: called synchronously, return an unsubscribe. */
const isSubscription = (entry: Entry) => entry.status === 'push' || entry.status === 'shell'

export function createHttpDesktopApi(options: HttpDesktopApiOptions): DesktopApi {
  const transport = createHttpTransport(options)
  return buildDesktopApi(transport, {
    onNotImplemented: options.onNotImplemented,
    unsavedGuard: options.unsavedGuard,
    prefetchRanges: options.prefetchRanges,
  })
}

export interface BuildOptions {
  readonly onNotImplemented?: ((method: string, entry: Entry) => void) | undefined
  readonly unsavedGuard?: UnsavedGuard | undefined
  readonly prefetchRanges?: boolean | undefined
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
  const interceptors: Interceptors = { unsavedGuard, prefetcher }

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
        api[method] = httpMethod(method, target, transport, interceptors)
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
