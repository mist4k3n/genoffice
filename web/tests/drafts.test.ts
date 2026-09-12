import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SessionRegistry } from '../server/sessions'
import type { DraftAdapter, RequestIdentity, StorageAdapter } from '../server/ports'
import { buildDesktopApi } from '../src/host/desktop-api'
import type { HostTransport } from '../src/host/transport'
import { DRAFT_RESTORED_KEY } from '../protocol'

/**
 * A draft is unsaved work, and the whole value of keeping it is that it comes
 * back. The two ways of getting that wrong are opposite and both quiet:
 * ignoring a draft that still applies loses work, and honouring one that no
 * longer applies reapplies edits to a document that has moved on.
 */

const identity: RequestIdentity = {
  userId: 'ada',
  tenantId: 'acme',
  documentId: 'budget.xlsx',
  canEdit: true,
}

/** Minimal .xlsx: a zip local-file header is all the format sniffer reads. */
const workbook = (tag: string): Uint8Array => {
  const body = new TextEncoder().encode(tag.padEnd(64, ' '))
  const out = new Uint8Array(4 + body.length)
  out.set([0x50, 0x4b, 0x03, 0x04])
  out.set(body, 4)
  return out
}

function storageAt(version: string): StorageAdapter {
  return {
    head: async () => ({ version, name: 'budget.xlsx', byteLength: 68 }),
    get: async () => ({ bytes: workbook('STORED'), version, name: 'budget.xlsx' }),
    put: async () => ({ version, name: 'budget.xlsx', byteLength: 68 }),
  }
}

function draftsAt(baseVersion: string | null) {
  const deleted: string[] = []
  const adapter: DraftAdapter = {
    put: async () => {},
    get: async () =>
      baseVersion === null ? null : { bytes: workbook('DRAFT'), baseVersion },
    delete: async (who) => void deleted.push(who.documentId),
  }
  return { adapter, deleted }
}

async function registryWith(storage: StorageAdapter, drafts: DraftAdapter): Promise<SessionRegistry> {
  return new SessionRegistry({
    storage,
    drafts,
    scratchDir: await mkdtemp(join(tmpdir(), 'draft-test-')),
    locale: 'en',
    quota: { maxSessionsPerTenant: 8, maxResidentBytesPerTenant: 1 << 30, idleTimeoutMs: 60_000 },
    // prepareSnapshot never reaches the engine: it produces the bytes an open
    // would hold, and opening them is the caller's next step.
    pool: null as never,
  })
}

test('a draft whose base still matches is what the session opens', async () => {
  const drafts = draftsAt('v1')
  const registry = await registryWith(storageAt('v1'), drafts.adapter)

  const snapshot = await registry.prepareSnapshot(identity)

  assert.equal(snapshot.fromDraft, true)
  assert.match(await readFile(snapshot.snapshotPath, 'latin1'), /DRAFT/)
  // The storage version, not the draft's identity: a save from this session
  // must still compare against the document the draft was edited from.
  assert.equal(snapshot.version, 'v1')
  assert.deepEqual(drafts.deleted, [])
  await snapshot.cleanup()
})

test('a draft whose document has moved is dropped, not offered', async () => {
  const drafts = draftsAt('v1')
  const registry = await registryWith(storageAt('v2'), drafts.adapter)

  const snapshot = await registry.prepareSnapshot(identity)

  assert.equal(snapshot.fromDraft, undefined)
  assert.match(await readFile(snapshot.snapshotPath, 'latin1'), /STORED/)
  // Deleted rather than kept: those edits describe a version that is gone, and
  // an undeletable stale draft would be offered again on every open.
  assert.deepEqual(drafts.deleted, ['budget.xlsx'])
  await snapshot.cleanup()
})

test('with no draft the session opens what storage holds', async () => {
  const drafts = draftsAt(null)
  const registry = await registryWith(storageAt('v1'), drafts.adapter)

  const snapshot = await registry.prepareSnapshot(identity)

  assert.equal(snapshot.fromDraft, undefined)
  assert.match(await readFile(snapshot.snapshotPath, 'latin1'), /STORED/)
  await snapshot.cleanup()
})

test('the restore marker reaches the host and never the renderer', async () => {
  let restored = 0
  const transport: HostTransport = {
    invoke: async <T,>(): Promise<T> =>
      ({ sessionId: 's', name: 'budget.xlsx', [DRAFT_RESTORED_KEY]: true }) as T,
    subscribe: () => () => {},
    fetchBytes: async () => new Uint8Array(),
    dispose: () => {},
  }
  const api = buildDesktopApi(transport, { onDraftRestored: () => void (restored += 1) })

  const file = (await api.selectWorkbook()) as Record<string, unknown>

  assert.equal(restored, 1)
  // Upstream's workbookFileSchema is .strict() and its renderer has no concept
  // of a draft, so the marker must not survive the bridge.
  assert.equal(DRAFT_RESTORED_KEY in file, false)
  assert.equal(file.sessionId, 's')
})
