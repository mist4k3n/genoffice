import type { DesktopApi } from '../../../apps/sheets/src/shared/desktop-api'
import { COVERAGE, type Entry } from './coverage'
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
}

/** Methods that are subscriptions: called synchronously, return an unsubscribe. */
const isSubscription = (entry: Entry) => entry.status === 'push' || entry.status === 'shell'

export function createHttpDesktopApi(options: HttpDesktopApiOptions): DesktopApi {
  const transport = createHttpTransport(options)
  return buildDesktopApi(transport, options.onNotImplemented)
}

export function buildDesktopApi(
  transport: HostTransport,
  onNotImplemented?: (method: string, entry: Entry) => void,
): DesktopApi {
  const api: Record<string, unknown> = {}

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
        api[method] = (...args: unknown[]) => transport.invoke(target, ...args)
        break
      }

      case 'push': {
        const target = wire()
        api[method] = (listener: (...args: unknown[]) => void) =>
          transport.subscribe(target, listener)
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
