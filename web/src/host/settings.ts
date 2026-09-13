import type { Lang } from '../../../packages/i18n/src/index'
import type { UiTheme } from '../../../apps/sheets/src/shared/desktop-api'

/**
 * Settings the *host page* owns, not the server.
 *
 * Upstream learns its theme and language from the shell, over IPC, because on
 * the desktop the shell is the only thing that knows them. Embedded, that is
 * backwards: the host application is in the same document, its own switcher
 * has already changed, and a round trip to a server that has never heard of
 * the click is at best a stale answer.
 *
 * So the bridge keeps a local source for exactly these two values. It does not
 * replace the wire -- `app:theme-changed` is still a push channel, and a host
 * whose server really does own the theme keeps working -- it sits beside it,
 * and the renderer subscribes to both.
 *
 * Without this, `theme` and `locale` were open-time props: changing either one
 * repainted the chrome (they are React state) but never reached the renderer's
 * own listeners, so Univer's canvas and every non-React translator kept the
 * values they booted with.
 */
export interface HostSettings {
  /** Already resolved: the renderer is told what to paint, not what the switcher reads. */
  readonly theme: UiTheme
  readonly language: Lang
}

export interface HostSettingsBus {
  /** Announce a change. Values equal to the current one notify nobody. */
  publish(next: Partial<HostSettings>): void
  subscribe<K extends keyof HostSettings>(
    key: K,
    listener: (value: HostSettings[K]) => void,
  ): () => void
  current<K extends keyof HostSettings>(key: K): HostSettings[K]
}

export function createHostSettingsBus(initial: HostSettings): HostSettingsBus {
  const values: HostSettings = { ...initial }
  const listeners: { [K in keyof HostSettings]: Set<(value: HostSettings[K]) => void> } = {
    theme: new Set(),
    language: new Set(),
  }

  return {
    publish(next) {
      for (const key of Object.keys(next) as (keyof HostSettings)[]) {
        const value = next[key]
        if (value === undefined || value === values[key]) continue
        // A host re-render passes the same props again; only a real change is
        // an event, or every render would retranslate and repaint the canvas.
        Object.assign(values, { [key]: value })
        for (const listener of listeners[key]) {
          ;(listener as (value: HostSettings[keyof HostSettings]) => void)(value)
        }
      }
    },
    subscribe(key, listener) {
      const set = listeners[key] as Set<(value: HostSettings[typeof key]) => void>
      set.add(listener)
      return () => void set.delete(listener)
    },
    current: (key) => values[key],
  }
}

/**
 * Which push channels have a host-side source as well as a wire one.
 *
 * Keyed by DesktopApi method name so the bridge's build loop can stay generic
 * -- the alternative is two more special cases beside `notifyPendingEdits`.
 */
export const HOST_SOURCED_PUSH: Partial<Record<string, keyof HostSettings>> = {
  onThemeChanged: 'theme',
  onLanguageChanged: 'language',
}
