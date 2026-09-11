#!/usr/bin/env node
/**
 * Scroll-latency benchmark: read_range over HTTP versus straight over stdio.
 *
 * PLAN.md calls this phase 03's real risk, and the renderer's own streaming
 * loop is why. `readSheetRangeMapped` splits a viewport into batches of
 * SIDECAR_READ_BATCH_CELLS and awaits them **one at a time**:
 *
 *     for (let startRow = ...; startRow <= end; startRow += batchRows) {
 *       const batch = await window.desktopApi.readWorkbookRange(...)
 *     }
 *
 * Sequential awaits are free over stdio and are not free over a network. The
 * number that matters is therefore not throughput but *requests per viewport*,
 * because the user-visible cost is requests x round-trip time, and we cannot
 * parallelise that loop without editing upstream.
 *
 * So this measures both: the per-request overhead HTTP adds on top of the
 * sidecar, and how many requests a realistic viewport actually costs.
 *
 *   node tools/bench-range.mjs [--server http://127.0.0.1:5274] [--rtt 60]
 *
 * --rtt projects the same request count onto a network with that round-trip in
 * milliseconds, since localhost measures overhead but not distance.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Sidecar } from './sidecar-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const SERVER = arg('server', 'http://127.0.0.1:5274')
const PROJECTED_RTT_MS = Number(arg('rtt', '60'))
const BINARY =
  process.env.XLSX_SIDECAR_PATH ??
  join(repoRoot, 'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar')

/** Mirrors univer-sync.ts. If upstream changes it, this benchmark is stale. */
const SIDECAR_READ_BATCH_CELLS = 90_000

/** A plausible maximised viewport, and the far-zoom-out case that hurts. */
const VIEWPORTS = [
  { label: 'viewport 40x18', rows: 40, columns: 18 },
  { label: 'viewport 120x30', rows: 120, columns: 30 },
  { label: 'zoomed out 600x40', rows: 600, columns: 40 },
]

const REPEATS = 7

async function invoke(documentId, channel, ...args) {
  const response = await fetch(`${SERVER}/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': documentId },
    body: JSON.stringify({ args }),
  })
  const body = await response.json()
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`)
  return body.result
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function time(repeats, run) {
  const samples = []
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now()
    await run()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

async function main() {
  const info = await (await fetch(`${SERVER}/dev-info`)).json()
  const corpusDir = info.documentRoot
  const names = (await (await fetch(`${SERVER}/dev-info`)).json()) && arg('files', '').length
    ? arg('files', '').split(',')
    : ['gamma-heavy-recalc.xlsx', 'Book 2.xlsx', 'Book 4.xlsx', 'acme-inventory.xlsx']

  const scratch = await mkdtemp(join(tmpdir(), 'sheets-bench-'))
  const sidecar = new Sidecar(BINARY)

  console.log(`  server ${SERVER}`)
  console.log(`  corpus ${corpusDir}`)
  console.log(`  projecting request counts onto a ${PROJECTED_RTT_MS}ms round trip\n`)

  for (const name of names) {
    let file
    try {
      file = await invoke(name, 'workbook:select')
    } catch (error) {
      console.log(`  ${name}: skipped (${error.message})`)
      continue
    }
    const baselineCopy = join(scratch, `b-${name}`)
    await copyFile(join(corpusDir, name), baselineCopy)
    const direct = await sidecar.open(baselineCopy, 'en')

    const sheet = file.sheets[0]
    const directSheet = direct.sheets[0]
    console.log(`  ${name} — sheet "${sheet.name}", ${sheet.rowCount} rows x ${sheet.columnCount} cols`)

    for (const viewport of VIEWPORTS) {
      const endRow = Math.min(viewport.rows, sheet.rowCount) - 1
      const endColumn = Math.min(viewport.columns, sheet.columnCount) - 1
      if (endRow < 0 || endColumn < 0) continue
      const range = { startRow: 0, endRow, startColumn: 0, endColumn }

      const width = endColumn + 1
      const batchRows = Math.max(1, Math.floor(SIDECAR_READ_BATCH_CELLS / width))
      const requests = Math.ceil((endRow + 1) / batchRows)

      const httpMs = await time(REPEATS, () =>
        invoke(name, 'workbook:read-range', { sessionId: file.sessionId, sheetId: sheet.id, range }),
      )
      const stdioMs = await time(REPEATS, () =>
        sidecar.readRange(direct.sessionId, directSheet.id, range),
      )
      const overhead = httpMs - stdioMs
      const projected = httpMs + requests * PROJECTED_RTT_MS

      console.log(
        `    ${viewport.label.padEnd(20)} ` +
          `stdio ${stdioMs.toFixed(1).padStart(6)}ms   ` +
          `http ${httpMs.toFixed(1).padStart(6)}ms   ` +
          `overhead ${overhead >= 0 ? '+' : ''}${overhead.toFixed(1).padStart(5)}ms   ` +
          `${requests} req   ` +
          `~${projected.toFixed(0)}ms at ${PROJECTED_RTT_MS}ms RTT`,
      )
    }

    await sidecar.close(direct.sessionId)
    await invoke(name, 'workbook:close', file.sessionId).catch(() => {})
    console.log()
  }

  await sidecar.dispose()
  await rm(scratch, { recursive: true, force: true })
}

await main()
