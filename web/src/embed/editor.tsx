import { lazy, Suspense } from 'react'

import { IsolatedSheets } from './IsolatedSheets'
import type { SheetsEditorProps } from './host-api'

/**
 * The spreadsheet as a mountable React component, and the package's entry
 * point.
 *
 * ## Why the editor arrives late
 *
 * The renderer is 12 MB, 3 MB gzipped, and that is the editor itself rather
 * than anything removable -- Univer's locales are already split per language.
 * A host that imports this package from its app shell would otherwise pay all
 * of it on every page, including the pages with no spreadsheet on them
 * (PAPAN-INTEGRATION.md, A4).
 *
 * So the inline editor is behind a dynamic import, and this module holds
 * nothing heavier than the iframe path. Importing the package costs a few
 * kilobytes; the editor's chunks are fetched when an editor first mounts. A
 * host that also lazy-routes the import gets the same result and does not need
 * to -- the split is here so that forgetting it is not a 3 MB mistake.
 *
 * `isolate` stays eager because it is the light half: an iframe and a
 * postMessage protocol. The weight in that case lives in the frame's own page.
 *
 * ## Several editors on one page
 *
 * Each editor gets its own host bridge, passed to upstream's `App` as a prop
 * rather than read from `window.desktopApi`, and its own grid container id.
 * Both are upstream changes, recorded in `web/UPSTREAM-CHANGES.md`, and both
 * exist so that two editors on one page address two different things.
 */
const InlineSheets = lazy(async () => {
  const module = await import('./SheetsEditor')
  return { default: module.InlineSheets }
})

export function SheetsEditor(props: SheetsEditorProps): React.JSX.Element {
  // A dispatcher with no hooks of its own, so flipping `isolate` remounts --
  // which is the only correct answer, since the two run in different realms.
  if (props.isolate) return <IsolatedSheets {...props} />
  return (
    // The host is not required to bring its own Suspense boundary, and should
    // not have to: a spreadsheet arriving is this component's business. The
    // fallback claims the same space the grid will and paints nothing, so a
    // host's own background shows through and no theme decision is made here.
    <Suspense fallback={<div data-sheets-loading style={{ flex: 1, minWidth: 0 }} />}>
      <InlineSheets {...props} />
    </Suspense>
  )
}
