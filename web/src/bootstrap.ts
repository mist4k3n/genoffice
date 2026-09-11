import { createHttpDesktopApi, installDesktopApi } from './host/desktop-api'
import { COVERAGE, coverageSummary } from './host/coverage'
import { installStubDesktopApi, stubCalls } from './stub-desktop-api'
import { installUnsavedGuard } from './host/unsaved-guard'
import { mountProbe, recordNotImplemented } from './probe-panel'

/**
 * Browser entry for GenOffice Sheets.
 *
 * Order is the whole point: the host bridge must exist on `window` before
 * upstream's main.tsx is evaluated, because that module reads
 * `window.desktopApi` during its own bootstrap. A static import would be
 * hoisted above these statements, so the import is dynamic and awaited.
 *
 * Nothing here modifies upstream code.
 */

const apiBase = import.meta.env.VITE_SHEETS_API as string | undefined

if (apiBase) {
  installDesktopApi(
    createHttpDesktopApi({
      baseUrl: apiBase,
      documentId: new URLSearchParams(location.search).get('doc') ?? undefined,
      onNotImplemented: recordNotImplemented,
      // Closing a tab with pending edits must not lose them silently; the
      // desktop's close-save prompt has no web counterpart.
      unsavedGuard: installUnsavedGuard(),
      // Opt-in: worth it across a real network, pure overhead against a
      // server on localhost. See range-prefetch.ts for the measurement.
      prefetchRanges: import.meta.env.VITE_SHEETS_PREFETCH === '1',
    }),
  )
  const counts = coverageSummary()
  console.info(
    `[host] HTTP bridge → ${apiBase} — ${counts.http} invoke, ${counts.push} push, ` +
      `${counts.shell} shell no-op, ${counts.todo} not yet implemented`,
  )
} else {
  // No server configured: fall back to the phase-00 instrumented stub so the
  // shell still renders and the probe still reports the boot surface.
  installStubDesktopApi()
  console.info('[host] no VITE_SHEETS_API set — using the phase-00 stub. Run `npm run mock`.')
}

mountProbe(stubCalls, COVERAGE)

const started = performance.now()

try {
  await import('../../apps/sheets/src/renderer/main')
  console.info(`[spike] renderer module evaluated in ${Math.round(performance.now() - started)}ms`)
} catch (error) {
  console.error('[spike] renderer failed to load', error)
  const root = document.getElementById('root')
  if (root) {
    root.textContent = `Renderer failed to load: ${String(error)}`
    root.setAttribute('style', 'padding:24px;font:14px/1.5 system-ui;color:#b00')
  }
}
