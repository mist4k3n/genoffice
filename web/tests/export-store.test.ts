import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ExportStore, exportIdentityKey } from '../server/exports'

/**
 * Save As parks bytes on disk between the save that produced them and the
 * fetch that collects them. The failure modes are both quiet: a slot that
 * outlives its fetch fills the scratch directory, and a slot that is
 * redeemable twice hands a workbook to whoever replays the URL.
 */

const identity = { tenantId: 'acme', userId: 'ada', documentId: 'budget.xlsx' }
const other = { ...identity, userId: 'bob' }

async function assembled(bytes = 'workbook'): Promise<{ path: string; workDir: string }> {
  const workDir = await mkdtemp(join(tmpdir(), 'export-test-'))
  await mkdir(workDir, { recursive: true })
  const path = join(workDir, 'budget.xlsx')
  await writeFile(path, bytes)
  return { path, workDir }
}

test('a redeemed token hands over the bytes and removes the scratch copy', async () => {
  const store = new ExportStore()
  const file = await assembled()
  const slot = await store.register({ ...file, name: 'budget.xlsx', identityKey: exportIdentityKey(identity) })
  assert.equal(slot.size, 'workbook'.length)

  const taken = store.take(slot.token, exportIdentityKey(identity))
  assert.equal(await readFile(taken.path, 'utf8'), 'workbook')
  taken.release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(existsSync(file.workDir), false)
})

test('a token is spent by its first use', async () => {
  const store = new ExportStore()
  const file = await assembled()
  const slot = await store.register({ ...file, name: 'budget.xlsx', identityKey: exportIdentityKey(identity) })

  store.take(slot.token, exportIdentityKey(identity)).release()
  assert.throws(() => store.take(slot.token, exportIdentityKey(identity)), /no longer available/)
})

test('another user cannot redeem the token, and it is burned for trying', async () => {
  const store = new ExportStore()
  const file = await assembled()
  const slot = await store.register({ ...file, name: 'budget.xlsx', identityKey: exportIdentityKey(identity) })

  assert.throws(() => store.take(slot.token, exportIdentityKey(other)), /no longer available/)
  // The rightful owner has lost it too. Deliberate: a token someone else has
  // tried to spend is a token that leaked, and the copy is cheap to remake.
  assert.throws(() => store.take(slot.token, exportIdentityKey(identity)), /no longer available/)
})

test('an export nobody collected does not sit in the scratch directory', async () => {
  const store = new ExportStore(1)
  const file = await assembled()
  const slot = await store.register({ ...file, name: 'budget.xlsx', identityKey: exportIdentityKey(identity) })

  await new Promise((resolve) => setTimeout(resolve, 10))
  store.sweep()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(existsSync(file.workDir), false)
  assert.throws(() => store.take(slot.token, exportIdentityKey(identity)), /no longer available/)
})

test('a document id is part of the identity', () => {
  assert.notEqual(
    exportIdentityKey(identity),
    exportIdentityKey({ ...identity, documentId: 'payroll.xlsx' }),
  )
})
