import { installScreenTips } from '../../../packages/ui/src/index'
import {
  installCanvasFontFallback,
  registerCellFontAliases,
} from '../../../apps/sheets/src/renderer/cell-font-fallback'

import '../../../packages/ui/src/tokens.css'
import '../../../packages/ui/src/screentip.css'
import '../../../packages/ui/src/color-picker.css'
import '../../../packages/ui/src/dropdown.css'
import '../../../packages/ui/src/ribbon-collapse.css'
import '../../../packages/ui/src/markdown.css'
import '../../../packages/ui/src/ai-panel-prefs.css'
import '../../../packages/ui/src/ai-scope-quote.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '../../../apps/sheets/src/renderer/styles.css'

/**
 * Process-wide setup, done once however many editors mount.
 *
 * Upstream does this inline in `main.tsx`, where "once" is free because there
 * is exactly one renderer per window. Here it has to be explicit: screen tips
 * install a document-level listener, and the font work is global to the page.
 */
let installed: Promise<void> | null = null

export function installGlobalsOnce(): Promise<void> {
  installed ??= install()
  return installed
}

async function install(): Promise<void> {
  installScreenTips()
  installCanvasFontFallback()
  await loadCellFonts()
}

/**
 * Canvas `fillText` never triggers an @font-face download, so the bundled
 * Carlito faces have to be loaded before Univer measures its first skeleton —
 * column widths, wrap points and #### overflow all depend on them. Upstream's
 * comment in main.tsx says the same; the timeout guards a broken bundle from
 * blanking the editor rather than being a real deadline.
 */
async function loadCellFonts(): Promise<void> {
  const loads: Promise<unknown>[] = [registerCellFontAliases()]
  for (const variant of ['', 'bold ', 'italic ', 'italic bold ']) {
    for (const family of ['Calibri', 'Aptos', "'Aptos Narrow'", 'Carlito']) {
      loads.push(document.fonts?.load?.(`${variant}16px ${family}`)?.catch(() => {}) ?? [])
    }
  }
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))])
}
