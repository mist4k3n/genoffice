import { useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'

import { SheetsEditor } from './embed/SheetsEditor'
import type {
  SheetsConflictEvent,
  SheetsExport,
  SheetsHandle,
  SheetsSelection,
} from './embed/host-api'
import type { HostTheme } from './embed/theme'

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
  const mountAll = params.get('mount') !== 'active'
  // `?readonly=all`, or a comma-separated list of tab indices. A list is what
  // makes the interesting case reachable: one viewer and one editor on the
  // page at once, which is what the conflict banner's compare view produces.
  const readOnlyParam = params.get('readonly') ?? ''
  const readOnlyTabs = new Set(readOnlyParam.split(',').filter(Boolean))
  const isReadOnly = (index: number): boolean =>
    readOnlyTabs.has('all') || readOnlyTabs.has(String(index))

  const [tabs] = useState<Tab[]>(docs.map((documentId, i) => ({ id: `tab-${i}`, documentId })))
  // One handle per tab, the way a host keeps a ref per open editor.
  const handles = useRef(new Map<string, SheetsHandle | null>())
  const [active, setActive] = useState(0)
  const [theme, setTheme] = useState<HostTheme>('light')
  // Papan's four, in the shapes it actually sends.
  const [locale, setLocale] = useState('en')
  const [log, setLog] = useState<string[]>([])
  // Papan's ConflictBanner state, reproduced: which tabs are conflicted, and
  // which of them is showing the stored version beside its own edits.
  const [conflicts, setConflicts] = useState<Record<string, SheetsConflictEvent>>({})
  const [comparing, setComparing] = useState<Record<string, boolean>>({})

  const note = (line: string) =>
    setLog((previous) => [`${new Date().toLocaleTimeString()}  ${line}`, ...previous].slice(0, 40))

  /**
   * The host half of Save As: the editor produces bytes, the host decides
   * where they go. Papan passes them to its picker's `customSave`; a browser
   * harness has no VFS, so a download is the honest equivalent.
   */
  async function saveAs(tabId: string | undefined): Promise<void> {
    const handle = tabId ? handles.current.get(tabId) : null
    if (!handle) return note('no editor to export')
    try {
      note('export requested…')
      receive(await handle.exportBytes(), 'handle.exportBytes()')
    } catch (error) {
      note(`EXPORT FAILED ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The rest of the handle, so the harness exercises all of it. */
  async function command(
    tabId: string | undefined,
    name: 'save' | 'reload',
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const handle = tabId ? handles.current.get(tabId) : null
    if (!handle) return note(`no editor to ${name}`)
    try {
      note(`${name}${options?.overwrite ? ' (overwrite)' : ''} requested (${handle.pendingEdits()} pending)…`)
      if (name === 'save') await handle.save(options)
      else await handle.reload()
      note(`${name} done`)
      // The banner clears on a resolution, never on its own: a conflict the
      // user has not answered must not disappear because time passed.
      if (tabId) clearConflict(tabId)
    } catch (error) {
      note(`${name.toUpperCase()} FAILED ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function clearConflict(tabId: string): void {
    setConflicts(({ [tabId]: _gone, ...rest }) => rest)
    setComparing((current) => ({ ...current, [tabId]: false }))
  }

  /**
   * Papan's three buttons, and nothing more: keep-mine is dismissing the
   * banner, overwrite is a save that wins, show-saved-version is a second
   * read-only editor on the stored bytes.
   */
  function ConflictBanner({ tabId }: { tabId: string }): React.JSX.Element | null {
    const conflict = conflicts[tabId]
    if (!conflict) return null
    return (
      <div
        style={{
          display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px',
          background: '#fff4e5', borderBottom: '1px solid #f0b37e', fontSize: 12,
        }}
      >
        <strong>This document changed elsewhere.</strong>
        <span style={{ opacity: 0.75 }}>
          now at {conflict.currentVersion.slice(0, 12)} · {conflict.pendingEdits} unsaved edit(s) ·
          {' '}{conflict.source}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => clearConflict(tabId)}>Keep mine</button>
          <button onClick={() => void command(tabId, 'save', { overwrite: true })}>Overwrite</button>
          <button onClick={() => void command(tabId, 'reload')}>Discard mine</button>
          <button onClick={() => setComparing((c) => ({ ...c, [tabId]: !c[tabId] }))}>
            {comparing[tabId] ? 'Hide saved version' : 'Show saved version'}
          </button>
        </span>
      </div>
    )
  }

  function receive(exported: SheetsExport, via: string): void {
    note(
      `export via ${via}: ${exported.bytes.byteLength} bytes, ` +
        `rewrote [${exported.touchedEntries.join(', ') || 'nothing'}]`,
    )
    const url = URL.createObjectURL(new Blob([exported.bytes as unknown as BlobPart]))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = exported.suggestedName.replace(/\.xlsx$/i, ' (copy).xlsx')
    anchor.click()
    URL.revokeObjectURL(url)
  }

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
        <button onClick={() => void command(tabs[active]?.id, 'save')}>Save</button>
        <button onClick={() => void saveAs(tabs[active]?.id)}>Save As…</button>
        <button onClick={() => void command(tabs[active]?.id, 'reload')}>Reload</button>
        <span style={{ marginLeft: 'auto' }}>
          theme{' '}
          <select value={theme} onChange={(e) => setTheme(e.target.value as HostTheme)}>
            <option value="light">light</option>
            <option value="dark">dark</option>
            <option value="dim">dim</option>
            <option value="system">system</option>
          </select>{' '}
          locale{' '}
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="en">en</option>
            <option value="zh-CN">zh-CN</option>
            <option value="zh-TW">zh-TW</option>
            <option value="ms-MY">ms-MY</option>
          </select>
        </span>
        <span style={{ opacity: 0.6 }}>
          {mountAll ? 'all tabs mounted (Papan-shaped)' : 'active tab only'}
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
              style={{
                display: visible ? 'flex' : 'none',
                flexDirection: 'column',
                position: 'absolute',
                inset: 0,
              }}
            >
              <ConflictBanner tabId={tab.id} />
              <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
              <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
              <SheetsEditor
                ref={(handle) => void handles.current.set(tab.id, handle)}
                documentId={tab.documentId}
                apiBase={API}
                theme={theme}
                locale={locale}
                visible={visible}
                readOnly={isReadOnly(index)}
                onLoaded={(file) =>
                  note(
                    `${tab.documentId}: loaded, ${file.sheets.length} sheet(s)` +
                      `${file.readOnly ? ' (read-only)' : ''}`,
                  )
                }
                onDirtyChange={(n) => note(`${tab.documentId}: ${n} pending edit(s)`)}
                onSaved={(e) =>
                  note(`${tab.documentId}: SAVED, rewrote [${e.touchedEntries.join(', ') || 'nothing'}]`)
                }
                onConflict={(e) => {
                  note(`${tab.documentId}: CONFLICT (${e.source}) at ${e.currentVersion}`)
                  setConflicts((current) => ({ ...current, [tab.id]: e }))
                }}
                onSelectionChange={(s: SheetsSelection | null) =>
                  note(`${tab.documentId}: selection ${s ? `${s.sheetName}!${s.range}` : 'none'}`)
                }
                onSaveAsRequest={(exported) => receive(exported, 'ribbon Save As')}
                onDraftRestored={() =>
                  note(`${tab.documentId}: restored unsaved work — DIRTY before any edit`)
                }
                onError={(error) => note(`${tab.documentId}: ERROR ${error.message}`)}
              />
              </div>
              {comparing[tab.id] ? (
                // "Show saved version": a second editor on the same document,
                // opened read-only, so the stored bytes sit beside the dirty
                // ones. It is a fresh session, so it reads what storage holds
                // now rather than what this tab has pending.
                <div style={{ flex: 1, display: 'flex', minWidth: 0, borderLeft: '2px solid #f0b37e' }}>
                  <SheetsEditor
                    // Two grids on screen at once, which is the one case that
                    // needs a second realm: Univer's internal editor hosts
                    // carry fixed element ids and collide otherwise.
                    isolate
                    documentId={tab.documentId}
                    apiBase={API}
                    theme={theme}
                    locale={locale}
                    visible={visible}
                    readOnly
                    onLoaded={(file) =>
                      note(`${tab.documentId}: saved version mounted (isolated), readOnly=${file.readOnly}`)
                    }
                    onError={(error) => note(`${tab.documentId} (saved): ERROR ${error.message}`)}
                  />
                </div>
              ) : null}
              </div>
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
