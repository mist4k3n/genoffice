import { COVERAGE } from '../host/coverage'

/**
 * Hand upstream's container element id to one editor at a time.
 *
 * `App` renders `<div id="univer-container">`, and Univer resolves it *by id*
 * (`createUniver({ container: 'univer-container' })`), as do `shape-draw.ts`,
 * the formula-bar toggle and the keyboard handler via `getElementById`. Two
 * editors on a page therefore produce two elements with one id, and every one
 * of those lookups silently returns the first.
 *
 * So the id is *owned*: exactly one editor holds it, and ownership moves on
 * mount and on becoming visible. Two facts make that work, both measured
 * rather than assumed:
 *
 *  1. **Univer resolves the id once and keeps the element.** Renaming the div
 *     afterwards leaves its canvases and edits untouched — tested by renaming
 *     a live container and continuing to write cells through it.
 *  2. **`createUniver` runs in a `useEffect`.** React runs a parent's
 *     `useLayoutEffect` before a child's `useEffect`, so an editor can take
 *     ownership after its own markup exists and before Univer looks the id up.
 *
 * Base styling keys off the `.spreadsheet` class, not the id, so a parked
 * container keeps its layout. Only `#univer-container.formula-bar-hidden` and
 * `.sheet-shape-drawing` follow the id — both are affordances of the active
 * editor, which is where they belong.
 *
 * The host bridge used to be owned here too. It no longer is: `App` takes it
 * as a prop, so every editor addresses its own document. See
 * `web/UPSTREAM-CHANGES.md`.
 */

const CONTAINER_ID = 'univer-container'
const PARKED_ATTRIBUTE = 'data-sheets-parked-container'

let owner: symbol | null = null

/** Take the container id for this editor, parking whoever held it. */
export function claimContainerId(token: symbol, root: HTMLElement): void {
  owner = token
  for (const element of document.querySelectorAll(`#${CONTAINER_ID}`)) {
    if (!root.contains(element)) park(element)
  }
  const mine = root.querySelector(`#${CONTAINER_ID}, [${PARKED_ATTRIBUTE}]`)
  if (mine) {
    mine.id = CONTAINER_ID
    mine.removeAttribute(PARKED_ATTRIBUTE)
  }
}

export function releaseContainerId(token: symbol, root: HTMLElement): void {
  const mine = root.querySelector(`#${CONTAINER_ID}`)
  if (mine) park(mine)
  if (owner === token) owner = null
}

export function ownsContainerId(token: symbol): boolean {
  return owner === token
}

/**
 * Serialise editor start-up.
 *
 * Ownership alone is not enough when two editors mount in the same React
 * commit: React runs every layout effect in the tree before any passive
 * effect, so both editors claim the container id and only then do both call
 * `createUniver`. The second claim wins and the first editor resolves the
 * wrong element — measured as a blank editor, exactly the bug ownership was
 * meant to fix.
 *
 * So an editor waits for the previous one to finish initialising before it
 * renders at all. In practice that costs nothing: tabs are opened one at a
 * time, and only a page restored with several already open pays for it.
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

function park(element: Element): void {
  element.removeAttribute('id')
  element.setAttribute(PARKED_ATTRIBUTE, '')
}
