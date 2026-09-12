import type { DesktopApi } from '../../../apps/sheets/src/shared/desktop-api'
import { COVERAGE } from '../host/coverage'

/**
 * Hand upstream's two page-level singletons to one editor at a time.
 *
 * `App` was written for Electron, where a window holds exactly one workbook,
 * so two page-level things are hardcoded:
 *
 *  - `<div id="univer-container">`, which Univer resolves *by id*
 *    (`createUniver({ container: 'univer-container' })`) and which
 *    `shape-draw.ts`, the formula-bar toggle and the keyboard handler find
 *    with `getElementById`.
 *  - `window.desktopApi`, whose transport carries the document id.
 *
 * Mount two editors and both collapse onto whichever element and API came
 * first — measured as a blank second editor, then a blank first one after a
 * tab switch.
 *
 * Rather than change upstream, this makes the singletons *owned*: exactly one
 * editor holds the id and the API at any moment, and ownership moves on mount
 * and on becoming visible. Two facts make it work, both verified rather than
 * assumed:
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
 * editor, which is exactly where they should apply.
 *
 * ## Where this stops, and why it refuses rather than degrades
 *
 * Container ownership fixes *rendering*. It cannot fix `window.desktopApi`,
 * and that was established by measurement rather than argument: with two
 * editors mounted on different documents, **both loaded the same one**. The
 * document load is not part of mounting — the renderer asks for it well after
 * the grid exists — and every later call (a scroll read, a save) leaves at a
 * time nobody controls. Whoever owns the API then answers, so an editor
 * silently renders another document's data.
 *
 * There is no ordering trick that fixes this. A call has no way to say which
 * React tree it came from, and serialising mounts does not help because the
 * calls that matter happen after every mount is finished.
 *
 * So a second editor on a *different* document is refused outright. Showing a
 * user someone else's spreadsheet in a tab labelled with their filename is far
 * worse than showing them an error, and an error is the only honest thing this
 * layer can produce. Two editors on the *same* document are allowed: they
 * share a session, which is what they would do anyway.
 *
 * The real fix is to pass the host API to `App` instead of reading a global —
 * a small additive upstream change, tracked in DRIFT.md. An iframe per editor
 * would also work, since each frame has its own realm, at the cost of a second
 * copy of the bundle.
 */

const CONTAINER_ID = 'univer-container'
const PARKED_ATTRIBUTE = 'data-sheets-parked-container'

let owner: symbol | null = null
let ownerApi: DesktopApi | null = null
let strayCalls = 0
let strayMethods = new Set<string>()

/** Live editors, so a conflicting second one can be refused. */
const liveDocuments = new Map<symbol, string>()

export class ConcurrentDocumentError extends Error {
  constructor(requested: string, existing: string) {
    super(
      `Cannot open "${requested}" while "${existing}" is open in this page: the renderer ` +
        `reads a single global host API, so both editors would share one document. ` +
        `Mount one editor at a time, or see DRIFT.md for the upstream change that lifts this.`,
    )
    this.name = 'ConcurrentDocumentError'
  }
}

/**
 * Register an editor, or refuse it.
 *
 * Refusing is the point: see the header. Two editors on the same document are
 * fine; two on different documents are not, and no amount of routing makes
 * them fine.
 */
export function registerEditor(token: symbol, documentId: string): void {
  for (const [other, existing] of liveDocuments) {
    if (other !== token && existing !== documentId) {
      throw new ConcurrentDocumentError(documentId, existing)
    }
  }
  liveDocuments.set(token, documentId)
}

export function unregisterEditor(token: symbol): void {
  liveDocuments.delete(token)
}

/** Install the routing proxy once. Every editor's calls go through it. */
let installed = false

export function installSingletonRouter(): void {
  if (installed) return
  installed = true
  const proxy = new Proxy({} as Record<string, unknown>, {
    get(_target, property: string) {
      const api = ownerApi as unknown as Record<string, unknown> | null
      const value = api?.[property]
      if (typeof value === 'function') {
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(api, args)
      }
      if (value !== undefined) return value
      // Never hand back undefined for a method. The renderer tears itself down
      // by calling the host — `closeWorkbook` among others — and a missing
      // function there throws mid-unmount, which left the page unable to mount
      // anything afterwards.
      return fallbackFor(property)
    },
    has: (_target, property) => typeof property === 'string' && property in COVERAGE,
  })
  Object.defineProperty(window, 'desktopApi', {
    value: proxy,
    writable: false,
    configurable: true,
  })
}

/**
 * Take both singletons for this editor.
 *
 * Call from a `useLayoutEffect`, which is what puts it ahead of the child
 * `useEffect` that resolves the container id.
 */
export function claimSingletons(token: symbol, root: HTMLElement, api: DesktopApi): void {
  owner = token
  ownerApi = api

  for (const element of document.querySelectorAll(`#${CONTAINER_ID}`)) {
    if (!root.contains(element)) park(element)
  }
  const mine = root.querySelector(`#${CONTAINER_ID}, [${PARKED_ATTRIBUTE}]`)
  if (mine) {
    mine.id = CONTAINER_ID
    mine.removeAttribute(PARKED_ATTRIBUTE)
  }
}

export function releaseSingletons(token: symbol, root: HTMLElement): void {
  const mine = root.querySelector(`#${CONTAINER_ID}`)
  if (mine) park(mine)
  if (owner !== token) return
  owner = null
  // `ownerApi` deliberately stays. The renderer makes host calls *while*
  // unmounting, and those belong to the editor that is leaving; the next
  // claim replaces it.
}

/**
 * What a call gets when no editor owns the API.
 *
 * Subscriptions must hand back an unsubscribe function synchronously or the
 * renderer breaks at the call site; everything else is a promise.
 */
function fallbackFor(method: string): unknown {
  const entry = (COVERAGE as Record<string, { status: string } | undefined>)[method]
  if (entry?.status === 'push' || entry?.status === 'shell') return () => () => {}
  return () => Promise.resolve(undefined)
}

/** True when this editor currently holds the singletons. */
export function ownsSingletons(token: symbol): boolean {
  return owner === token
}

/**
 * Record a call made by an editor that does not own the singletons. Such a
 * call reaches the owner's document, so this is the measure of how unsafe
 * two live editors actually are.
 */
export function noteStrayCall(method: string): void {
  strayCalls += 1
  strayMethods.add(method)
}

export function singletonStats(): { strayCalls: number; strayMethods: string[] } {
  return { strayCalls, strayMethods: [...strayMethods] }
}

export function resetSingletonStats(): void {
  strayCalls = 0
  strayMethods = new Set()
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
