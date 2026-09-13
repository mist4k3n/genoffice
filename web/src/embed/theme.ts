import type { UiTheme } from '../../../apps/sheets/src/shared/desktop-api'

/**
 * What a host may ask for, which is more than upstream has.
 *
 * Papan's own switcher offers `light` / `dim` / `dark`. `dim` has no upstream
 * counterpart and inventing one here would be guesswork: a dim palette is a
 * set of twenty-odd colour decisions that belong to whoever owns the design,
 * not a shade this package can derive. So it is accepted and resolved to
 * `dark`, and the host passes its own value through unmapped rather than
 * keeping a translation table that would drift.
 *
 * If a real dim palette ever lands, it lands as a third block in
 * `packages/ui/src/tokens.css` and one more case here -- nothing else moves.
 */
export type HostTheme = UiTheme | 'dim'

/** What the DOM is actually stamped with. `system` and `dim` both resolve. */
export type ResolvedTheme = 'light' | 'dark'

/**
 * Resolve here rather than in CSS, because the component scopes the theme to
 * its own container and `system` is not scopable: the token file answers it
 * with a `prefers-color-scheme` block guarded on `:root`, and `:root` is
 * `<html>`. A container cannot be `:root`, so nothing would define it.
 *
 * Pure, with the media query passed in, so it is testable without a DOM.
 */
export function resolveTheme(theme: HostTheme, prefersDark: boolean): ResolvedTheme {
  switch (theme) {
    case 'light':
      return 'light'
    case 'dark':
    case 'dim':
      return 'dark'
    case 'system':
      return prefersDark ? 'dark' : 'light'
  }
}

/**
 * What upstream's shared types call a theme, for the one place that still
 * speaks it: the bridge's `onThemeChanged`, whose listeners are upstream's.
 *
 * `dim` is not in that union, so it arrives there already resolved. That is
 * the honest shape -- the renderer is being told what to paint, not what the
 * host's switcher is set to.
 */
export const asUiTheme = (theme: ResolvedTheme): UiTheme => theme

export const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Subscribe to OS appearance changes. Returns a no-op where matchMedia is absent. */
export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  const query = globalThis.matchMedia?.(DARK_QUERY)
  if (!query) return () => {}
  const listener = (event: MediaQueryListEvent) => onChange(event.matches)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

export const systemPrefersDark = (): boolean => globalThis.matchMedia?.(DARK_QUERY).matches ?? false
