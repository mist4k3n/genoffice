import type { DesktopApi } from '../../apps/sheets/src/shared/desktop-api'
import type { Entry, Status } from './host/coverage'
import type { StubCall } from './stub-desktop-api'

/**
 * Development overlay: which DesktopApi methods the renderer reaches, and which
 * of them this host can answer yet.
 *
 * In phase 00 this recorded the boot surface. It now doubles as the working
 * checklist for phase 01 — anything that shows up unimplemented is a method the
 * renderer actually wants, ranked by the app itself rather than guessed.
 *
 * Plain DOM in a shadow root on purpose: it must not share React, CSS or a
 * theme with the app under test.
 */

interface Miss {
  readonly method: string
  readonly channel: string | null
  readonly note: string | undefined
  count: number
}

const misses = new Map<string, Miss>()

export function recordNotImplemented(method: string, entry: Entry): void {
  const existing = misses.get(method)
  if (existing) existing.count += 1
  else misses.set(method, { method, channel: entry.channel, note: entry.note, count: 1 })
  window.dispatchEvent(new CustomEvent('host:not-implemented'))
}

const STATUS_ORDER: Status[] = ['http', 'push', 'local', 'shell', 'todo']
const STATUS_LABEL: Record<Status, string> = {
  http: 'invoke',
  push: 'push',
  local: 'browser-local',
  shell: 'shell no-op',
  todo: 'not implemented',
}

export function mountProbe(
  readCalls: () => readonly StubCall[],
  coverage: Record<keyof DesktopApi, Entry>,
): void {
  const host = document.createElement('div')
  host.id = 'sheets-host-probe'
  const shadow = host.attachShadow({ mode: 'open' })

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
        width: 340px; max-height: 46vh; display: flex; flex-direction: column;
        font: 11px/1.45 ui-monospace, Menlo, monospace;
        background: #10120f; color: #d8ded6;
        border: 1px solid #2e342f; border-radius: 4px;
        box-shadow: 0 6px 24px rgba(0,0,0,.45);
      }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 9px; border-bottom: 1px solid #2e342f; flex: none;
      }
      h1 { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #8d968c; }
      .spacer { margin-left: auto; }
      button {
        font: inherit; background: #1b1f1c; color: #d8ded6;
        border: 1px solid #2e342f; border-radius: 3px; padding: 2px 7px; cursor: pointer;
      }
      button:hover { background: #232823; }
      button[aria-pressed="true"] { background: #1b3330; color: #5cc0a6; border-color: #2f5750; }
      .bars { display: flex; gap: 1px; padding: 7px 9px; border-bottom: 1px solid #2e342f; flex: none; }
      .bar { height: 5px; border-radius: 1px; }
      .bar.http { background: #5cc0a6; } .bar.push { background: #8ab6d6; }
      .bar.local { background: #b6a8d6; }
      .bar.shell { background: #5d655c; } .bar.todo { background: #e08a66; }
      .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 0 9px 7px; font-size: 10px; color: #5d655c; border-bottom: 1px solid #2e342f; flex: none; }
      .legend b { font-weight: 400; }
      .legend .http { color: #5cc0a6; } .legend .push { color: #8ab6d6; }
      .legend .local { color: #b6a8d6; }
      .legend .shell { color: #8d968c; } .legend .todo { color: #e08a66; }
      ol { margin: 0; padding: 4px 0; list-style: none; overflow-y: auto; flex: 1 1 auto; }
      li { display: flex; gap: 7px; padding: 2px 9px; align-items: baseline; }
      li + li { border-top: 1px solid #191d1a; }
      .n { color: #5d655c; font-variant-numeric: tabular-nums; min-width: 18px; text-align: right; }
      .m { flex: 1 1 auto; word-break: break-all; }
      .t { color: #5d655c; font-variant-numeric: tabular-nums; }
      .ok .m { color: #d8ded6; } .miss .m { color: #e08a66; } .sub .m { color: #8ab6d6; }
      .empty { padding: 10px 9px; color: #5d655c; }
      .note { color: #5d655c; }
    </style>
    <div class="panel">
      <header>
        <h1>host probe</h1>
        <span class="spacer"></span>
        <button id="tab-misses" aria-pressed="true">missing</button>
        <button id="tab-calls" aria-pressed="false">calls</button>
        <button id="copy">copy</button>
      </header>
      <div class="bars" id="bars"></div>
      <div class="legend" id="legend"></div>
      <ol id="list"><li class="empty">nothing yet</li></ol>
    </div>
  `

  const entries = Object.entries(coverage) as [string, Entry][]
  const counts: Record<Status, number> = { http: 0, push: 0, shell: 0, local: 0, todo: 0 }
  for (const [, entry] of entries) counts[entry.status] += 1
  const total = entries.length

  const bars = shadow.getElementById('bars')!
  bars.innerHTML = STATUS_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `<span class="bar ${s}" style="flex:${counts[s]}"></span>`)
    .join('')

  shadow.getElementById('legend')!.innerHTML = STATUS_ORDER.map(
    (s) => `<b class="${s}">${counts[s]} ${STATUS_LABEL[s]}</b>`,
  ).join('')
    .concat(`<b>of ${total}</b>`)

  const list = shadow.getElementById('list')!
  let tab: 'misses' | 'calls' = 'misses'

  const renderMisses = () => {
    if (misses.size === 0) {
      list.innerHTML = `<li class="empty">no unimplemented method reached yet</li>`
      return
    }
    list.innerHTML = [...misses.values()]
      .sort((a, b) => b.count - a.count)
      .map(
        (m) =>
          `<li class="miss"><span class="n">${m.count}</span><span class="m">${m.method}${
            m.note ? `<span class="note"> — ${m.note}</span>` : ''
          }</span></li>`,
      )
      .join('')
  }

  const renderCalls = () => {
    const calls = readCalls()
    if (calls.length === 0) {
      list.innerHTML = `<li class="empty">stub not in use (HTTP host active)</li>`
      return
    }
    list.innerHTML = calls
      .map((c) => {
        const cls = c.kind === 'subscribe' ? 'sub' : c.answered ? 'ok' : 'miss'
        return `<li class="${cls}"><span class="n">${c.seq}</span><span class="m">${c.method}</span><span class="t">${c.at}ms</span></li>`
      })
      .join('')
  }

  const render = () => (tab === 'misses' ? renderMisses() : renderCalls())

  const tabMisses = shadow.getElementById('tab-misses')!
  const tabCalls = shadow.getElementById('tab-calls')!
  const select = (next: 'misses' | 'calls') => {
    tab = next
    tabMisses.setAttribute('aria-pressed', String(next === 'misses'))
    tabCalls.setAttribute('aria-pressed', String(next === 'calls'))
    render()
  }
  tabMisses.addEventListener('click', () => select('misses'))
  tabCalls.addEventListener('click', () => select('calls'))

  shadow.getElementById('copy')!.addEventListener('click', () => {
    const text =
      tab === 'misses'
        ? [...misses.values()].map((m) => `${m.method}\t${m.channel}\t${m.count}`).join('\n')
        : [...new Set(readCalls().map((c) => c.method))].join('\n')
    void navigator.clipboard?.writeText(text)
  })

  window.addEventListener('stub-desktop-api:call', render)
  window.addEventListener('host:not-implemented', render)
  document.body.append(host)
  render()
}
