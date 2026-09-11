import type { DesktopApi } from '../../apps/sheets/src/shared/desktop-api'

/**
 * Phase-00 instrumented stub of the Sheets host bridge.
 *
 * The point is not to make the app work — it is to find out, empirically, which
 * of the ~59 DesktopApi methods the renderer actually touches to reach a usable
 * shell, and in what order. That list is the implementation order for phase 01;
 * guessing it from the interface would over- or under-shoot.
 *
 * Every access is recorded. Read the result in the console with
 * `__desktopApiCalls()` or watch the live table the spike page renders.
 */

export interface StubCall {
  readonly seq: number
  readonly method: string
  readonly kind: 'invoke' | 'subscribe'
  readonly at: number
  readonly args: unknown
  /** false when the stub had no override and returned a rejected promise */
  readonly answered: boolean
}

const calls: StubCall[] = []
let seq = 0

/** Methods whose name starts with `on` are event subscriptions: they are called
 *  synchronously and must return an unsubscribe function, not a promise. */
const isSubscription = (method: string) => /^on[A-Z]/.test(method)

/**
 * The minimum the renderer needs to get past bootstrap without the app deciding
 * it is in an error state. Deliberately small — anything not listed here shows
 * up in the call log as an unanswered call, which is the data we want.
 */
const overrides: Partial<Record<keyof DesktopApi, unknown>> = {
  getLanguage: () => Promise.resolve('en'),
  getTheme: () => Promise.resolve('system'),
  getAutoSaveDefault: () => Promise.resolve(false),
  getAiPanelPrefs: () => Promise.resolve({}),
}

function record(method: string, kind: StubCall['kind'], args: unknown, answered: boolean): void {
  calls.push({ seq: seq++, method, kind, at: Math.round(performance.now()), args, answered })
  window.dispatchEvent(new CustomEvent('stub-desktop-api:call'))
}

class StubNotImplemented extends Error {
  constructor(method: string) {
    super(`[spike] desktopApi.${method}() is not implemented by the phase-00 stub`)
    this.name = 'StubNotImplemented'
  }
}

export function createStubDesktopApi(): DesktopApi {
  const cache = new Map<string, unknown>()

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      const cached = cache.get(property)
      if (cached) return cached

      const override = overrides[property as keyof DesktopApi]

      const fn = isSubscription(property)
        ? (...args: unknown[]) => {
            record(property, 'subscribe', args, true)
            return () => {}
          }
        : (...args: unknown[]) => {
            if (typeof override === 'function') {
              record(property, 'invoke', args, true)
              return (override as (...a: unknown[]) => unknown)(...args)
            }
            record(property, 'invoke', args, false)
            return Promise.reject(new StubNotImplemented(property))
          }

      cache.set(property, fn)
      return fn
    },
    has: () => true,
  }

  return new Proxy({}, handler) as unknown as DesktopApi
}

/** Install on `window`. `env.d.ts` declares the property readonly, so this is
 *  the one place a cast is warranted rather than a type change upstream. */
export function installStubDesktopApi(): void {
  Object.defineProperty(window, 'desktopApi', {
    value: createStubDesktopApi(),
    writable: false,
    configurable: true,
  })
  Object.defineProperty(window, '__desktopApiCalls', {
    value: () => calls.slice(),
    configurable: true,
  })
}

export const stubCalls = (): readonly StubCall[] => calls
