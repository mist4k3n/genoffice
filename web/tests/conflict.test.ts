import assert from 'node:assert/strict'
import { test } from 'node:test'

import { conflictFor, CONFLICT_CHANNEL } from '../protocol'
import { createHostCommandBus } from '../src/host/commands'
import { buildDesktopApi } from '../src/host/desktop-api'
import type { HostTransport } from '../src/host/transport'
import { COVERAGE } from '../src/host/coverage'

/**
 * A conflict push reaches every socket watching the document, including the
 * one whose own save caused it. Addressing and self-recognition are therefore
 * the whole correctness story: get either wrong and saving in one tab raises a
 * banner in that same tab, which teaches people to ignore the banner.
 */

test('a conflict names the sessions that are behind, and the edits at stake', () => {
  const conflict = conflictFor('v2', [
    { sessionId: 'a', pendingEdits: 0 },
    { sessionId: 'b', pendingEdits: 4 },
  ])

  assert.deepEqual(conflict.sessions, ['a', 'b'])
  assert.equal(conflict.currentVersion, 'v2')
  // The largest, not the sum: it is the worst case any one viewer faces.
  assert.equal(conflict.pendingEdits, 4)
})

test('a conflict with no stale sessions reports nothing at stake', () => {
  assert.equal(conflictFor('v2', []).pendingEdits, 0)
})

test('the channel name is not an upstream channel', () => {
  const upstream = new Set(Object.values(COVERAGE).map((entry) => entry.channel))
  assert.equal(upstream.has(CONFLICT_CHANNEL), false)
})

/**
 * Overwrite is a decision a person made. It has to reach the save the command
 * produced, and it must not survive to reach any other one.
 */

test('an overwrite reaches the save its command started', () => {
  const bus = createHostCommandBus()
  bus.subscribe(() => {})
  bus.dispatchWith('save', { overwrite: true })
  assert.deepEqual(bus.takeOptions(), { overwrite: true })
})

test('an overwrite is claimed once and never again', () => {
  const bus = createHostCommandBus()
  bus.subscribe(() => {})
  bus.dispatchWith('save', { overwrite: true })

  assert.deepEqual(bus.takeOptions(), { overwrite: true })
  // The save that follows a save is a different decision. Inheriting this one
  // would be an autosave clobbering a document nobody looked at.
  assert.deepEqual(bus.takeOptions(), {})
})

test('a plain command claims nothing', () => {
  const bus = createHostCommandBus()
  bus.subscribe(() => {})
  bus.dispatch('save')
  assert.deepEqual(bus.takeOptions(), {})
})

test('the intent rides as a second argument, leaving the request untouched', async () => {
  const sent: unknown[][] = []
  const transport: HostTransport = {
    invoke: async <T,>(_channel: string, ...args: unknown[]): Promise<T> => {
      sent.push(args)
      return { canceled: false, file: {}, touchedEntries: [] } as T
    },
    subscribe: () => () => {},
    fetchBytes: async () => new Uint8Array(),
    dispose: () => {},
  }
  const commands = createHostCommandBus()
  commands.subscribe(() => {})
  const api = buildDesktopApi(transport, { commands })

  const request = { sessionId: 's', mode: 'save' }
  commands.dispatchWith('save', { overwrite: true })
  await api.saveWorkbookEdits(request as never)
  // Upstream's schema is .strict(), so the flag must never be folded into the
  // request the renderer built.
  assert.deepEqual(sent[0], [request, { overwrite: true }])

  await api.saveWorkbookEdits(request as never)
  assert.deepEqual(sent[1], [request])
})
