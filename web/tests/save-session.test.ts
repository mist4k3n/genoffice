import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { workbookSaveRequestSchema } from '../../apps/sheets/src/shared/desktop-api'
import type { StorageAdapter } from '../server/ports'
import { createSheetsRouter, type SheetsRouter } from '../server/router'

/**
 * What a save does to the session that made it.
 *
 * Upstream's renderer is written against the desktop contract: a save returns
 * a *fresh* session over the saved bytes, the renderer installs it, and then it
 * closes the session it replaced. The server used to keep the client's id
 * across a save instead, so that close landed on the session the tab was about
 * to read through: every read after a browser save answered 410 and the grid
 * went blank. Papan found it; nothing here drove a save and then kept reading.
 *
 * These drive the renderer's exact sequence over HTTP -- save, read, close the
 * replaced id, read again -- and check what the other tab is told.
 */

const SIDECAR =
  process.env['XLSX_SIDECAR_PATH'] ??
  new URL('../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar', import.meta.url)
    .pathname
const FIXTURE = new URL('../fixtures/acme-budget.xlsx', import.meta.url)
const skip = !existsSync(SIDECAR) || !existsSync(FIXTURE)

/** One document whose stored bytes and version follow every put. */
function storage(): StorageAdapter {
  let bytes: Uint8Array = new Uint8Array(readFileSync(FIXTURE))
  let version = 1
  const meta = () => ({
    version: `v${version}`,
    name: 'acme-budget.xlsx',
    byteLength: bytes.byteLength,
  })
  return {
    head: async () => meta(),
    get: async () => ({ bytes, ...meta() }),
    put: async (_id, next) => {
      bytes = next
      version += 1
      return meta()
    },
  }
}

async function withRouter(run: (router: SheetsRouter) => Promise<void>): Promise<void> {
  const router = createSheetsRouter({
    storage: storage(),
    identify: () => ({
      userId: 'u1',
      tenantId: 't1',
      documentId: 'doc-1',
      permission: 'readwrite',
    }),
    sidecar: { poolSize: 1, binaryPath: SIDECAR },
  })
  try {
    await run(router)
  } finally {
    await router.dispose()
  }
}

async function invoke(
  router: SheetsRouter,
  channel: string,
  args: readonly unknown[],
): Promise<{ status: number; result: unknown; error?: { code: string } }> {
  const response = await router.app.request(`/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': 'doc-1' },
    body: JSON.stringify({ args }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { code: string } }
  return {
    status: response.status,
    result: body.result,
    ...(body.error ? { error: body.error } : {}),
  }
}

interface File {
  readonly sessionId: string
  readonly sheets: readonly { readonly id: string }[]
}

const open = async (router: SheetsRouter): Promise<File> => {
  const opened = await invoke(router, 'workbook:select', [])
  assert.equal(opened.status, 200, JSON.stringify(opened.error))
  return opened.result as File
}

const read = (router: SheetsRouter, sessionId: string, sheetId: string) =>
  invoke(router, 'workbook:read-range', [
    { sessionId, sheetId, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 } },
  ])

/**
 * A save with one cell edit, built from upstream's own schema: every required
 * field gets the emptiest value it accepts, so the request stays valid when
 * upstream adds a field rather than this test quietly rotting.
 */
function oneCellSave(file: File, value: string): unknown {
  const shape = workbookSaveRequestSchema.shape as Record<
    string,
    { safeParse(v: unknown): { success: boolean } }
  >
  const request: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(shape)) {
    if (field.safeParse(undefined).success) continue
    // The emptiest value each required field accepts: no edits of that kind.
    const empty = [[], {}, null, false].find((candidate) => field.safeParse(candidate).success)
    if (empty !== undefined) request[key] = empty
  }
  return {
    ...request,
    sessionId: file.sessionId,
    mode: 'save',
    edits: [{ sheetId: file.sheets[0]!.id, row: 0, column: 0, writeValue: true, value }],
  }
}

test(
  'a save returns a fresh session, and the replaced one survives until it is closed',
  { skip },
  async () => {
    await withRouter(async (router) => {
      const before = await open(router)
      const saved = await invoke(router, 'workbook:save', [oneCellSave(before, 'first')])
      assert.equal(saved.status, 200, JSON.stringify(saved.error))
      const after = (saved.result as { file: File }).file

      assert.notEqual(
        after.sessionId,
        before.sessionId,
        'the desktop contract: a new session per save',
      )

      // The renderer's reads already in flight carry the old id; they finish.
      assert.equal((await read(router, before.sessionId, before.sheets[0]!.id)).status, 200)

      // Then it installs the new file and closes the one it replaced.
      assert.equal((await invoke(router, 'workbook:close', [before.sessionId])).status, 200)

      // The session it kept is the one it reads through from now on.
      const next = await read(router, after.sessionId, after.sheets[0]!.id)
      assert.equal(
        next.status,
        200,
        `read after close answered ${next.status}: ${JSON.stringify(next.error)}`,
      )
    })
  },
)

test('a second save from the same tab lands', { skip }, async () => {
  await withRouter(async (router) => {
    let file = await open(router)
    for (const value of ['first', 'second']) {
      const saved = await invoke(router, 'workbook:save', [oneCellSave(file, value)])
      assert.equal(saved.status, 200, `save "${value}": ${JSON.stringify(saved.error)}`)
      const next = (saved.result as { file: File }).file
      await invoke(router, 'workbook:close', [file.sessionId])
      file = next
    }
    assert.equal((await read(router, file.sessionId, file.sheets[0]!.id)).status, 200)
  })
})

test('the saving tab is not told its own save moved the document', { skip }, async () => {
  await withRouter(async (router) => {
    const saver = await open(router)
    const other = await open(router)

    const pushes: string[] = []
    router.attachSocket('doc-1', { send: (data) => void pushes.push(data) })

    await invoke(router, 'workbook:save', [oneCellSave(saver, 'mine')])
    const conflict = pushes
      .map((data) => JSON.parse(data) as { args?: unknown[] })
      .find((message) => JSON.stringify(message).includes('conflict'))
    assert.ok(conflict, 'the other tab hears about the save')
    const named = JSON.stringify(conflict)
    assert.ok(named.includes(other.sessionId), 'the other viewer is named stale')
    assert.ok(!named.includes(saver.sessionId), 'the saver, one step behind its own save, is not')
  })
})
