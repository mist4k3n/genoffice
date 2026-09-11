#!/usr/bin/env node
/**
 * Phase-00 corpus audit.
 *
 * For a directory of .xlsx files, reports:
 *   - container kind (zip vs CFB) and protection/encryption markers
 *   - every formula function used, ranked by occurrence
 *   - which of those Univer's formula engine has a registered executor for
 *   - workbook features that touch fidelity (charts, drawings, pivots, tables,
 *     conditional formatting, data validation, shared/array formulas)
 *
 * Reads upstream and node_modules; writes nothing.
 * Run: npm run audit -- ../test-files
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, extname, join, resolve } from 'node:path'

import JSZip from 'jszip'

const require = createRequire(import.meta.url)

// ── Univer's implemented set ────────────────────────────────────────────────
const engine = require('@univerjs/engine-formula/lib/cjs/index.js')
const implemented = new Set()
for (const key of Object.keys(engine)) {
  const value = engine[key]
  if (!Array.isArray(value) || !Array.isArray(value[0])) continue
  for (const entry of value) {
    const name = entry[1]
    if (typeof name === 'string') implemented.add(name)
  }
}

/**
 * Executors the Sheets app registers itself on top of the engine's builtins.
 * Source: apps/sheets/src/renderer/{cell-function,rate-function,formula-functions}.ts
 * — see function-registry-probe.ts, which treats the live registry as truth.
 */
const appRegistered = new Set(['CELL', 'RATE', 'MINIFS', 'MAXIFS'])

const supported = (name) => implemented.has(name) || appRegistered.has(name)

// ── Formula parsing ─────────────────────────────────────────────────────────
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Strip string literals so their contents never look like calls. */
const stripLiterals = (formula) => formula.replace(/"(?:[^"]|"")*"/g, '""')

/**
 * Excel writes modern functions with an `_xlfn.` prefix (and `_xlws.` for
 * worksheet-scoped ones) for backward compatibility. Engines register the bare
 * name, so normalise before comparing or the whole modern set reads as missing.
 */
const normalise = (name) => name.replace(/^_xlfn\./, '').replace(/^_xlws\./, '')

const CELL_REF = /^\$?[A-Z]{1,3}\$?\d+$/

function functionsIn(formula) {
  const found = []
  for (const match of stripLiterals(formula).matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi)) {
    const raw = match[1]
    const name = normalise(raw).toUpperCase()
    if (!name || CELL_REF.test(name)) continue
    found.push(name)
  }
  return found
}

const decode = (buf) => buf.toString('utf8')

async function auditFile(path) {
  const bytes = readFileSync(path)
  const report = {
    name: basename(path),
    bytes: bytes.length,
    container: bytes.subarray(0, 8).equals(CFB_MAGIC) ? 'CFB (encrypted)' : 'zip',
    encrypted: bytes.subarray(0, 8).equals(CFB_MAGIC),
    sheets: 0,
    formulaCells: 0,
    sharedFormulas: 0,
    arrayFormulas: 0,
    functions: new Map(),
    features: new Set(),
    protection: [],
  }

  if (report.encrypted) return report

  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files)

  const has = (re) => names.some((n) => re.test(n))
  if (has(/^xl\/charts\//)) report.features.add('charts')
  if (has(/^xl\/drawings\//)) report.features.add('drawings')
  if (has(/^xl\/media\//)) report.features.add('media')
  if (has(/^xl\/pivotCache\//)) report.features.add('pivot')
  if (has(/^xl\/tables\//)) report.features.add('tables')
  if (has(/^xl\/sharedStrings\.xml$/)) report.features.add('sharedStrings')
  if (has(/^xl\/comments|^xl\/threadedComments/)) report.features.add('notes')

  const workbook = zip.file('xl/workbook.xml')
  if (workbook) {
    const xml = decode(await workbook.async('nodebuffer'))
    report.sheets = (xml.match(/<(?:\w+:)?sheet\b/g) ?? []).length
    if (/<(?:\w+:)?workbookProtection\b/.test(xml)) {
      const hashed = /workbookPassword=|workbookHashValue=/.test(xml)
      report.protection.push(hashed ? 'workbook (password hash)' : 'workbook (no password)')
    }
    if (/<(?:\w+:)?definedName\b/.test(xml)) report.features.add('definedNames')
  }

  for (const sheetName of names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    const xml = decode(await zip.file(sheetName).async('nodebuffer'))

    const protection = xml.match(/<(?:\w+:)?sheetProtection\b[^>]*>/)
    if (protection) {
      const hashed = /\bpassword=|\bhashValue=/.test(protection[0])
      report.protection.push(
        `${sheetName.replace(/^xl\/worksheets\//, '')} (${hashed ? 'password hash' : 'no password'})`,
      )
    }
    if (/<(?:\w+:)?conditionalFormatting\b/.test(xml)) report.features.add('conditionalFormatting')
    if (/<(?:\w+:)?dataValidation\b/.test(xml)) report.features.add('dataValidation')
    if (/<(?:\w+:)?autoFilter\b/.test(xml)) report.features.add('autoFilter')
    if (/<(?:\w+:)?mergeCell\b/.test(xml)) report.features.add('mergedCells')
    if (/<(?:\w+:)?hyperlink\b/.test(xml)) report.features.add('hyperlinks')

    for (const match of xml.matchAll(/<(?:\w+:)?f\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?f>/g)) {
      const attrs = match[1]
      const body = match[2]
      report.formulaCells += 1
      if (/t="shared"/.test(attrs)) report.sharedFormulas += 1
      if (/t="array"/.test(attrs)) report.arrayFormulas += 1
      if (!body) continue
      const formula = body
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
      for (const fn of functionsIn(formula)) {
        report.functions.set(fn, (report.functions.get(fn) ?? 0) + 1)
      }
    }
    // Self-closing <f .../> carries no body but still marks a formula cell.
    report.formulaCells += (xml.match(/<(?:\w+:)?f\b[^>]*\/>/g) ?? []).length
  }

  return report
}

// ── Run ─────────────────────────────────────────────────────────────────────
const target = resolve(process.argv[2] ?? './fixtures')
if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`Not a directory: ${target}`)
  process.exit(2)
}

const files = readdirSync(target)
  .filter((f) => ['.xlsx', '.xlsm', '.xls'].includes(extname(f).toLowerCase()))
  .sort()

if (files.length === 0) {
  console.error(`No spreadsheets in ${target}`)
  process.exit(2)
}

console.log(`Corpus: ${target}`)
console.log(`Univer implemented executors: ${implemented.size} (+${appRegistered.size} app-registered)\n`)

const reports = []
for (const file of files) reports.push(await auditFile(join(target, file)))

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('FILE', 46) + pad('KB', 7) + pad('SHEETS', 8) + pad('FORMULAS', 10) + 'FEATURES')
console.log('-'.repeat(120))
for (const r of reports) {
  console.log(
    pad(r.name, 46) +
      pad(Math.round(r.bytes / 1024), 7) +
      pad(r.sheets, 8) +
      pad(r.formulaCells, 10) +
      [...r.features].join(' '),
  )
}

console.log('\nPROTECTION / ENCRYPTION')
console.log('-'.repeat(120))
let anyProtection = false
for (const r of reports) {
  if (r.encrypted) {
    anyProtection = true
    console.log(`  ${r.name}: ECMA-376 ENCRYPTED (CFB container) — needs a password to open`)
  } else if (r.protection.length) {
    anyProtection = true
    console.log(`  ${r.name}: ${r.protection.join(', ')} — opens WITHOUT a password`)
  }
}
if (!anyProtection) console.log('  none')

// Aggregate function usage
const totals = new Map()
const byFile = new Map()
for (const r of reports) {
  for (const [fn, n] of r.functions) {
    totals.set(fn, (totals.get(fn) ?? 0) + n)
    if (!byFile.has(fn)) byFile.set(fn, new Set())
    byFile.get(fn).add(r.name)
  }
}

const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
const missing = ranked.filter(([fn]) => !supported(fn))

console.log(`\nFUNCTIONS USED: ${ranked.length} distinct`)
console.log('-'.repeat(120))
console.log(pad('FUNCTION', 22) + pad('USES', 8) + pad('FILES', 8) + 'ENGINE')
for (const [fn, n] of ranked) {
  console.log(pad(fn, 22) + pad(n, 8) + pad(byFile.get(fn).size, 8) + (supported(fn) ? 'ok' : 'MISSING'))
}

console.log('\nVERDICT')
console.log('-'.repeat(120))
if (missing.length === 0) {
  console.log(`  All ${ranked.length} functions used in this corpus have a registered executor.`)
  console.log('  Registration is not proof of correctness — phase 00 still needs the')
  console.log("  value diff against each file's cached <v> results.")
} else {
  console.log(`  ${missing.length} function(s) have NO executor — ranked by occurrence:`)
  for (const [fn, n] of missing) {
    console.log(`    ${pad(fn, 20)} ${n} use(s) across ${byFile.get(fn).size} file(s)`)
  }
  console.log('\n  These recalculate to #NAME? and fall back to the cached value for')
  console.log('  display only. Any edit touching them shows a stale result.')
}
