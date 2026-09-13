#!/usr/bin/env node
/**
 * Phase-02 gate: the HTTP service must agree with a directly-spawned sidecar,
 * over the whole corpus.
 *
 * This is the question that matters for the fork. The desktop app talks to the
 * sidecar in-process; we talk to it across a pool, a session registry, a
 * storage adapter and an HTTP boundary. Every one of those is a chance to
 * lose or mangle something. So for each workbook, open it both ways and
 * compare what comes back -- sheet metadata, then real cell data -- and then
 * save it through the service and check the archive survived.
 *
 * The baseline is the sidecar itself rather than a recorded fixture, so the
 * comparison stays honest when the engine is upgraded.
 *
 *   node tools/compat.mjs [--server http://127.0.0.1:5274] [--keep]
 *
 * Assumes `npm run serve -- --dir <corpus>` is already running against a
 * writable COPY of the corpus, since the save checks mutate documents.
 *
 * It also assumes nothing else is writing that corpus. The run compares each
 * document's bytes before and after its own save, so a browser tab open on the
 * same document saving midway through reports a difference this harness did
 * not cause -- observed exactly once, as three phantom failures.
 *
 * The corpus directory is discovered from the server rather than passed in
 * again. Passing it twice is how this harness first lied: the server served a
 * scratch copy while the baseline was read from web/fixtures, so after the
 * first run the two directories held different bytes and the comparison was
 * between unrelated files. A second run reported three failures that were
 * entirely the harness's own.
 */
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, rm, copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Sidecar } from './sidecar-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const repoRoot = resolve(webRoot, '..')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const SERVER = arg('server', 'http://127.0.0.1:5274')
const BINARY =
  process.env.XLSX_SIDECAR_PATH ??
  join(repoRoot, 'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar')

/** How much of each sheet to compare. Bounded so the run stays quick. */
const SAMPLE_ROWS = 60
const SAMPLE_COLUMNS = 20

async function invoke(documentId, channel, ...args) {
  const response = await fetch(`${SERVER}/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': documentId },
    body: JSON.stringify({ args }),
  })
  const body = await response.json()
  if (body.error) {
    throw Object.assign(new Error(body.error.message), {
      code: body.error.code,
      status: response.status,
    })
  }
  return body.result
}

/**
 * Ask the server which directory it serves, so the baseline and the service
 * can never read different files.
 */
async function discoverCorpus() {
  const response = await fetch(`${SERVER}/dev-info`).catch(() => null)
  if (!response?.ok) {
    throw new Error(
      `${SERVER} is not a dev server with /dev-info. Start it with: npm run serve -- --dir <corpus copy>`,
    )
  }
  const { documentRoot } = await response.json()
  if (!documentRoot) throw new Error('server did not report its document root')
  // This harness SAVES every workbook it checks, in place, through the server.
  // Pointed at web/fixtures that overwrites the corpus -- and the second run
  // then passes, because both sides are reading what the first run wrote.
  // That is how a real fidelity difference can read as a clean gate, so refuse
  // rather than warn.
  if (resolve(documentRoot) === resolve(webRoot, 'fixtures')) {
    throw new Error(
      'the server is serving web/fixtures itself, and this harness saves over what it reads.\n' +
        '  Serve a copy instead:  cp -R fixtures /tmp/corpus && npm run serve -- --dir /tmp/corpus',
    )
  }
  return documentRoot
}

/** Compare only what both sides are supposed to agree on. */
function compareOpen(http, direct) {
  const problems = []
  const httpSheets = http.sheets.map((s) => `${s.name}:${s.rowCount}x${s.columnCount}`)
  const directSheets = direct.sheets.map((s) => `${s.name}:${s.rowCount}x${s.columnCount}`)
  if (httpSheets.join('|') !== directSheets.join('|')) {
    problems.push(`sheets differ: http [${httpSheets}] vs direct [${directSheets}]`)
  }
  for (const field of ['entryCount', 'activeTab']) {
    if (http[field] !== direct[field]) {
      problems.push(`${field}: http ${http[field]} vs direct ${direct[field]}`)
    }
  }
  for (const field of ['styles', 'dxfStyles', 'visuals', 'definedNames']) {
    if (http[field].length !== direct[field].length) {
      problems.push(`${field}: http ${http[field].length} vs direct ${direct[field].length}`)
    }
  }
  return problems
}

/**
 * Read a range, waiting for the engine to finish indexing it.
 *
 * The sidecar indexes lazily and reports how far it has got in
 * `indexedThroughRow`. Comparing two independently-indexed reads without
 * waiting is a race: the same range legitimately returns fewer cells on
 * whichever side is behind, and the harness reports a phantom difference that
 * disappears on the next run. That flakiness was real and is why this exists —
 * a gate that fails at random is worse than no gate.
 */
async function readSettled(read, range, attempts = 40) {
  let result = await read()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (result.indexedThroughRow === null || result.indexedThroughRow >= range.endRow) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
    result = await read()
  }
  return result
}

/**
 * Canonical lines for a range result: sorted, and built from named fields so
 * JSON key order cannot matter. The HTTP side passes through zod, which
 * rebuilds objects in schema order, so a raw stringify would differ on every
 * cell for no reason at all.
 */
function canonicalLines(result) {
  const cells = [...result.cells]
    .sort((a, b) => a.row - b.row || a.column - b.column)
    .map((c) => `cell ${c.row},${c.column} = ${JSON.stringify(c.value ?? null)} f=${c.formula ?? ''}`)
  const merges = [...result.merges]
    .map((m) => `merge ${m.startRow},${m.endRow},${m.startColumn},${m.endColumn}`)
    .sort()
  return [...cells, ...merges]
}

function digestRange(result) {
  return createHash('sha256').update(canonicalLines(result).join('\n')).digest('hex')
}

/** The first few actual differences, so a failure is diagnosable rather than a flag. */
function describeDifference(left, right, limit = 3) {
  const a = canonicalLines(left)
  const b = canonicalLines(right)
  const notes = []
  if (a.length !== b.length) notes.push(`${a.length} lines via http vs ${b.length} direct`)
  const seen = new Set(b)
  for (const line of a) {
    if (notes.length >= limit) break
    if (!seen.has(line)) notes.push(`http-only: ${line}`)
  }
  const other = new Set(a)
  for (const line of b) {
    if (notes.length >= limit + 1) break
    if (!other.has(line)) notes.push(`direct-only: ${line}`)
  }
  return notes
}

async function main() {
  const corpusDir = await discoverCorpus()
  console.log(`  server   ${SERVER}`)
  console.log(`  corpus   ${corpusDir}`)
  const names = (await readdir(corpusDir)).filter((n) => /\.xlsx$/i.test(n)).sort()

  const scratch = await mkdtemp(join(tmpdir(), 'sheets-compat-'))
  const sidecar = new Sidecar(BINARY)

  const rows = []
  let failures = 0
  let skipped = 0

  for (const name of names) {
    const row = { name, open: '-', cells: '-', save: '-', notes: [] }
    let httpFile = null
    try {
      // ── open both ways ──────────────────────────────────────────────────
      httpFile = await invoke(name, 'workbook:select')

      // The direct baseline opens its own private copy, mirroring what the
      // server does, so neither side is reading bytes the other may change.
      // Taken after the HTTP open so both see the same pre-save document.
      const baselineCopy = join(scratch, `baseline-${name}`)
      await copyFile(join(corpusDir, name), baselineCopy)
      const direct = await sidecar.open(baselineCopy, 'en')

      const openProblems = compareOpen(httpFile, direct)
      row.open = openProblems.length === 0 ? 'ok' : 'DIFF'
      row.notes.push(...openProblems)

      // ── compare real cell data, sheet by sheet ──────────────────────────
      let mismatched = 0
      let compared = 0
      // Remembered from the first sheet that has one, to drive the save below.
      let identityEdit = null
      for (const [index, sheet] of httpFile.sheets.entries()) {
        const directSheet = direct.sheets[index]
        if (!directSheet) break
        const range = {
          startRow: 0,
          endRow: Math.max(0, Math.min(SAMPLE_ROWS, sheet.rowCount) - 1),
          startColumn: 0,
          endColumn: Math.max(0, Math.min(SAMPLE_COLUMNS, sheet.columnCount) - 1),
        }
        const [viaHttp, viaDirect] = await Promise.all([
          readSettled(
            () =>
              invoke(name, 'workbook:read-range', {
                sessionId: httpFile.sessionId,
                sheetId: sheet.id,
                range,
              }),
            range,
          ),
          readSettled(() => sidecar.readRange(direct.sessionId, directSheet.id, range), range),
        ])
        compared += viaHttp.cells.length
        if (identityEdit === null) {
          const cell = viaHttp.cells.find((c) => c.value !== null && c.formula === undefined)
          if (cell) {
            identityEdit = {
              sheetId: sheet.id,
              row: cell.row,
              column: cell.column,
              writeValue: true,
              value: cell.value,
            }
          }
        }
        if (digestRange(viaHttp) !== digestRange(viaDirect)) {
          // Re-read both before believing it. The engine discovers merges as
          // it indexes, and `indexedThroughRow` only reports how far *cell*
          // indexing has got — so two sessions over the same file can
          // transiently disagree by one merge with both claiming to be fully
          // indexed. Observed as roughly one run in six reporting a single
          // extra `merge 0,0,0,2`, which a re-read always resolves.
          //
          // A difference that survives a settle and a re-read is real.
          await new Promise((resolve) => setTimeout(resolve, 400))
          const [againHttp, againDirect] = await Promise.all([
            readSettled(
              () =>
                invoke(name, 'workbook:read-range', {
                  sessionId: httpFile.sessionId,
                  sheetId: sheet.id,
                  range,
                }),
              range,
            ),
            readSettled(() => sidecar.readRange(direct.sessionId, directSheet.id, range), range),
          ])
          if (digestRange(againHttp) !== digestRange(againDirect)) {
            mismatched += 1
            row.notes.push(`sheet "${sheet.name}" differs after a re-read`)
            for (const note of describeDifference(againHttp, againDirect)) {
              row.notes.push(`  ${note}`)
            }
          }
        }
      }
      row.cells = mismatched === 0 ? `ok (${compared})` : `DIFF (${mismatched} sheet(s))`
      await sidecar.close(direct.sessionId)

      // ── save round-trip through the service ─────────────────────────────
      if (identityEdit === null) {
        // Nothing constant to write back. Not a failure -- there is simply no
        // identity edit to make on a sheet of formulas or an empty one.
        row.save = 'skip'
        row.notes.push('no constant cell available to drive an identity save')
      } else {
        const before = await readFile(join(corpusDir, name))
        const saved = await invoke(name, 'workbook:save', identitySave(httpFile, identityEdit))
        httpFile = saved.file
        const after = await readFile(join(corpusDir, name))
        const check = await archiveDiff(before, after)
        row.save =
          check.problems.length === 0 ? `ok (${check.identical}/${check.total} kept)` : 'DIFF'
        row.notes.push(...check.problems)
      }
    } catch (error) {
      // Known-unsupported inputs are reported, not counted against the gate:
      // they are tracked phases, not regressions.
      const expected = { password_required: 'encrypted', not_implemented: 'unsupported' }[error.code]
      row.notes.push(`${error.code ?? 'error'}: ${error.message}`)
      const mark = expected ?? 'FAIL'
      if (row.open === '-') row.open = mark
      else if (row.cells === '-') row.cells = mark
      else row.save = mark
    } finally {
      if (httpFile) await invoke(name, 'workbook:close', httpFile.sessionId).catch(() => {})
    }

    const passed = (value) => value.startsWith('ok') || value === 'skip'
    const known = ['encrypted', 'unsupported'].includes(row.open)
    if (known) skipped += 1
    else if (!passed(row.open) || !passed(row.cells) || !passed(row.save)) failures += 1
    rows.push(row)
  }

  await sidecar.dispose()
  if (!process.argv.includes('--keep')) await rm(scratch, { recursive: true, force: true })

  const width = Math.max(...rows.map((r) => r.name.length))
  console.log(`\n  ${'workbook'.padEnd(width)}  open   cells            save`)
  console.log(`  ${'-'.repeat(width)}  -----  ---------------  ----------------`)
  for (const row of rows) {
    console.log(
      `  ${row.name.padEnd(width)}  ${row.open.padEnd(5)}  ${row.cells.padEnd(15)}  ${row.save}`,
    )
    for (const note of row.notes) console.log(`  ${' '.repeat(width)}    ${note}`)
  }

  const checked = rows.length - skipped
  console.log(
    `\n  ${rows.length} workbook(s): ${checked - failures} passing, ${failures} failing, ` +
      `${skipped} skipped as known-unsupported`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * A save carrying one identity edit: a cell written back to the value it
 * already holds.
 *
 * A save with no edits at all is rejected by upstream's own schema, so this is
 * the smallest legal save. It still drives the whole pipeline -- manifest,
 * plan, archive assembly, storage write, session swap -- and it asserts the
 * strongest property available: a save that changes nothing meaningful must
 * leave every other part of the package byte-identical.
 */
function identitySave(file, edit) {
  return {
    sessionId: file.sessionId,
    mode: 'save',
    sheetOps: [],
    sheetOrder: file.sheets.map((s) => s.id),
    edits: [edit],
    structuralOps: [],
    chartEdits: [],
    visualEdits: [],
    filterStates: [],
    hyperlinkEdits: [],
    cfStates: [],
    dvStates: [],
    sheetProtections: [],
    protectedRangeStates: [],
    visualAdditions: [],
    pageSetupStates: [],
    noteStates: [],
    tableAdditions: [],
    pivotAdditions: [],
    sparklineAdditions: [],
    formulaValues: [],
    pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [],
    definedNamesState: null,
    themeState: null,
    workbookProtectionState: null,
  }
}

/** Entry-level comparison of two xlsx archives, by name and CRC. */
async function archiveDiff(beforeBytes, afterBytes) {
  const [before, after] = [readCentralDirectory(beforeBytes), readCentralDirectory(afterBytes)]
  const problems = []
  let identical = 0
  for (const [entryName, entry] of before) {
    if (!after.has(entryName)) {
      if (entryName === CALC_CHAIN) {
        // Not a loss. Any worksheet edit invalidates the calculation chain,
        // so the gateway drops it and lets Excel rebuild it -- deliberate,
        // documented in apps/sheets/docs/compatibility.md, and what Excel
        // itself does. Assert the harder half instead: a dropped part whose
        // content-type override or workbook relationship survives is exactly
        // the dangling reference Excel repairs with a scary prompt.
        problems.push(...danglingCalcChainRefs(afterBytes, after))
        continue
      }
      problems.push(`entry lost: ${entryName}`)
      continue
    }
    if (after.get(entryName).crc === entry.crc) identical += 1
  }
  for (const entryName of after.keys()) {
    if (!before.has(entryName)) problems.push(`entry added: ${entryName}`)
  }
  if (after.size === 0) problems.push('saved archive has no entries')
  return { problems, identical, total: before.size }
}

const CALC_CHAIN = 'xl/calcChain.xml'

/**
 * The parts that must stop mentioning calcChain once it is gone.
 *
 * Excel does not merely tolerate a missing calcChain -- it rebuilds it. What
 * it does not tolerate is a `[Content_Types].xml` override or a workbook
 * relationship naming a part that is not in the package.
 */
function danglingCalcChainRefs(bytes, entries) {
  const problems = []
  for (const [path, pattern] of [
    ['[Content_Types].xml', /PartName="\/xl\/calcChain\.xml"/],
    ['xl/_rels/workbook.xml.rels', /Target="calcChain\.xml"/],
  ]) {
    const entry = entries.get(path)
    if (!entry) {
      problems.push(`calcChain dropped but ${path} is missing from the package`)
      continue
    }
    if (pattern.test(readEntryText(bytes, entry))) {
      problems.push(`calcChain dropped but still referenced from ${path}`)
    }
  }
  return problems
}

/**
 * Entry name -> CRC32, straight from the zip central directory.
 *
 * Read by hand rather than with a zip library: this is the check that the
 * service did not corrupt the archive, so it should not depend on the same
 * library the save path uses to build it.
 */
function readCentralDirectory(bytes) {
  const entries = new Map()
  const view = Buffer.from(bytes)
  // Locate the end-of-central-directory record, scanning back over the comment.
  let eocd = -1
  for (let i = view.length - 22; i >= 0 && i > view.length - 22 - 65_536; i -= 1) {
    if (view.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no EOCD)')
  const count = view.readUInt16LE(eocd + 10)
  let offset = view.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (view.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory')
    const method = view.readUInt16LE(offset + 10)
    const crc = view.readUInt32LE(offset + 16)
    const compressedSize = view.readUInt32LE(offset + 20)
    const nameLength = view.readUInt16LE(offset + 28)
    const extraLength = view.readUInt16LE(offset + 30)
    const commentLength = view.readUInt16LE(offset + 32)
    const localOffset = view.readUInt32LE(offset + 42)
    const name = view.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.set(name, { crc, method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * One entry's bytes as text.
 *
 * Inflated by hand for the same reason the directory is read by hand: this is
 * the check that the save path produced a coherent package, so it must not go
 * through the library that built it. Only the two methods a real xlsx uses.
 */
function readEntryText(bytes, entry) {
  const view = Buffer.from(bytes)
  if (view.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error('corrupt local file header')
  }
  const nameLength = view.readUInt16LE(entry.localOffset + 26)
  const extraLength = view.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const raw = view.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw.toString('utf8')
  if (entry.method === 8) return inflateRawSync(raw).toString('utf8')
  throw new Error(`unsupported zip compression method ${entry.method}`)
}

// Importable for `web/tests/calc-chain.test.ts`, which exercises archiveDiff
// against synthetic packages -- including one this harness must reject.
export { archiveDiff, readCentralDirectory, readEntryText }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(tmpdir(), { recursive: true }).catch(() => {})
  await main()
}
