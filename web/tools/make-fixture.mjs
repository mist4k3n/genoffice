#!/usr/bin/env node
/**
 * Build a large .xlsx, because the corpus does not contain one.
 *
 * The memory question that matters to Papan is per-document RSS for a *heavy*
 * workbook -- their Collabora ceiling is ~145 MB settled for one. The corpus
 * tops out at 0.4 MB, so measuring against it answers a smaller question than
 * the one being asked. This generates a workbook of a requested size so the
 * scaling can be measured rather than extrapolated from one point.
 *
 * Deliberately plain: numbers, a formula column, and a styled header. No shared
 * strings, so the file is dominated by cell data rather than a string table --
 * which is what a financial model looks like, and which is the case the
 * streaming reader has to handle.
 *
 *   node tools/make-fixture.mjs --rows 200000 --out fixtures/large-200k.xlsx
 */
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// jszip comes from the repo root, the same place the gateway gets it.
const require = createRequire(import.meta.url)
const JSZip = require('jszip')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const rows = Number(arg('rows', '100000'))
const out = resolve(arg('out', 'fixtures/large.xlsx'))
/** A1-style column letters, for the 12 data columns below. */
const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']

function sheetXml(rowCount) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:L${rowCount + 1}"/>`,
    '<sheetData>',
    '<row r="1">',
    ...COLUMNS.map((c, i) => `<c r="${c}1" t="inlineStr" s="1"><is><t>Col${i + 1}</t></is></c>`),
    '</row>',
  ]
  for (let r = 2; r <= rowCount + 1; r += 1) {
    parts.push(`<row r="${r}">`)
    for (let i = 0; i < COLUMNS.length - 1; i += 1) {
      // Values with real decimal places: a workbook of round integers
      // compresses far better than a real one and would flatter the result.
      parts.push(`<c r="${COLUMNS[i]}${r}"><v>${((r * 37 + i * 911) % 100000) / 100}</v></c>`)
    }
    // One formula column, so the file exercises the formula paths too.
    parts.push(`<c r="L${r}"><f>SUM(A${r}:K${r})</f><v>0</v></c>`)
    parts.push('</row>')
  }
  parts.push('</sheetData></worksheet>')
  return parts.join('')
}

const zip = new JSZip()
zip.file(
  '[Content_Types].xml',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>',
)
zip.file(
  '_rels/.rels',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>',
)
zip.file(
  'xl/workbook.xml',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>',
)
zip.file(
  'xl/_rels/workbook.xml.rels',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>',
)
zip.file(
  'xl/styles.xml',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '</styleSheet>',
)
zip.file('xl/worksheets/sheet1.xml', sheetXml(rows))

const bytes = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
})
await writeFile(out, bytes)
console.log(
  `  ${out}\n  ${rows.toLocaleString()} rows x ${COLUMNS.length} columns, ` +
    `${(rows * COLUMNS.length).toLocaleString()} cells, ` +
    `${(bytes.byteLength / 1_048_576).toFixed(1)} MB on disk`,
)
