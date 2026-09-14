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
 * The fix is to open the lock exactly while the renderer is applying what the
 * server just sent, which is knowable: every write the renderer makes follows
 * a response it asked for. {@link ReadOnlyGate.noteServerData} is called from
 * the host bridge the moment a call resolves and **before** the renderer's own
 * continuation runs -- `setEditable` is synchronous, so the grid is editable
 * by the time the apply happens -- and the lock returns once the traffic
 * stops.
 *
 * **The cost, stated plainly:** for {@link SETTLE_MS} after each response the
 * grid would accept a keystroke. Those windows open when the viewport loads,
 * which is when the user is scrolling rather than typing, and anything that
 * lands in one is overwritten by the arriving data and refused by the server
 * at save. It is a flicker, not a write. Blocking it outright needs the
 * renderer to mark its own writes, which is a much larger upstream change than
 * this behaviour is worth.
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
 * How long the lock stands aside after a response arrives.
 *
 * Long enough for the renderer to finish applying a viewport's worth of cells,
 * short enough that an idle viewer is locked. Bursts extend it: every response
 * pushes the deadline out, so a scroll that triggers ten reads is one window.
 */
export const SETTLE_MS = 400

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
   * The server answered, so the renderer is about to write. Called from the
   * host bridge, synchronously, before the renderer's continuation.
   */
  noteServerData(): void
  /** Unmount. */
  stop(): void
}

export function trackWorkbookUnit(
  getUniverApi: () => UniverPermissionLike | null | undefined,
  options: { readOnly: boolean; report: ReadOnlyReport },
): ReadOnlyGate {
  let stopped = false
  /** While `Date.now()` is below this, the renderer owns the workbook. */
  let openUntil = 0
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
      if (!shared && !locked && Date.now() >= openUntil) {
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

  return {
    noteServerData(): void {
      if (stopped || !options.readOnly) return
      openUntil = Date.now() + SETTLE_MS
      if (!locked) return
      // Synchronously, because the renderer applies in the continuation of
      // the call that just resolved. A poll would be too late and the data
      // would be dropped.
      getUniverApi()?.getActiveWorkbook?.()?.setEditable?.(true)
      locked = false
    },
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      if (counted) removeEditable(counted)
      counted = null
    },
  }
}
