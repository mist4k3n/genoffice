import type { WorkbookRangeRequest, WorkbookRangeResult } from '../../../apps/sheets/src/shared/desktop-api'

/**
 * Speculative read-ahead for the scroll direction.
 *
 * Measured on the largest corpus workbook (8,001 rows): a real scroll costs
 * one `read-range` per step, median 16ms on localhost. One request per step is
 * already optimal -- the renderer's 90,000-cell batch covers a whole viewport,
 * so PLAN.md's "batch viewport requests" is not needed. What remains is
 * distance: the same eleven requests on a 60ms link are eleven 60ms stalls,
 * and the renderer awaits them one at a time inside `readSheetRangeMapped`.
 *
 * We cannot parallelise that loop without editing upstream. We can guess the
 * next range and have it waiting. Continuous scrolling in one direction is the
 * case worth guessing, and the only one this handles.
 *
 * Correctness rules, in order of importance:
 *
 *  - A prefetch is served only on an *exact* range match. No partial reuse, no
 *    slicing a wider cached result.
 *  - Any non-read call on the session invalidates everything outstanding. A
 *    save or a recalc changes cells, and serving a pre-edit read afterwards
 *    would show the user stale data in their own spreadsheet.
 *  - An incomplete result is never served. The sidecar indexes lazily and
 *    reports how far it got in `indexedThroughRow`; a prefetch that outran
 *    indexing would hand back fewer cells than a fresh read, and the renderer
 *    would treat that as the final answer for those rows.
 *  - At most one prefetch is in flight. Guessing further is speculation about
 *    speculation, and a wrong guess costs the server real work.
 */

type ReadRange = (request: WorkbookRangeRequest) => Promise<WorkbookRangeResult>

interface Outstanding {
  readonly key: string
  readonly generation: number
  readonly promise: Promise<WorkbookRangeResult>
}

/** Identifies a range request exactly. Order matters only for equality. */
function rangeKey(request: WorkbookRangeRequest): string {
  const { sessionId, sheetId, range } = request
  return `${sessionId}|${sheetId}|${range.startRow}|${range.endRow}|${range.startColumn}|${range.endColumn}`
}

export interface RangePrefetcher {
  read: ReadRange
  /** Called for every non-read channel; drops anything that could now be stale. */
  invalidate(): void
  stats(): { served: number; issued: number; wasted: number }
}

export function createRangePrefetcher(read: ReadRange): RangePrefetcher {
  let generation = 0
  let outstanding: Outstanding | null = null
  let previous: WorkbookRangeRequest | null = null
  let runLength = 0
  const stats = { served: 0, issued: 0, wasted: 0 }

  /**
   * The next range if the user keeps scrolling the way they are.
   *
   * Two consecutive reads over the same columns, the same height, moving by at
   * most one viewport. The distance bound is what separates scrolling from
   * jumping: dragging the thumb to row 5,000 also produces two reads with a
   * consistent "step", but guessing 5,000 rows further is speculation nobody
   * asked for. A changed height means the viewport resized rather than moved.
   */
  function nextGuess(request: WorkbookRangeRequest): WorkbookRangeRequest | null {
    const last = previous
    previous = request
    if (
      !last ||
      last.sessionId !== request.sessionId ||
      last.sheetId !== request.sheetId ||
      last.range.startColumn !== request.range.startColumn ||
      last.range.endColumn !== request.range.endColumn
    ) {
      runLength = 0
      return null
    }
    const step = request.range.startRow - last.range.startRow
    const height = request.range.endRow - request.range.startRow
    // A step of zero is a re-read of the same rows, not a scroll.
    if (step === 0 || height !== last.range.endRow - last.range.startRow) {
      runLength = 0
      return null
    }
    if (Math.abs(step) > height + 1) {
      runLength = 0
      return null
    }
    runLength += 1

    const startRow = request.range.startRow + step
    if (startRow < 0) return null
    return {
      ...request,
      range: { ...request.range, startRow, endRow: startRow + height },
    }
  }

  /** Guess the next range and start fetching it, if the run supports one. */
  function issue(request: WorkbookRangeRequest): void {
    const guess = nextGuess(request)
    if (!guess) return
    stats.issued += 1
    const promise = read(guess)
    // Swallow separately so a speculative failure never surfaces as an
    // unhandled rejection; the awaiting side re-checks and re-reads.
    promise.catch(() => {})
    outstanding = { key: rangeKey(guess), generation, promise }
  }

  return {
    async read(request) {
      const key = rangeKey(request)

      if (outstanding && outstanding.key === key && outstanding.generation === generation) {
        const pending = outstanding
        outstanding = null
        try {
          const result = await pending.promise
          // Only a fully indexed result answers the question a fresh read
          // would have answered.
          if (
            result.indexedThroughRow === null ||
            result.indexedThroughRow >= request.range.endRow
          ) {
            stats.served += 1
            // Keep reading ahead. Without this the run alternates hit, miss,
            // hit -- every served read would leave nothing in flight, and a
            // continuous scroll would only ever be half covered.
            issue(request)
            return result
          }
        } catch {
          // A failed speculative read is not the caller's problem; fall
          // through and make the real one.
        }
        // Discarded. Stop guessing until a fresh run re-establishes itself:
        // while the sidecar is still indexing, every guess would be discarded
        // the same way, and each one costs the server a real read.
        stats.wasted += 1
        runLength = 0
        previous = request
        return read(request)
      }

      if (outstanding) {
        stats.wasted += 1
        outstanding = null
      }

      const result = await read(request)
      issue(request)
      return result
    },

    invalidate() {
      generation += 1
      outstanding = null
      previous = null
      runLength = 0
    },

    stats: () => ({ ...stats }),
  }
}
