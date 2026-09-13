import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import { test } from 'node:test'

// @ts-expect-error -- a .mjs tool with no type declarations, imported for the
// one function worth testing outside a live server.
import { archiveDiff } from '../tools/compat.mjs'

/**
 * A save that touches any worksheet drops `xl/calcChain.xml`.
 *
 * That is deliberate and documented (`apps/sheets/docs/compatibility.md`):
 * calcChain is a recalculation-order cache, any worksheet edit can invalidate
 * it, and overwriting a formula cell with a literal leaves an entry pointing
 * at a cell with no `<f>` -- which Excel repairs with a scary prompt. Excel
 * drops it too. `compat` used to count that as three lost entries and three
 * failing workbooks, on the three fixtures that happen to ship a calcChain.
 *
 * Whitelisting the name would have turned a false failure into no check at
 * all. The check that replaced it is the one that can actually go wrong: the
 * part is gone, so nothing may still point at it. These tests are here because
 * a check that has never been seen to fail is not yet a check.
 */

const CONTENT_TYPES_WITH = `<?xml version="1.0"?><Types xmlns="x">` +
  `<Override PartName="/xl/workbook.xml" ContentType="wb"/>` +
  `<Override PartName="/xl/calcChain.xml" ContentType="cc"/></Types>`
const CONTENT_TYPES_WITHOUT = `<?xml version="1.0"?><Types xmlns="x">` +
  `<Override PartName="/xl/workbook.xml" ContentType="wb"/></Types>`
const RELS_WITH = `<?xml version="1.0"?><Relationships xmlns="r">` +
  `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Target="calcChain.xml"/></Relationships>`
const RELS_WITHOUT = `<?xml version="1.0"?><Relationships xmlns="r">` +
  `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`

/**
 * A stored-method zip, written by hand.
 *
 * The harness reads archives by hand so that it does not depend on the library
 * the save path builds them with; a test that fed it a library's output would
 * give that independence away.
 */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0, 10) // stored
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const before = zip({
  '[Content_Types].xml': CONTENT_TYPES_WITH,
  'xl/_rels/workbook.xml.rels': RELS_WITH,
  'xl/workbook.xml': '<workbook/>',
  'xl/calcChain.xml': '<calcChain><c r="A1" i="1"/></calcChain>',
})

test('dropping calcChain with its references is not a lost entry', async () => {
  const after = zip({
    '[Content_Types].xml': CONTENT_TYPES_WITHOUT,
    'xl/_rels/workbook.xml.rels': RELS_WITHOUT,
    'xl/workbook.xml': '<workbook/>',
  })
  const { problems, total } = await archiveDiff(before, after)
  assert.deepEqual(problems, [])
  assert.equal(total, 4, 'the dropped part still counts in the before total')
})

test('a surviving content-type override is reported', async () => {
  const after = zip({
    '[Content_Types].xml': CONTENT_TYPES_WITH,
    'xl/_rels/workbook.xml.rels': RELS_WITHOUT,
    'xl/workbook.xml': '<workbook/>',
  })
  const { problems } = await archiveDiff(before, after)
  assert.deepEqual(problems, [
    'calcChain dropped but still referenced from [Content_Types].xml',
  ])
})

test('a surviving workbook relationship is reported', async () => {
  const after = zip({
    '[Content_Types].xml': CONTENT_TYPES_WITHOUT,
    'xl/_rels/workbook.xml.rels': RELS_WITH,
    'xl/workbook.xml': '<workbook/>',
  })
  const { problems } = await archiveDiff(before, after)
  assert.deepEqual(problems, [
    'calcChain dropped but still referenced from xl/_rels/workbook.xml.rels',
  ])
})

test('every other part is still expected to survive a save', async () => {
  // The exemption is for one named part and nothing else. A save that loses a
  // worksheet must still fail, calcChain in the package or not.
  const after = zip({
    '[Content_Types].xml': CONTENT_TYPES_WITHOUT,
    'xl/_rels/workbook.xml.rels': RELS_WITHOUT,
  })
  const { problems } = await archiveDiff(before, after)
  assert.deepEqual(problems, ['entry lost: xl/workbook.xml'])
})

test('an added entry is still reported', async () => {
  const after = zip({
    '[Content_Types].xml': CONTENT_TYPES_WITHOUT,
    'xl/_rels/workbook.xml.rels': RELS_WITHOUT,
    'xl/workbook.xml': '<workbook/>',
    'xl/sharedStrings.xml': '<sst/>',
  })
  const { problems } = await archiveDiff(before, after)
  assert.deepEqual(problems, ['entry added: xl/sharedStrings.xml'])
})
