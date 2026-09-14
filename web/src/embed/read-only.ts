/**
 * Make a read-only session look read-only.
 *
 * The server refuses a viewer's save, correctly and fail-closed. That is not
 * enough on its own: upstream's renderer ignores `WorkbookFile.readOnly`
 * entirely -- it is in the schema, the server sets it honestly, and nothing in
 * `apps/sheets/src/renderer` reads it -- so a viewer sees a fully editable
 * grid, types into it, and finds out at Save. Papan's Collabora does not behave
 * that way, and neither does Excel: read-only means the cells do not take
 * input.
 *
 * Univer already has the mechanism. Its permission service gates the commands
 * every mutation runs through, the ribbon's included -- upstream's ribbon
 * actions call the same facade (`range.setValues`) the in-cell editor does, so
 * one switch covers both. This component already holds the editor's own
 * `univerAPI` through `onRuntime`, so applying it needs no upstream change.
 *
 * ## One editable workbook per unit id
 *
 * Univer keys edit permission by *unit id*, and upstream names a workbook after
 * its content: `file-<sha256>`. Two editors showing the same document
 * therefore share a unit, and share the permission with it.
 *
 * That is not hypothetical -- it is the conflict banner's compare view, which
 * mounts the stored version beside the dirty one. Measured: locking the compare
 * pane also froze the editable pane, and the user's unsaved workbook silently
 * stopped taking input while looking completely normal.
 *
 * So a read-only editor locks the unit only while no editable editor shares it,
 * and gives the lock up if one appears. The asymmetry is deliberate. An
 * unlocked viewer can scribble in a grid whose session the server holds
 * read-only, and loses the scribbles; a locked editor loses the user's real
 * work with nothing to indicate anything is wrong. When the lock cannot be
 * taken the host is told, rather than left to discover it.
 *
 * ## The lock has to stand aside for the renderer
 *
 * Univer's permission gate cannot tell the user apart from the application.
 * It is a command interceptor keyed by command id, and the renderer fills the
 * grid through exactly the commands it intercepts -- `SetRangeValuesCommand`
 * and friends, the same ones the in-cell editor uses. So a locked workbook
 * refuses the *loader*, silently: no throw, no console message, just a
 * document that renders as an empty grid with the right row count.
 *
 * That is measured, not deduced. A read-only session fetched its 26 cells from
 * the server and applied none of them; `setValue` on a locked workbook writes
 * nothing and reports nothing.
 *
 * The fix is to open the lock while the renderer is applying what the server
 * sent, which is knowable: every write the renderer makes follows a response it
 * asked for.
 *
 * ## Why this is not a timer
 *
 * The first version of it was, and that was wrong. A fixed window after each
 * response has to be longer than the whole load, and nothing bounds how long a
 * load takes: a cold engine indexing a 30MB workbook re-reads for as long as it
 * needs to. Sizing a constant against that is guesswork, and guessing short
 * means cells silently missing from someone's document.
 *
 * So the gate counts **requests in flight** instead. While the renderer has
 * anything outstanding the lock is aside, however long that is -- one request
 * or four hundred, one second or a minute. Duration is no longer a parameter.
 *
 * Two things still are, and both are small and bounded:
 *
 *  - **{@link TAIL_MS}**, which covers the *last* apply -- the one after the
 *    final response, with nothing outstanding behind it. It also has to clear
 *    {@link UPSTREAM_REREAD_MS}, because upstream's indexing retry sleeps
 *    between requests with nothing in flight, so a shorter tail would close the
 *    lock inside a single load.
 *  - **A user gesture closes it immediately.** {@link ReadOnlyGate.noteUserGesture}
 *    is called from a capture-phase listener before Univer sees the event, so
 *    the tail is not an editing window: the moment a person types or pastes
 *    with nothing in flight, the workbook locks, synchronously, and the
 *    keystroke lands on a locked grid.
 *
 * **The residual, stated plainly:** a gesture that arrives during the tail
 * locks the workbook while the renderer may still be applying, and cells in
 * that final chunk can be dropped until the document is reopened. It needs
 * someone to type into a read-only pane in the same moment its last chunk is
 * landing. The alternative -- letting the keystroke through -- is a read-only
 * grid that takes input, which is the thing this file exists to prevent.
 */

/** The slice of Univer's facade this needs, typed structurally like selection.ts. */
export interface UniverPermissionLike {
  getActiveWorkbook?: () => {
    getId?: () => string
    setEditable?: (value: boolean) => unknown
  } | null
}

const RETRY_MS = 150
/** Long enough for a large workbook to finish opening on a slow machine. */
const GIVE_UP_MS = 30_000
/**
 * The widest gap upstream leaves between two reads inside one load.
 *
 * Its lazy loader re-reads a range on this interval while the engine is still
 * indexing it -- four sites in `univer-sync.ts`, all `setTimeout(resolve, 400)`
 * -- so a load of a large sheet is a sequence of responses 400ms apart, not one
 * response. `tests/isolation.test.ts` reads upstream's source and fails if this
 * number stops matching, because a stale copy of it here is silent: the lock
 * would simply start closing in the middle of loads again.
 */
const UPSTREAM_REREAD_MS = 400

/**
 * How long the lock stays aside after the last response, with nothing left in
 * flight.
 *
 * This covers one apply, not one load -- the load is covered by the in-flight
 * count. It must still clear {@link UPSTREAM_REREAD_MS}: upstream's indexing
 * retry sleeps *between* requests, so during that sleep nothing is in flight
 * and a shorter tail would close the lock in the middle of a load. Plus the
 * poll interval and a round trip.
 */
export const TAIL_MS = UPSTREAM_REREAD_MS + RETRY_MS + 150

/** Editable editors currently mounted, per Univer unit id. */
const editableUnits = new Map<string, number>()

const countEditable = (unitId: string): number => editableUnits.get(unitId) ?? 0

function addEditable(unitId: string): void {
  editableUnits.set(unitId, countEditable(unitId) + 1)
}

function removeEditable(unitId: string): void {
  const next = countEditable(unitId) - 1
  if (next > 0) editableUnits.set(unitId, next)
  else editableUnits.delete(unitId)
}

/** The lock could not be taken, or had to be given back. Said once per editor. */
export type ReadOnlyReport = (message: string) => void

/**
 * Follow this editor's workbook for as long as it is mounted.
 *
 * Every editor calls this, editable or not: an editable one has to be counted
 * so that a viewer sharing its unit knows to leave the permission alone.
 * Returns a stop function.
 *
 * Polled rather than subscribed, for the same reason `selection.ts` polls: the
 * workbook arrives after the runtime does, a save replaces it with a fresh one,
 * and an event name that quietly stops firing after a Univer upgrade is the
 * failure mode this file exists to prevent.
 */
export interface ReadOnlyGate {
  /**
   * A call went out. Called from the host bridge; the lock stays aside until
   * this one and every other outstanding call has come back.
   */
  noteRequest(): void
  /**
   * A call came back, so the renderer is about to write what it carried.
   * Called synchronously, before the renderer's own continuation, because
   * `setEditable` is synchronous and a poll would be too late.
   */
  noteResponse(): void
  /**
   * Someone pressed, pasted or dropped something into the editor. Called from
   * a capture-phase listener, before Univer sees the event, so that the tail
   * after a load is not an editing window.
   */
  noteUserGesture(): void
  /** Unmount. */
  stop(): void
}

export function trackWorkbookUnit(
  getUniverApi: () => UniverPermissionLike | null | undefined,
  options: { readOnly: boolean; report: ReadOnlyReport },
): ReadOnlyGate {
  let stopped = false
  /** Calls the renderer has outstanding. Nonzero means a load is in progress. */
  let inFlight = 0
  /** When the last call came back, for {@link TAIL_MS}. */
  let lastResponseAt = 0
  /** True while the renderer may still be writing what the server sent. */
  const loading = (): boolean =>
    inFlight > 0 || Date.now() - lastResponseAt < TAIL_MS
  /** The unit this editor is counted against, while it is editable. */
  let counted: string | null = null
  /** Whether this editor currently holds the unit locked. */
  let locked = false
  let warned = false
  const deadline = Date.now() + GIVE_UP_MS
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = (): void => {
    if (stopped) return
    const workbook = getUniverApi()?.getActiveWorkbook?.()
    const unitId = workbook?.getId?.() ?? null

    if (!options.readOnly) {
      // Editable: keep the count honest across the workbook swap a save does.
      if (unitId !== counted) {
        if (counted) removeEditable(counted)
        if (unitId) addEditable(unitId)
        counted = unitId
      }
    } else if (workbook && unitId) {
      const shared = countEditable(unitId) > 0
      if (!shared && !locked && !loading()) {
        workbook.setEditable?.(false)
        locked = true
      } else if (shared && locked) {
        // An editable editor joined this unit. Hand the permission back: that
        // user's unsaved work outranks this pane's affordance.
        workbook.setEditable?.(true)
        locked = false
      }
      if (shared && !warned) {
        warned = true
        options.report(
          'This document is also open for editing on this page, so the read-only view cannot be locked. Changes made in it are discarded.',
        )
      }
    } else if (!workbook && Date.now() > deadline && !warned) {
      // Silence here would be the worst outcome: an editable grid for someone
      // who may not edit, with nothing anywhere saying so.
      warned = true
      options.report('Could not apply read-only: the workbook never appeared.')
    }

    timer = setTimeout(tick, RETRY_MS)
  }

  tick()

  /** Hand the workbook back to the renderer, now, not at the next poll. */
  const openNow = (): void => {
    if (!locked) return
    getUniverApi()?.getActiveWorkbook?.()?.setEditable?.(true)
    locked = false
  }

  return {
    noteRequest(): void {
      if (stopped || !options.readOnly) return
      inFlight += 1
      openNow()
    },
    noteResponse(): void {
      if (stopped || !options.readOnly) return
      inFlight = Math.max(0, inFlight - 1)
      lastResponseAt = Date.now()
      // Before the renderer's continuation, which is where the apply happens.
      openNow()
    },
    noteUserGesture(): void {
      if (stopped || !options.readOnly || locked) return
      // Mid-load the renderer keeps the workbook: dropping a chunk to refuse
      // one keystroke trades a silent hole in the document for a keystroke the
      // server will refuse anyway. Otherwise the person wins the race, which
      // is what read-only means.
      if (inFlight > 0) return
      const workbook = getUniverApi()?.getActiveWorkbook?.()
      const unitId = workbook?.getId?.()
      if (!workbook || !unitId || countEditable(unitId) > 0) return
      workbook.setEditable?.(false)
      locked = true
    },
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      if (counted) removeEditable(counted)
      counted = null
    },
  }
}
