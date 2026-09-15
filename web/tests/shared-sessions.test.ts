import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { DraftAdapter, StorageAdapter } from '../server/ports'
import { createSheetsRouter, type SheetsRouter } from '../server/router'

/**
 * Several people looking at one workbook must cost one workbook.
 *
 * Before this, sessions were keyed by session id and every open took its own
 * snapshot and parsed the file again: a second reader of a 30.9 MB document
 * cost 22.4 MB, exactly what a second document cost (FINDINGS-COLLAB.md §1).
 * The engine session is now shared and refcounted, and the client's handle is
 * a separate, stable id.
 *
 * Sharing is only correct while it is invisible, so these check the seams:
 * the bytes two clients get, what a save does to a session someone else holds,
 * and the two cases that must *not* share.
 */

const SIDECAR =
  process.env['XLSX_SIDECAR_PATH'] ??
  new URL('../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar', import.meta.url)
    .pathname

const FIXTURE = new URL('../fixtures/acme-budget.xlsx', import.meta.url)
const skip = !existsSync(SIDECAR) || !existsSync(FIXTURE)

/** One document, whose version the test can move under an open session. */
function storageAt(version: { current: string }): StorageAdapter {
  const bytes = () => new Uint8Array(readFileSync(FIXTURE))
  return {
    head: async () => ({
      version: version.current,
      name: 'acme-budget.xlsx',
      byteLength: bytes().byteLength,
    }),
    get: async () => ({ bytes: bytes(), version: version.current, name: 'acme-budget.xlsx' }),
    put: async () => ({ version: 'v-next', name: 'acme-budget.xlsx', byteLength: 0 }),
  }
}

interface Caller {
  readonly userId: string
}

async function withRouter(
  run: (router: SheetsRouter, version: { current: string }) => Promise<void>,
  drafts?: DraftAdapter,
): Promise<void> {
  const version = { current: 'v1' }
  const caller = { userId: 'u1' }
  const router = createSheetsRouter({
    storage: storageAt(version),
    identify: (request: Request) => ({
      userId: request.headers.get('x-user') ?? caller.userId,
      tenantId: 't1',
      documentId: 'doc-1',
      permission: 'readwrite' as const,
    }),
    sidecar: { poolSize: 1, binaryPath: SIDECAR },
    ...(drafts ? { drafts } : {}),
  })
  try {
    await run(router, version)
  } finally {
    await router.dispose()
  }
}

async function invoke(
  router: SheetsRouter,
  channel: string,
  args: readonly unknown[],
  as: Caller = { userId: 'u1' },
): Promise<{ status: number; body: { result?: unknown; error?: { code: string } } }> {
  const response = await router.app.request(`/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': 'doc-1', 'x-user': as.userId },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

const open = async (router: SheetsRouter, as?: Caller) => {
  const { body } = await invoke(router, 'workbook:select', [], as)
  assert.ok(body.result, `open failed: ${JSON.stringify(body.error)}`)
  return body.result as { sessionId: string; sheets: { id: string }[]; sha256: string }
}

const readA1 = (router: SheetsRouter, file: { sessionId: string; sheets: { id: string }[] }, as?: Caller) =>
  invoke(
    router,
    'workbook:read-range',
    [
      {
        sessionId: file.sessionId,
        sheetId: file.sheets[0]!.id,
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      },
    ],
    as,
  )

/** Viewers and the workbooks behind them. Resident bytes vary with the fixture. */
const counts = async (router: SheetsRouter): Promise<{ sessions: number; workbooks: number }> => {
  const response = await router.app.request('/health')
  const body = (await response.json()) as { sessions: { sessions: number; workbooks: number } }
  const { sessions, workbooks } = body.sessions
  return { sessions, workbooks }
}

test('two viewers of one document hold one workbook', { skip }, async () => {
  await withRouter(async (router) => {
    const alice = await open(router)
    const bob = await open(router)

    assert.notEqual(alice.sessionId, bob.sessionId, 'each client gets its own handle')
    assert.equal(alice.sha256, bob.sha256, 'and they are looking at the same bytes')
    assert.deepEqual(await counts(router), { sessions: 2, workbooks: 1 })

    // Both handles work. The sidecar knows only its own session id, so this
    // is also the check that the substitution happens on every read.
    for (const file of [alice, bob]) {
      const read = await readA1(router, file)
      assert.equal(read.status, 200, JSON.stringify(read.body.error))
    }
  })
})

test('the workbook closes when the last viewer leaves, not the first', { skip }, async () => {
  await withRouter(async (router) => {
    const alice = await open(router)
    const bob = await open(router)

    await invoke(router, 'workbook:close', [alice.sessionId])
    assert.deepEqual(await counts(router), { sessions: 1, workbooks: 1 }, 'still open for bob')

    const stillReads = await readA1(router, bob)
    assert.equal(stillReads.status, 200, 'closing one viewer must not close the other')
    // Alice's handle is gone, and says so as a dead session rather than as a
    // permission error: a caller probing ids learns nothing.
    const dead = await readA1(router, alice)
    assert.equal(dead.body.error?.code, 'session_gone')

    await invoke(router, 'workbook:close', [bob.sessionId])
    assert.deepEqual(await counts(router), { sessions: 0, workbooks: 0 })
  })
})

test('a document that moves is a second workbook, never a shared stale one', { skip }, async () => {
  await withRouter(async (router, version) => {
    await open(router)
    version.current = 'v2'
    await open(router)
    // The share key carries the storage version precisely so the second
    // opener cannot join a session holding the pre-save bytes.
    assert.deepEqual(await counts(router), { sessions: 2, workbooks: 2 })
  })
})

test('a handle still belongs to the caller who opened it', { skip }, async () => {
  await withRouter(async (router) => {
    const alice = await open(router, { userId: 'alice' })
    const stolen = await readA1(router, alice, { userId: 'mallory' })
    assert.equal(stolen.body.error?.code, 'session_gone', 'sharing an engine is not sharing a handle')
  })
})

test('a draft is one user’s unsaved work and is never shared', { skip }, async () => {
  const drafts: DraftAdapter = {
    get: async (identity) =>
      identity.userId === 'alice'
        ? { bytes: new Uint8Array(readFileSync(FIXTURE)), baseVersion: 'v1' }
        : null,
    put: async () => {},
    delete: async () => {},
  }
  await withRouter(async (router) => {
    await open(router, { userId: 'alice' })
    await open(router, { userId: 'bob' })
    // Alice is reading her own edits; Bob is reading storage. Same document,
    // same version, different bytes -- so two workbooks is the right answer.
    assert.deepEqual(await counts(router), { sessions: 2, workbooks: 2 })
  }, drafts)
})
