#!/usr/bin/env node
/**
 * Phase-00: what does the sidecar actually extract for charts, images, shapes
 * and pivots?
 *
 * The requirement list calls for "images, pivot, any figure". The audit tool
 * only reports which OOXML parts exist in the zip; this one asks the Rust
 * engine what it made of them, which is the thing that matters.
 *
 * Run: npm run visuals -- ./fixtures
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { Sidecar } from './sidecar-client.mjs'

const BINARY = resolve(
  import.meta.dirname,
  '../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar',
)

const dump = process.argv.includes('--dump')
const first = process.argv.slice(2).find((a) => !a.startsWith('--'))
const target = resolve(first ?? './fixtures')

if (!statSync(BINARY, { throwIfNoEntry: false })) {
  console.error(`Sidecar binary not found: ${BINARY}\nBuild:  npm run native:build -w @genoffice/sheets`)
  process.exit(2)
}

const files = readdirSync(target)
  .filter((f) => ['.xlsx', '.xlsm'].includes(extname(f).toLowerCase()))
  .sort()

const sidecar = new Sidecar(BINARY)
const rows = []

for (const file of files) {
  const row = { file, sheets: 0, visuals: 0, kinds: new Map(), pivots: 0, tables: 0,
    mediaOk: 0, mediaFailed: 0, mediaBytes: 0, mediaTypes: new Map(), mediaErrors: new Set(), error: null }
  try {
    const opened = await sidecar.open(join(target, file))

    if (dump) {
      console.log(`\n--- ${file}: top-level keys ---`)
      console.log(Object.keys(opened).join(', '))
      const sample = (opened.visuals ?? [])[0]
      if (sample) {
        console.log(`--- first visual ---`)
        console.log(JSON.stringify(sample, null, 2).slice(0, 1200))
      }
    }

    row.sheets = (opened.sheets ?? []).length
    for (const sheet of opened.sheets ?? []) {
      row.pivots += (sheet.pivotTables ?? []).length
      row.tables += (sheet.tables ?? []).length
    }
    for (const visual of opened.visuals ?? []) {
      row.visuals += 1
      const kind = visual.kind ?? visual.type ?? (visual.chart ? 'chart' : 'unknown')
      row.kinds.set(kind, (row.kinds.get(kind) ?? 0) + 1)
    }

    // Extraction metadata is only half the story: the renderer has to be able to
    // fetch the actual bytes. read_media is the command that does it, so pull
    // every image and check the payload really is the declared format.
    const images = (opened.visuals ?? []).filter((v) => v.kind === 'image')
    for (const image of images) {
      try {
        const media = await sidecar.send('read_media', {
          sessionId: opened.sessionId,
          visualId: image.id,
        })
        const base64 = media?.data ?? media?.base64 ?? media?.bytes
        if (typeof base64 !== 'string' || base64.length === 0) {
          row.mediaFailed += 1
          row.mediaErrors.add('empty payload')
          continue
        }
        const bytes = Buffer.from(base64, 'base64')
        const type = media.mediaType ?? image.mediaType ?? ''
        const looksRight =
          (type.includes('png') && bytes.subarray(1, 4).toString('latin1') === 'PNG') ||
          (type.includes('svg') && bytes.subarray(0, 200).toString('latin1').includes('<svg')) ||
          (type.includes('jpeg') && bytes[0] === 0xff && bytes[1] === 0xd8) ||
          (!type.includes('png') && !type.includes('svg') && !type.includes('jpeg'))
        if (looksRight) {
          row.mediaOk += 1
          row.mediaBytes += bytes.length
          row.mediaTypes.set(type, (row.mediaTypes.get(type) ?? 0) + 1)
        } else {
          row.mediaFailed += 1
          row.mediaErrors.add(`payload is not ${type}`)
        }
      } catch (error) {
        row.mediaFailed += 1
        row.mediaErrors.add(String(error?.message ?? error).slice(0, 60))
      }
    }

    await sidecar.close(opened.sessionId)
  } catch (error) {
    row.error = String(error?.message ?? error)
  }
  rows.push(row)
}

await sidecar.dispose()

const pad = (s, n) => String(s).padEnd(n)
console.log(`\nVisual extraction — ${target}\n`)
console.log(pad('FILE', 30) + pad('SHEETS', 8) + pad('VISUALS', 9) + pad('PIVOTS', 8) + pad('TABLES', 8) + pad('MEDIA OK', 10) + pad('FAIL', 6) + 'KINDS')
console.log('-'.repeat(112))
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.file, 30) + `ERROR: ${r.error}`)
    continue
  }
  const kinds = [...r.kinds.entries()].map(([k, n]) => `${k}×${n}`).join(' ')
  console.log(
    pad(r.file, 30) + pad(r.sheets, 8) + pad(r.visuals, 9) + pad(r.pivots, 8) + pad(r.tables, 8) +
      pad(r.mediaOk, 10) + pad(r.mediaFailed, 6) + kinds,
  )
}

const totals = rows.reduce(
  (acc, r) => ({
    visuals: acc.visuals + r.visuals,
    pivots: acc.pivots + r.pivots,
    tables: acc.tables + r.tables,
  }),
  { visuals: 0, pivots: 0, tables: 0 },
)
console.log(
  `\n  ${totals.visuals} visual(s), ${totals.pivots} pivot table(s), ${totals.tables} table(s) across ${rows.length} file(s)`,
)
const media = rows.reduce((a, r) => ({ ok: a.ok + r.mediaOk, bad: a.bad + r.mediaFailed, bytes: a.bytes + r.mediaBytes }), { ok: 0, bad: 0, bytes: 0 })
if (media.ok || media.bad) {
  console.log(`  read_media: ${media.ok} image(s) returned valid bytes, ${media.bad} failed (${(media.bytes / 1024).toFixed(0)} KB total)`)
  const types = new Map()
  for (const r of rows) for (const [t, n] of r.mediaTypes) types.set(t, (types.get(t) ?? 0) + n)
  if (types.size) console.log(`  media types: ${[...types].map(([t, n]) => `${t}×${n}`).join(', ')}`)
  for (const r of rows) if (r.mediaErrors.size) console.log(`  ${r.file}: ${[...r.mediaErrors].join('; ')}`)
}
console.log('  Extraction only — rendering fidelity is a browser question, not a sidecar one.')
