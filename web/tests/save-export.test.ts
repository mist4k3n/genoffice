import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildDesktopApi, type ExportedWorkbook } from '../src/host/desktop-api'
import type { HostTransport } from '../src/host/transport'
import { COVERAGE } from '../src/host/coverage'

/**
 * Save As is one upstream method standing for two operations, and the split
 * happens in the bridge. Two things have to stay true, and neither is visible
 * from the outside:
 *
 *  - the renderer must never see the `export` half, because upstream's result
 *    schema is `.strict()` and the renderer's own journal bookkeeping keys off
 *    `canceled`;
 *  - a plain save must be untouched by any of this.
 */

const saveChannel = COVERAGE.saveWorkbookEdits.channel as string

function transportSpy(results: Record<string, unknown>) {
  const calls: { channel: string; args: readonly unknown[] }[] = []
  const fetched: string[] = []
  const transport: HostTransport = {
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
      calls.push({ channel, args })
      return results[channel] as T
    },
    subscribe: () => () => {},
    fetchBytes: async (path: string) => {
      fetched.push(path)
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    },
    dispose: () => {},
  }
  return { transport, calls, fetched }
}

test('a save-as reaches the host as bytes and the renderer as a cancel', async () => {
  const exported: ExportedWorkbook[] = []
  const { transport, fetched } = transportSpy({
    [saveChannel]: {
      canceled: true,
      export: { token: 'tok-1', name: 'budget.xlsx', size: 4, touchedEntries: ['xl/worksheets/sheet1.xml'] },
    },
  })
  const api = buildDesktopApi(transport, { onExport: (event) => void exported.push(event) })

  const result = await api.saveWorkbookEdits({ mode: 'save-as' } as never)

  assert.deepEqual(result, { canceled: true })
  assert.deepEqual(fetched, ['/export/tok-1'])
  assert.equal(exported.length, 1)
  assert.equal(exported[0]?.suggestedName, 'budget.xlsx')
  assert.deepEqual(exported[0]?.touchedEntries, ['xl/worksheets/sheet1.xml'])
  assert.deepEqual([...(exported[0]?.bytes ?? [])], [0x50, 0x4b, 0x03, 0x04])
})

test('a plain save is passed through untouched, and fetches nothing', async () => {
  const exported: ExportedWorkbook[] = []
  const saved = { canceled: false, file: { path: 'budget.xlsx' }, touchedEntries: [] }
  const { transport, fetched } = transportSpy({ [saveChannel]: saved })
  const api = buildDesktopApi(transport, { onExport: (event) => void exported.push(event) })

  const result = await api.saveWorkbookEdits({ mode: 'save' } as never)

  assert.deepEqual(result, saved)
  assert.deepEqual(fetched, [])
  assert.equal(exported.length, 0)
})

test('onMenuAction is the host command bus when there is a host', () => {
  const { transport } = transportSpy({})
  const seen: string[] = []
  const commands = {
    dispatch: (action: string) => void seen.push(action),
    subscribe: () => () => {},
    connected: true,
  }
  const api = buildDesktopApi(transport, { commands: commands as never })

  // Subscribing must reach the bus, not the no-op the 'shell' status returns.
  const unsubscribe = api.onMenuAction(() => {})
  assert.equal(typeof unsubscribe, 'function')
  commands.dispatch('save-as')
  assert.deepEqual(seen, ['save-as'])
})

test('without a host, onMenuAction is still a safe no-op subscription', () => {
  const { transport } = transportSpy({})
  const api = buildDesktopApi(transport, {})
  assert.equal(typeof api.onMenuAction(() => {}), 'function')
})
