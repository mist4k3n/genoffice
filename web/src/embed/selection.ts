import type { SheetsSelection } from './host-api'

/**
 * Report the active cell or range to the host.
 *
 * The renderer exposes its Univer instance on `window.__univerAPI` for
 * debugging, and that is what this reads. Using a global would be wrong if two
 * editors could be mounted at once -- but they cannot, for the reasons in
 * SheetsEditor's header, and when that changes this should take the instance
 * as an argument instead.
 *
 * Univer's selection events differ across versions, so this polls rather than
 * subscribing: the active range is cheap to read, the interval is idle-cheap,
 * and an event name that silently stops firing after an upgrade is exactly the
 * kind of quiet breakage the Papan briefing warns this bridge is prone to.
 */

interface UniverRangeLike {
  getRange?: () => { startRow: number; endRow: number; startColumn: number; endColumn: number }
  getA1Notation?: () => string
}

interface UniverApiLike {
  getActiveWorkbook?: () => {
    getActiveSheet?: () => {
      getSheetName?: () => string
      getName?: () => string
      getActiveRange?: () => UniverRangeLike | null
    } | null
  } | null
}

const POLL_MS = 250

export function observeSelection(
  onChange: (selection: SheetsSelection | null) => void,
): () => void {
  let previous = ''

  const read = (): SheetsSelection | null => {
    const api = (window as unknown as { __univerAPI?: UniverApiLike }).__univerAPI
    const sheet = api?.getActiveWorkbook?.()?.getActiveSheet?.()
    const active = sheet?.getActiveRange?.()
    const bounds = active?.getRange?.()
    if (!sheet || !active || !bounds) return null
    return {
      sheetName: sheet.getSheetName?.() ?? sheet.getName?.() ?? '',
      range: active.getA1Notation?.() ?? '',
      startRow: bounds.startRow,
      endRow: bounds.endRow,
      startColumn: bounds.startColumn,
      endColumn: bounds.endColumn,
    }
  }

  const tick = (): void => {
    let selection: SheetsSelection | null = null
    try {
      selection = read()
    } catch {
      // The runtime is mid-teardown or mid-load; report nothing rather than
      // taking the host's render down with us.
      selection = null
    }
    const key = selection ? `${selection.sheetName}!${selection.range}` : ''
    if (key === previous) return
    previous = key
    onChange(selection)
  }

  const timer = setInterval(tick, POLL_MS)
  tick()
  return () => clearInterval(timer)
}
