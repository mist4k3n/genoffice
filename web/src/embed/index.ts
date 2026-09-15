/**
 * The package's public surface.
 *
 * Everything a host application is allowed to depend on is named here, and
 * nothing else is reachable through the package's `exports` map. The module
 * graph behind this file reaches by relative path into
 * `apps/sheets/src/renderer` and the workspace packages, which is deliberate
 * (see PLAN.md, "SDK ergonomics without drift") and is exactly what must not
 * be visible to a consumer: the library build bundles that graph, and the
 * declaration build rolls the reachable types into one `.d.ts`, so a host writes
 *
 *     import { SheetsEditor } from '@mist4k3n/sheets-web'
 *     import '@mist4k3n/sheets-web/style.css'
 *
 * and never a path into this repository.
 *
 * `InlineSheets` is absent on purpose: it exists for `sheets-frame.html`, which
 * is served by this package rather than imported from it, and a host that
 * reaches for it instead of `isolate` gets two grids fighting over Univer's
 * fixed element ids.
 */

export { SheetsEditor } from './editor'

export type {
  SheetsConflictEvent,
  SheetsEditorProps,
  SheetsExport,
  SheetsHandle,
  SheetsHostEvents,
  SheetsSavedEvent,
  SheetsSelection,
} from './host-api'

export type { HostTheme } from './theme'

/**
 * The open document, as `onLoaded` and `onSaved` report it. Upstream's type,
 * re-exported because a host writing either handler needs to name it.
 */
export type { WorkbookFile } from '../../../apps/sheets/src/shared/desktop-api'
