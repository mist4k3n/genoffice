import type { SheetsSelection } from './host-api'

/**
 * Report the active cell or range to the host.
 *
 * Takes the editor's own Univer API rather than reading the `__univerAPI` dev
 * global, which names whichever editor mounted last -- with two editors open
 * that global reported the wrong document's selection, which is exactly the
 * kind of quiet wrongness this bridge is prone to.
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

export interface UniverApiLike {
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
  getUniverApi: () => UniverApiLike | null | undefined,
  onChange: (selection: SheetsSelection | null) => void,
): () => void {
  let previous = ''

  const read = (): SheetsSelection | null => {
    const api = getUniverApi()
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
