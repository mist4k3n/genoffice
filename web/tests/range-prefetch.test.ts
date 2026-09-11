import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRangePrefetcher } from '../src/host/range-prefetch'
import type {
  WorkbookRangeRequest,
  WorkbookRangeResult,
} from '../../apps/sheets/src/shared/desktop-api'

/**
 * The prefetcher decides when to speculate on the user's behalf, so its
 * failure modes are "shows stale cells" and "wastes server work". Both are
 * invisible in a demo and obvious in production, which is what makes them
 * worth testing rather than eyeballing.
 */

const range = (startRow: number, endRow: number): WorkbookRangeRequest =>
  ({
    sessionId: 'session',
    sheetId: 'sheet-1',
    range: { startRow, endRow, startColumn: 0, endColumn: 9 },
  }) as WorkbookRangeRequest

/** A reader that tags each result with the row it was asked for. */
function reader(indexedThroughRow: number | null = null) {
  const asked: number[] = []
  const read = async (request: WorkbookRangeRequest): Promise<WorkbookRangeResult> => {
    asked.push(request.range.startRow)
    return {
      cells: [{ row: request.range.startRow, column: 0, value: request.range.startRow }],
      rows: [],
      merges: [],
      hyperlinks: [],
      indexedThroughRow,
    } as unknown as WorkbookRangeResult
  }
  return { asked, read }
}

test('a continuous scroll is served from ahead', async () => {
  const { read } = reader()
  const prefetcher = createRangePrefetcher(read)
  for (let step = 0; step < 8; step += 1) await prefetcher.read(range(step * 40, step * 40 + 39))

  const stats = prefetcher.stats()
  assert.equal(stats.served, 6, 'every step after the run is established should be served')
  assert.equal(stats.wasted, 0)
})

test('scrolling upward is read ahead too', async () => {
  const { read } = reader()
  const prefetcher = createRangePrefetcher(read)
  for (let step = 5; step >= 0; step -= 1) await prefetcher.read(range(step * 40, step * 40 + 39))

  assert.equal(prefetcher.stats().served, 4)
  assert.equal(prefetcher.stats().wasted, 0)
})

test('a served result is the one for that exact range', async () => {
  const { read } = reader()
  const prefetcher = createRangePrefetcher(read)
  await prefetcher.read(range(0, 39))
  await prefetcher.read(range(40, 79))
  const third = await prefetcher.read(range(80, 119))

  assert.equal(prefetcher.stats().served, 1)
  assert.equal(third.cells[0]?.value, 80, 'must not serve a neighbouring range')
})

test('a mutation discards everything speculative', async () => {
  const { read } = reader()
  const prefetcher = createRangePrefetcher(read)
  await prefetcher.read(range(0, 39))
  await prefetcher.read(range(40, 79))
  prefetcher.invalidate()
  const after = await prefetcher.read(range(80, 119))

  assert.equal(prefetcher.stats().served, 0, 'a post-edit read must never come from a pre-edit fetch')
  assert.equal(after.cells[0]?.value, 80)
})

test('a partially indexed prefetch is never served, and backs off', async () => {
  // The sidecar indexes lazily; a speculative read can outrun it and come back
  // with fewer cells than a fresh read would return.
  const { read } = reader(85)
  const prefetcher = createRangePrefetcher(read)
  for (let step = 0; step < 4; step += 1) await prefetcher.read(range(step * 40, step * 40 + 39))

  assert.equal(prefetcher.stats().served, 0)
  assert.ok(prefetcher.stats().issued <= 2, 'should stop guessing rather than keep missing')
})

test('jumping the scroll thumb does not trigger speculation', async () => {
  const { read } = reader()
  const prefetcher = createRangePrefetcher(read)
  await prefetcher.read(range(0, 39))
  await prefetcher.read(range(5000, 5039))
  await prefetcher.read(range(12, 51))

  assert.equal(prefetcher.stats().issued, 0, 'a jump is not a direction')
})

test('a resized viewport is not treated as a scroll', async () => {
  const { read } = reader()
  const prefetcher = createRangePrefetcher(read)
  await prefetcher.read(range(0, 39))
  await prefetcher.read(range(40, 99))

  assert.equal(prefetcher.stats().issued, 0)
})

test('a failed speculative read never reaches the caller', async () => {
  let calls = 0
  const prefetcher = createRangePrefetcher(async (request) => {
    calls += 1
    // Fail only the speculative third window.
    if (request.range.startRow === 80) throw new Error('speculative boom')
    return {
      cells: [{ row: request.range.startRow, column: 0, value: request.range.startRow }],
      rows: [],
      merges: [],
      hyperlinks: [],
      indexedThroughRow: null,
    } as unknown as WorkbookRangeResult
  })
  await prefetcher.read(range(0, 39))
  await prefetcher.read(range(40, 79))
  // The real read of that window must still fail loudly rather than silently
  // returning nothing -- but it must fail as *its own* call.
  await assert.rejects(() => prefetcher.read(range(80, 119)), /speculative boom/)
  assert.ok(calls >= 3)
})
