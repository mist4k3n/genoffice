/**
 * Start-up sequencing for embedded editors.
 *
 * This file used to also hand upstream's container element id to one editor at
 * a time, because `App` rendered `<div id="univer-container">` and Univer
 * resolved it *by id*. Two editors on a page produced two elements with one id
 * and every lookup returned the first.
 *
 * That is fixed at the source now: the id is generated per `App` instance and
 * the styling and keyboard hooks key off `[data-univer-grid]`. See
 * `web/UPSTREAM-CHANGES.md`. Ownership, parking and the id constant are gone
 * with it -- what remains is sequencing, which is a separate problem.
 */

/**
 * Serialise editor start-up.
 *
 * Kept after the container id stopped being shared, because Univer's start-up
 * is expensive and two of them racing through it on one page is worth
 * avoiding on its own. In practice it costs nothing: tabs open one at a time,
 * and only a page restored with several already open pays for it.
 */
let queue: Promise<void> = Promise.resolve()

export function enqueueMount<T>(run: () => Promise<T>): Promise<T> {
  const turn = queue.then(run, run)
  // The queue must not stall on a failed mount.
  queue = turn.then(
    () => undefined,
    () => undefined,
  )
  return turn
}

/**
 * Resolve once this editor's grid exists, so the next may start.
 *
 * Univer's readiness is not observable from outside, so this watches for the
 * canvas it creates. The timeout is a release valve, not a deadline: a
 * mount that never produces a grid must not block every later one forever.
 */
export function whenGridReady(
  root: HTMLElement,
  abandoned: () => boolean,
  timeoutMs = 20_000,
): Promise<boolean> {
  const hasGrid = (): boolean =>
    [...root.querySelectorAll('canvas')].some((canvas) => canvas.width * canvas.height > 100_000)
  if (hasGrid()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      // An editor unmounted mid-start-up must free the queue at once. Waiting
      // out its timeout instead made every tab switch take twenty seconds --
      // the queue was holding a slot for an editor that no longer existed.
      if (abandoned() || hasGrid() || Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(hasGrid())
      }
    }, 60)
  })
}

