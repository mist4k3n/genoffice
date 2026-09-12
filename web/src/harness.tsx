import { useState } from 'react'
import ReactDOM from 'react-dom/client'

import { SheetsEditor } from './embed/SheetsEditor'
import type { SheetsSelection } from './embed/host-api'
import type { UiTheme } from '../../apps/sheets/src/shared/desktop-api'

/**
 * A host harness shaped like Papan, so the embedding hazards show up here
 * rather than in their codebase.
 *
 * Three things it deliberately reproduces:
 *
 *  - **Tabs stay mounted and are hidden with `display: none`.** Papan's shell
 *    does this to decks and does not remount them, which means a mount-time
 *    effect runs once ever and a canvas in a hidden subtree measures zero.
 *  - **Theme comes from the host**, applied to a container rather than `<html>`.
 *  - **Two documents open at once**, which is what a tab bar means and what
 *    upstream's single-window model was never asked to do.
 *
 *   npm run harness      # with `npm run serve` on :5274
 */

const API = (import.meta.env.VITE_SHEETS_API as string | undefined) ?? 'http://127.0.0.1:5274'

interface Tab {
  readonly id: string
  readonly documentId: string
}

function Harness(): React.JSX.Element {
  const params = new URLSearchParams(location.search)
  const docs = (params.get('docs') ?? 'acme-budget.xlsx,gamma-sales.xlsx').split(',')
  // Active-only is the supported mode. `?mount=all` demonstrates the refusal.
  const mountAll = params.get('mount') === 'all'

  const [tabs] = useState<Tab[]>(docs.map((documentId, i) => ({ id: `tab-${i}`, documentId })))
  const [active, setActive] = useState(0)
  const [theme, setTheme] = useState<UiTheme>('light')
  const [log, setLog] = useState<string[]>([])

  const note = (line: string) =>
    setLog((previous) => [`${new Date().toLocaleTimeString()}  ${line}`, ...previous].slice(0, 40))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', font: '13px system-ui' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid #ccc', alignItems: 'center' }}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            onClick={() => setActive(index)}
            style={{ fontWeight: index === active ? 700 : 400, padding: '4px 10px' }}
          >
            {tab.documentId}
          </button>
        ))}
        <span style={{ marginLeft: 'auto' }}>
          theme{' '}
          <select value={theme} onChange={(e) => setTheme(e.target.value as UiTheme)}>
            <option value="light">light</option>
            <option value="dark">dark</option>
            <option value="system">system</option>
          </select>
        </span>
        <span style={{ opacity: 0.6 }}>
          {mountAll ? 'all tabs mounted — expect a refusal' : 'active tab only (supported)'}
        </span>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {tabs.map((tab, index) => {
          const visible = index === active
          if (!mountAll && !visible) return null
          return (
            <div
              key={tab.id}
              // The hazard, reproduced exactly: hidden, not unmounted.
              style={{ display: visible ? 'flex' : 'none', position: 'absolute', inset: 0 }}
            >
              <SheetsEditor
                documentId={tab.documentId}
                apiBase={API}
                theme={theme}
                visible={visible}
                onLoaded={(file) => note(`${tab.documentId}: loaded, ${file.sheets.length} sheet(s)`)}
                onDirtyChange={(n) => note(`${tab.documentId}: ${n} pending edit(s)`)}
                onSaved={(e) =>
                  note(`${tab.documentId}: SAVED, rewrote [${e.touchedEntries.join(', ') || 'nothing'}]`)
                }
                onConflict={(e) =>
                  note(`${tab.documentId}: CONFLICT, current version ${e.currentVersion}`)
                }
                onSelectionChange={(s: SheetsSelection | null) =>
                  note(`${tab.documentId}: selection ${s ? `${s.sheetName}!${s.range}` : 'none'}`)
                }
                onError={(error) => note(`${tab.documentId}: ERROR ${error.message}`)}
              />
            </div>
          )
        })}
      </div>

      <pre
        id="harness-log"
        style={{ margin: 0, height: 120, overflow: 'auto', background: '#111', color: '#9f9', padding: 8, fontSize: 11 }}
      >
        {log.join('\n')}
      </pre>
    </div>
  )
}

const root = document.getElementById('harness-root')
if (!root) throw new Error('Missing harness root.')
ReactDOM.createRoot(root).render(<Harness />)
