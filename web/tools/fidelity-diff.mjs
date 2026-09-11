#!/usr/bin/env node
/**
 * Phase-00 fidelity diff.
 *
 * For every formula cell in a workbook, compares the value Excel cached in the
 * file (`<v>`) against the value IronCalc produces when the sidecar recalculates
 * it. A mismatch is a fidelity bug the client would hit.
 *
 * This also exercises the Rust surface end to end — open, read_range,
 * recalc_cells, close — and reports timings, which is the phase-00 baseline.
 *
 * Run: npm run fidelity -- ../test-files [--dump]
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { Sidecar } from './sidecar-client.mjs'

const BINARY = resolve(
  import.meta.dirname,
  '../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar',
)

const dump = process.argv.includes('--dump')
const target = resolve(process.argv[2]?.startsWith('--') ? './fixtures' : (process.argv[2] ?? './fixtures'))

if (!statSync(BINARY, { throwIfNoEntry: false })) {
  console.error(`Sidecar binary not found: ${BINARY}`)
  console.error('Build it first:  npm run native:build -w @genoffice/sheets')
  process.exit(2)
}

/** Excel stores doubles; IronCalc recomputes them. Compare with a relative
 *  tolerance rather than exact equality, or every float looks like a bug. */
const EPSILON = 1e-9
function numericallyEqual(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) <= EPSILON * scale
}

/** CellValue is a serde enum; normalise the variants to a plain JS value. */
function normaliseValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  for (const key of ['number', 'Number', 'text', 'Text', 'string', 'boolean', 'Boolean', 'error', 'Error']) {
    if (key in value) return value[key]
  }
  const keys = Object.keys(value)
  return keys.length === 1 ? value[keys[0]] : JSON.stringify(value)
}

function sameValue(cached, recalculated) {
  const a = normaliseValue(cached)
  const b = normaliseValue(recalculated)
  if (a === null && b === null) return true
  if (typeof a === 'number' && typeof b === 'number') return numericallyEqual(a, b)
  const an = Number(a)
  const bn = Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return numericallyEqual(an, bn)
  return String(a).trim() === String(b).trim()
}

const files = readdirSync(target)
  .filter((f) => ['.xlsx', '.xlsm'].includes(extname(f).toLowerCase()))
  .sort()

console.log(`Fidelity diff — cached <v> vs IronCalc recalculation`)
console.log(`Corpus: ${target}`)
console.log(`Sidecar: ${BINARY}\n`)

const sidecar = new Sidecar(BINARY)
const summary = []

for (const file of files) {
  const path = join(target, file)
  const row = { file, formulaCells: 0, compared: 0, uncached: 0, mismatches: [], openMs: 0, recalcMs: 0, error: null }

  try {
    const t0 = performance.now()
    const opened = await sidecar.open(path)
    row.openMs = Math.round(performance.now() - t0)

    if (dump) {
      console.log(`--- open(${file}) ---`)
      console.log(JSON.stringify(opened, null, 2).slice(0, 1500))
      console.log('---\n')
    }

    const sheets = opened.sheets ?? []
    for (const sheet of sheets) {
      const range = {
        startRow: 0,
        endRow: Math.max(0, (sheet.rowCount ?? 1) - 1),
        startColumn: 0,
        endColumn: Math.max(0, (sheet.columnCount ?? 1) - 1),
      }

      const rangeResult = await sidecar.readRange(opened.sessionId, sheet.id, range)
      if (dump) {
        const sample = (rangeResult.cells ?? []).find((c) => c.formula)
        console.log(`--- first formula cell in ${sheet.name} ---`)
        console.log(JSON.stringify(sample, null, 2))
        console.log('---\n')
      }

      const formulaCells = (rangeResult.cells ?? []).filter((c) => c.formula)
      row.formulaCells += formulaCells.length
      if (formulaCells.length === 0) continue

      // The sidecar caps a single recalc read at MAX_RECALC_READ_CELLS (20_000,
      // recalc.rs:24). Split tall sheets into row bands under that cap rather
      // than failing — a 32k-formula sheet is exactly the case worth measuring.
      const CAP = 20_000
      const width = range.endColumn - range.startColumn + 1
      const bandRows = Math.max(1, Math.floor(CAP / Math.max(1, width)))

      const recalculated = new Map()
      const t1 = performance.now()
      for (let top = range.startRow; top <= range.endRow; top += bandRows) {
        const band = {
          ...range,
          startRow: top,
          endRow: Math.min(range.endRow, top + bandRows - 1),
        }
        const recalc = await sidecar.recalcCells(path, [], [{ sheet: sheet.name, range: band }])
        if (dump && top === range.startRow) {
          console.log(`--- recalc sample (${sheet.name}) ---`)
          console.log(JSON.stringify((recalc.cells ?? []).slice(0, 3), null, 2))
          console.log('---\n')
        }
        for (const cell of recalc.cells ?? []) recalculated.set(`${cell.row},${cell.column}`, cell)
      }
      row.recalcMs += Math.round(performance.now() - t1)

      for (const cell of formulaCells) {
        const match = recalculated.get(`${cell.row},${cell.column}`)
        if (!match) continue
        row.compared += 1
        // RecalcCell is { sheet, row, column, formatted, number?, isFormula }.
        // `formatted` is a DISPLAY string with number formats applied — comparing
        // it against the file's raw cached <v> reports every currency, percent
        // and date cell as a false mismatch (1263 vs "1,263.00", 46026 vs
        // "1/4/26"). `number` carries the raw value and is omitted for text, so
        // prefer it and fall back to `formatted` only for non-numeric results.
        const after = match.number ?? match.formatted ?? match.value

        // A file may ship no cached <v> for a formula cell (writers that set
        // fullCalcOnLoad often omit results). There is nothing to compare
        // against, so count it rather than calling it a mismatch.
        const cached = normaliseValue(cell.value)
        if (cached === null || cached === '') {
          row.compared -= 1
          row.uncached += 1
          continue
        }

        if (!sameValue(cell.value, after)) {
          if (row.mismatches.length < 10) {
            row.mismatches.push({
              sheet: sheet.name,
              at: `r${cell.row + 1}c${cell.column + 1}`,
              formula: cell.formula,
              cached: normaliseValue(cell.value),
              recalculated: normaliseValue(after),
            })
          } else {
            row.mismatches.push(null) // count only
          }
        }
      }
    }

    await sidecar.close(opened.sessionId)
  } catch (error) {
    row.error = String(error?.message ?? error)
  }

  summary.push(row)
}

await sidecar.dispose()

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('FILE', 46) + pad('FORMULAS', 10) + pad('COMPARED', 10) + pad('NO-CACHE', 10) + pad('MISMATCH', 10) + pad('OPEN', 8) + 'RECALC')
console.log('-'.repeat(110))
for (const r of summary) {
  if (r.error) {
    console.log(pad(r.file, 46) + `ERROR: ${r.error}`)
    continue
  }
  console.log(
    pad(r.file, 46) +
      pad(r.formulaCells, 10) +
      pad(r.compared, 10) +
      pad(r.uncached, 10) +
      pad(r.mismatches.length, 10) +
      pad(`${r.openMs}ms`, 8) +
      `${r.recalcMs}ms`,
  )
}

const withMismatches = summary.filter((r) => r.mismatches.length > 0)
if (withMismatches.length) {
  console.log('\nMISMATCHES (first 10 per file)')
  console.log('-'.repeat(110))
  for (const r of withMismatches) {
    console.log(`\n${r.file}`)
    for (const m of r.mismatches.filter(Boolean)) {
      console.log(`  ${m.sheet}!${m.at}  ${m.formula}`)
      console.log(`    cached:      ${JSON.stringify(m.cached)}`)
      console.log(`    recalculated: ${JSON.stringify(m.recalculated)}`)
    }
  }
}

const totalCompared = summary.reduce((n, r) => n + r.compared, 0)
const totalMismatch = summary.reduce((n, r) => n + r.mismatches.length, 0)
const errored = summary.filter((r) => r.error)

console.log('\nVERDICT')
console.log('-'.repeat(110))
const totalUncached = summary.reduce((n, r) => n + r.uncached, 0)
console.log(`  compared ${totalCompared} formula cells, ${totalMismatch} mismatch(es)`)
if (totalUncached) console.log(`  ${totalUncached} formula cell(s) had no cached <v> in the file — not comparable`)
if (errored.length) console.log(`  ${errored.length} file(s) failed to process — see ERROR rows above`)
if (totalCompared === 0 && !errored.length) {
  console.log('  Nothing compared. Re-run with --dump to inspect the wire shapes.')
}
process.exit(totalMismatch > 0 || errored.length > 0 ? 1 : 0)
