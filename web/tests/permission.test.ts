import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canCopy, canRead, canWrite, type FilePermission } from '../server/ports'
import { readableOrError, readOnlyIfAsked } from '../server/router'
import { isUnmodified } from '../server/channels/save'
import { READ_ONLY_HEADER } from '../protocol'
import type { WorkbookSaveRequest } from '../../apps/sheets/src/shared/desktop-api'

/**
 * The lattice exists because a boolean answered three questions with one bit.
 * These tests pin the three answers, and the one that matters most is the last
 * one: a permission is re-read per request, so a grant revoked mid-session
 * fails on the next call rather than at the next open.
 */

const ALL: FilePermission[] = ['owner', 'admin', 'readwrite', 'readcopy', 'hidden', 'none']

test('the lattice splits read, write and copy where Papan splits them', () => {
  assert.deepEqual(
    ALL.filter(canRead),
    ['owner', 'admin', 'readwrite', 'readcopy'],
  )
  assert.deepEqual(ALL.filter(canWrite), ['owner', 'admin', 'readwrite'])
  // readcopy is the reason any of this exists: a viewer who may take a copy.
  assert.equal(canCopy('readcopy'), true)
  assert.equal(canCopy('hidden'), false)
})

test('hidden is answered as absence, none as refusal', () => {
  // Different answers, not different wording: `hidden` means the caller must
  // not learn the document exists.
  assert.equal(readableOrError({ ...who('hidden') })?.code, 'not_found')
  assert.equal(readableOrError({ ...who('none') })?.code, 'forbidden')
  for (const permission of ALL.filter(canRead)) {
    assert.equal(readableOrError(who(permission)), null)
  }
})

test('a client may ask for less, and is capped at readcopy rather than none', () => {
  const asked = new Request('http://x', { headers: { [READ_ONLY_HEADER]: '1' } })
  // readcopy, not none: the point is a session that reads and cannot write,
  // and none cannot open at all.
  assert.equal(readOnlyIfAsked(who('owner'), asked).permission, 'readcopy')
  assert.equal(readOnlyIfAsked(who('readwrite'), asked).permission, 'readcopy')
})

test('a client may never ask for more', () => {
  const asked = new Request('http://x', { headers: { [READ_ONLY_HEADER]: '1' } })
  const plain = new Request('http://x')
  // The header only ever narrows, and its absence never widens.
  assert.equal(readOnlyIfAsked(who('readcopy'), asked).permission, 'readcopy')
  assert.equal(readOnlyIfAsked(who('none'), asked).permission, 'none')
  assert.equal(readOnlyIfAsked(who('readcopy'), plain).permission, 'readcopy')
})

/**
 * A viewer may take the document away; a viewer may not launder edits through
 * the copy. The check is derived from the payload rather than a field list,
 * because upstream adds mutation kinds regularly.
 */

const empty = (): WorkbookSaveRequest =>
  ({
    sessionId: 's',
    mode: 'save-as',
    edits: [],
    structuralOps: [],
    sheetOps: [],
    definedNamesState: null,
  }) as unknown as WorkbookSaveRequest

test('an untouched save-as is a copy', () => {
  assert.equal(isUnmodified(empty()), true)
})

test('any populated field makes it a change', () => {
  const withEdit = { ...empty(), edits: [{ row: 0 }] } as unknown as WorkbookSaveRequest
  assert.equal(isUnmodified(withEdit), false)
  const withOp = { ...empty(), sheetOps: [{ kind: 'add-sheet' }] } as unknown as WorkbookSaveRequest
  assert.equal(isUnmodified(withOp), false)
})

test('a mutation kind this code has never heard of still counts', () => {
  // The fail-closed property: upstream adds fields, and a hand-written list
  // would quietly stop covering them.
  const future = { ...empty(), somethingUpstreamAddsLater: [{}] } as unknown as WorkbookSaveRequest
  assert.equal(isUnmodified(future), false)
})

function who(permission: FilePermission) {
  return { userId: 'ada', tenantId: 'acme', documentId: 'budget.xlsx', permission }
}
