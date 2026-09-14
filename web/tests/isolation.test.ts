import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'

import {
  FRAME_PROTOCOL,
  frameOrigin,
  isFrameCommand,
  isFrameMessage,
} from '../src/embed/frame-protocol'
import { SETTLE_MS, trackWorkbookUnit, type UniverPermissionLike } from '../src/embed/read-only'

/**
 * Two editors visible at once need two realms, because Univer names its
 * internal editor hosts with fixed element ids. The frame is that second
 * realm, and the wire to it is a postMessage channel -- which means the page
 * now hears from something it did not write, so every message is checked.
 */

test('a frame message must be tagged, and tagged with something we send', () => {
  const good = { protocol: FRAME_PROTOCOL, kind: 'open', config: {} }
  assert.equal(isFrameCommand(good), true)
  // What a page actually receives: extensions, analytics, other frames.
  assert.equal(isFrameCommand({ kind: 'open' }), false, 'untagged')
  assert.equal(isFrameCommand({ protocol: 'other', kind: 'open' }), false, 'someone else’s tag')
  assert.equal(isFrameCommand({ protocol: FRAME_PROTOCOL, kind: 'evil' }), false, 'unknown kind')
  assert.equal(isFrameCommand(null), false)
  assert.equal(isFrameCommand('open'), false)

  assert.equal(isFrameMessage({ protocol: FRAME_PROTOCOL, kind: 'hello' }), true)
  // The two directions are separate vocabularies, and neither accepts the
  // other's: a frame cannot drive its own embedder by echoing a command back.
  assert.equal(isFrameMessage({ protocol: FRAME_PROTOCOL, kind: 'open' }), false)
  assert.equal(isFrameCommand({ protocol: FRAME_PROTOCOL, kind: 'return', id: 1 }), false)
})

test('the frame is addressed at an origin, never a wildcard', () => {
  assert.equal(frameOrigin('sheets-frame.html', 'https://papan.example/app/x'), 'https://papan.example')
  assert.equal(frameOrigin('/sheets-frame.html', 'https://papan.example/app/x'), 'https://papan.example')
  assert.equal(frameOrigin('https://cdn.example/f.html', 'https://papan.example/'), 'https://cdn.example')
})

/** A workbook that records what was asked of it, the way Univer's facade behaves. */
function fakeUniver(unitId = 'file-abc'): {
  api: UniverPermissionLike
  editable: boolean
  calls: boolean[]
} {
  const state = {
    editable: true,
    calls: [] as boolean[],
    api: {} as UniverPermissionLike,
  }
  state.api = {
    getActiveWorkbook: () => ({
      getId: () => unitId,
      setEditable: (value: boolean) => {
        state.editable = value
        state.calls.push(value)
        return undefined
      },
    }),
  }
  return state
}

/**
 * The bug this guards is not "read-only lets you type" -- it is the opposite,
 * and it is worse. Univer's permission gate is a command interceptor keyed by
 * command id, and the renderer fills the grid through the very commands it
 * intercepts. A locked workbook therefore refuses the *loader*, silently: the
 * document renders as an empty grid of the right size. Shipped and measured.
 */
test('the lock stands aside the instant data arrives, and comes back when it stops', async () => {
  const univer = fakeUniver()
  const gate = trackWorkbookUnit(() => univer.api, { readOnly: true, report: () => {} })
  try {
    // Idle: locked, which is the whole point of read-only.
    await sleep(250)
    assert.equal(univer.editable, false, 'an idle viewer is locked')

    // A response arrived. The renderer applies it in the continuation of that
    // call, so this has to take effect now, not at the next poll.
    gate.noteServerData()
    assert.equal(univer.editable, true, 'unlocked synchronously, before any await')

    // A burst keeps it open rather than flapping once per response.
    for (let i = 0; i < 4; i += 1) {
      await sleep(80)
      gate.noteServerData()
      assert.equal(univer.editable, true, 'still open mid-burst')
    }

    await sleep(SETTLE_MS + 300)
    assert.equal(univer.editable, false, 'locked again once the traffic stops')
  } finally {
    gate.stop()
  }
})

test('an editable editor never touches the permission', async () => {
  const univer = fakeUniver()
  const gate = trackWorkbookUnit(() => univer.api, { readOnly: false, report: () => {} })
  try {
    await sleep(250)
    gate.noteServerData()
    await sleep(250)
    assert.deepEqual(univer.calls, [], 'no setEditable at all')
    assert.equal(univer.editable, true)
  } finally {
    gate.stop()
  }
})

test('a viewer sharing a unit with an editor hands the permission back', async () => {
  // Two editors on one document in one realm share a Univer unit, because
  // upstream names a workbook after its content hash. Locking the viewer would
  // freeze the editor's unsaved work -- measured, and the reason the compare
  // view now runs in its own frame instead.
  const viewer = fakeUniver('file-shared')
  const gate = trackWorkbookUnit(() => viewer.api, { readOnly: true, report: () => {} })
  try {
    await sleep(250)
    assert.equal(viewer.editable, false, 'locked while alone')

    const editorUniver = fakeUniver('file-shared')
    const warnings: string[] = []
    const editor = trackWorkbookUnit(() => editorUniver.api, {
      readOnly: false,
      report: (message) => void warnings.push(message),
    })
    try {
      await sleep(400)
      assert.equal(viewer.editable, true, 'the editor outranks the viewer’s affordance')
    } finally {
      editor.stop()
    }
  } finally {
    gate.stop()
  }
})
