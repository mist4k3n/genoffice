#!/usr/bin/env node
/**
 * Resident memory per open workbook.
 *
 * This is the number the whole engine question turns on. Papan's Collabora
 * deployment is bounded by memory inside coolwsd -- roughly 145 MB settled and
 * 280 MB peak for a heavy .xlsx, which is what produces its ~7-concurrent-
 * document ceiling on a 7.6 GB box. Any replacement has to be measured on the
 * same axis, not on throughput or request latency.
 *
 * Method: pin the pool to ONE engine process so attribution is unambiguous,
 * sample its RSS, then open workbooks one at a time and sample again. The
 * delta is what that document costs while resident. The Node server is
 * sampled too, because a session also costs bookkeeping there.
 *
 *   npm run bench:memory                 # every workbook in the corpus, once
 *   npm run bench:memory -- --slope 8    # N copies of one workbook, for a slope
 *   npm run bench:memory -- --slope 3 --reopen 3   # and is the retained half reusable
 *
 * Assumes `npm run serve -- --dir <corpus copy> --pool 1` is running.
 *
 * Prefer --slope for any number you intend to quote. Sampling one workbook at a
 * time is too noisy to trust: Node's RSS swings by tens of MB as V8 collects,
 * which is larger than the signal and produces negative per-document deltas.
 * Opening the same workbook N times and taking the slope cancels that out.
 */
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const SERVER = arg('server', 'http://127.0.0.1:5274')
const REPEAT = Number(arg('repeat', '1'))

/**
 * Glibc tunables that change what an allocator hands back to the kernel.
 *
 * They are not set here -- they belong to whoever launches the engine -- but a
 * run under one of them produces a different number than a run without, so the
 * report has to say which it was or the two are not comparable.
 */
const ALLOCATOR_ENV = ['MALLOC_ARENA_MAX', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_MMAP_THRESHOLD_']

async function invoke(documentId, channel, ...args) {
  const response = await fetch(`${SERVER}/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': documentId },
    body: JSON.stringify({ args }),
  })
  const body = await response.json()
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  return body.result
}

/** RSS in MB for every matching process, summed. */
async function rssMb(pattern) {
  const { stdout } = await run('bash', ['-lc', `ps -Ao rss=,command= | grep -F '${pattern}' | grep -v grep || true`])
  let kb = 0
  let count = 0
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    kb += Number(match[1])
    count += 1
  }
  return { mb: kb / 1024, count }
}

const sample = async () => ({
  engine: await rssMb('xlsx-sidecar'),
  server: await rssMb('server/dev-server.ts'),
})

/**
 * Open N copies of one workbook and fit a per-document cost.
 *
 * The engine process is the honest unit: it holds the parsed workbook. The
 * Node server holds only bookkeeping per session -- a name map and a byte
 * count -- and its RSS is dominated by V8, so it is reported but not fitted.
 */
async function slope(documentRoot, count) {
  const { readdir: readDir, copyFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const source = arg('file', 'gamma-heavy-recalc.xlsx')
  const all = await readDir(documentRoot)
  if (!all.includes(source)) throw new Error(`${source} is not in ${documentRoot}`)

  const copies = []
  for (let i = 0; i < count; i += 1) {
    const name = `slope-${i}-${source}`
    if (!all.includes(name)) await copyFile(join(documentRoot, source), join(documentRoot, name))
    copies.push(name)
  }

  const settle = async () => {
    await new Promise((r) => setTimeout(r, 1200))
    return sample()
  }

  /** Open one copy and index its first sheet, the way a reader who scrolls does. */
  async function openOne(name) {
    const file = await invoke(name, 'workbook:select')
    const sheet = file.sheets[0]
    for (let startRow = 0; startRow < sheet.rowCount; startRow += 2_000) {
      await invoke(name, 'workbook:read-range', {
        sessionId: file.sessionId,
        sheetId: sheet.id,
        range: {
          startRow,
          endRow: Math.min(startRow + 1_999, sheet.rowCount - 1),
          startColumn: 0,
          endColumn: Math.max(0, Math.min(sheet.columnCount, 40) - 1),
        },
      })
    }
    return { name, sessionId: file.sessionId }
  }

  const closeAll = async (open) => {
    for (const entry of open) {
      await invoke(entry.name, 'workbook:close', entry.sessionId).catch(() => {})
    }
    return settle()
  }

  const base = await settle()
  console.log(`  slope over ${count} independent copies of ${source}`)
  for (const name of ALLOCATOR_ENV) {
    if (process.env[name]) console.log(`  ${name}=${process.env[name]}`)
  }
  console.log(`  baseline engine ${base.engine.mb.toFixed(1)} MB\n`)
  console.log(`  ${'#'.padStart(3)}  engine RSS   cumulative Δ   per workbook`)
  console.log(`  ${'-'.repeat(3)}  ----------   ------------   ------------`)

  const open = []
  for (const [index, name] of copies.entries()) {
    open.push(await openOne(name))
    const now = await settle()
    const delta = now.engine.mb - base.engine.mb
    console.log(
      `  ${String(index + 1).padStart(3)}  ${now.engine.mb.toFixed(1).padStart(8)}MB  ` +
        `${delta.toFixed(1).padStart(11)}MB  ${(delta / (index + 1)).toFixed(1).padStart(11)}MB`,
    )
  }

  const full = await settle()
  const cost = full.engine.mb - base.engine.mb
  console.log(
    `\n  per resident workbook: ${(cost / count).toFixed(1)} MB ` +
      `(engine), server RSS ${full.server.mb.toFixed(1)} MB`,
  )

  const after = await closeAll(open)
  const reclaimed = ((full.engine.mb - after.engine.mb) / cost) * 100
  console.log(
    `  after closing all ${count}: engine ${after.engine.mb.toFixed(1)} MB ` +
      `(baseline ${base.engine.mb.toFixed(1)} MB) — reclaimed ` +
      `${reclaimed.toFixed(0)}%`,
  )

  const passes = Number(arg('reopen', '0'))
  if (passes <= 0) return

  // What the retained half actually is.
  //
  // RSS that survives a close is either memory the allocator is holding on a
  // free list -- reusable, so a long-lived process never pays for it twice --
  // or memory the engine never released, which is a leak and compounds. The
  // two look identical from outside and have opposite consequences for sizing
  // a box, so open the same N again, repeatedly: a leak keeps climbing by the
  // cost of one pass, a free list plateaus at the first pass's peak.
  console.log(
    `\n  reopening the same ${count}, ${passes}x — a leak reaches ` +
      `${(base.engine.mb + cost * (passes + 1)).toFixed(0)} MB, a free list holds near ` +
      `${full.engine.mb.toFixed(0)} MB\n`,
  )
  console.log(`  ${'pass'.padStart(4)}  resident peak   after close`)
  console.log(`  ${'-'.repeat(4)}  -------------   -----------`)

  let floor = after
  for (let pass = 2; pass <= passes + 1; pass += 1) {
    const again = []
    for (const name of copies) again.push(await openOne(name))
    const peak = await settle()
    floor = await closeAll(again)
    console.log(
      `  ${String(pass).padStart(4)}  ${peak.engine.mb.toFixed(1).padStart(10)}MB  ` +
        `${floor.engine.mb.toFixed(1).padStart(10)}MB`,
    )
  }
}

/**
 * What the second reader of one document costs.
 *
 * The slope above opens N *different* workbooks. Collaboration asks the other
 * question: N people on the SAME workbook. Sessions are keyed by session id,
 * not by document, so today each viewer gets its own snapshot and its own
 * parse -- and if that is what it costs, the ceiling is in viewers, not in
 * documents, which is a different claim than the one this fork has been
 * making.
 */
async function viewers(count) {
  const source = arg('file', 'gamma-heavy-recalc.xlsx')
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 1200))
    return sample()
  }

  const base = await settle()
  console.log(`  ${count} concurrent sessions on ONE document: ${source}`)
  console.log(`  baseline engine ${base.engine.mb.toFixed(1)} MB\n`)
  console.log(`  ${'#'.padStart(3)}  engine RSS   cumulative Δ   per viewer`)
  console.log(`  ${'-'.repeat(3)}  ----------   ------------   ----------`)

  const open = []
  for (let index = 0; index < count; index += 1) {
    const file = await invoke(source, 'workbook:select')
    open.push({ sessionId: file.sessionId })
    const sheet = file.sheets[0]
    for (let startRow = 0; startRow < sheet.rowCount; startRow += 2_000) {
      await invoke(source, 'workbook:read-range', {
        sessionId: file.sessionId,
        sheetId: sheet.id,
        range: {
          startRow,
          endRow: Math.min(startRow + 1_999, sheet.rowCount - 1),
          startColumn: 0,
          endColumn: Math.max(0, Math.min(sheet.columnCount, 40) - 1),
        },
      })
    }
    const now = await settle()
    const delta = now.engine.mb - base.engine.mb
    console.log(
      `  ${String(index + 1).padStart(3)}  ${now.engine.mb.toFixed(1).padStart(8)}MB  ` +
        `${delta.toFixed(1).padStart(11)}MB  ${(delta / (index + 1)).toFixed(1).padStart(10)}MB`,
    )
  }

  const full = await settle()
  const distinct = new Set(open.map((entry) => entry.sessionId)).size
  console.log(
    `\n  ${distinct} distinct session(s) for one document, ` +
      `${((full.engine.mb - base.engine.mb) / count).toFixed(1)} MB per viewer`,
  )
  for (const entry of open) await invoke(source, 'workbook:close', entry.sessionId).catch(() => {})
}

async function main() {
  const viewerCount = Number(arg('viewers', '0'))
  if (viewerCount > 0) return viewers(viewerCount)
  const slopeCount = Number(arg('slope', '0'))
  if (slopeCount > 0) {
    const { documentRoot } = await (await fetch(`${SERVER}/dev-info`)).json()
    return slope(documentRoot, slopeCount)
  }
  const { documentRoot } = await (await fetch(`${SERVER}/dev-info`)).json()
  const names = (await readdir(documentRoot)).filter((n) => /\.xlsx$/i.test(n)).sort()

  const base = await sample()
  console.log(`  corpus ${documentRoot}`)
  console.log(
    `  baseline: engine ${base.engine.mb.toFixed(1)} MB across ${base.engine.count} process(es), ` +
      `server ${base.server.mb.toFixed(1)} MB\n`,
  )
  console.log(`  ${'workbook'.padEnd(44)}  on disk   engine Δ   server Δ   cells`)
  console.log(`  ${'-'.repeat(44)}  --------  --------  ---------  --------`)

  const open = []
  let previous = base
  let totalCells = 0

  for (const name of names) {
    let file
    try {
      file = await invoke(name, 'workbook:select')
    } catch (error) {
      console.log(`  ${name.padEnd(44)}  skipped (${error.code})`)
      continue
    }
    open.push({ name, sessionId: file.sessionId })

    // Read the whole first sheet: a workbook only costs what has been indexed,
    // and a user who never scrolls never pays for the rest. This measures the
    // realistic worst case for one sheet.
    let cells = 0
    const sheet = file.sheets[0]
    for (let startRow = 0; startRow < Math.min(sheet.rowCount, 20_000); startRow += 2_000) {
      const result = await invoke(name, 'workbook:read-range', {
        sessionId: file.sessionId,
        sheetId: sheet.id,
        range: {
          startRow,
          endRow: Math.min(startRow + 1_999, sheet.rowCount - 1),
          startColumn: 0,
          endColumn: Math.max(0, Math.min(sheet.columnCount, 40) - 1),
        },
      })
      cells += result.cells.length
    }
    totalCells += cells

    for (let i = 0; i < REPEAT; i += 1) await new Promise((r) => setTimeout(r, 250))
    const now = await sample()
    console.log(
      `  ${name.padEnd(44)}  ${(file.fileBytes / 1e6).toFixed(1).padStart(6)}MB  ` +
        `${(now.engine.mb - previous.engine.mb).toFixed(1).padStart(7)}MB  ` +
        `${(now.server.mb - previous.server.mb).toFixed(1).padStart(8)}MB  ` +
        `${String(cells).padStart(7)}`,
    )
    previous = now
  }

  const final = await sample()
  const engineTotal = final.engine.mb - base.engine.mb
  const serverTotal = final.server.mb - base.server.mb
  console.log(
    `\n  ${open.length} workbooks resident: engine +${engineTotal.toFixed(1)} MB, ` +
      `server +${serverTotal.toFixed(1)} MB, ${totalCells.toLocaleString()} cells indexed`,
  )
  console.log(
    `  mean per resident workbook: ${((engineTotal + serverTotal) / open.length).toFixed(1)} MB`,
  )

  // What the pool gives back when a user closes a tab.
  for (const entry of open) await invoke(entry.name, 'workbook:close', entry.sessionId).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const closed = await sample()
  console.log(
    `  after closing all: engine ${closed.engine.mb.toFixed(1)} MB ` +
      `(baseline ${base.engine.mb.toFixed(1)} MB), server ${closed.server.mb.toFixed(1)} MB`,
  )
}

await main()
