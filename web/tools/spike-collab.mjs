#!/usr/bin/env node
/**
 * Collaboration spike: what two people on one document cost today.
 *
 * Two questions this answers by measurement rather than by reading code.
 *
 * 1. Does a second viewer of the same document cost a second parse?
 *    Sessions are keyed by session id, not by document, so each open takes its
 *    own snapshot and its own engine session. If that is what it costs, the
 *    ceiling this fork has been quoting is in *viewers*, not in documents.
 *
 * 2. What happens when they do share a path? Papan's storage is
 *    content-addressed, so `localPath()` hands both sessions the same file --
 *    and the engine's recalc cache is keyed by path. It keeps a resident
 *    IronCalc model plus the edits applied to it, and reuses it only when
 *    every applied edit is also in the incoming request. Two people editing
 *    different cells never satisfy that, so each request should throw away the
 *    other's model and reload the workbook.
 *
 *   node tools/spike-collab.mjs --file large-450000.xlsx
 *   SERVER_ARGS=--direct-read BENCH=tools/spike-collab.mjs npm run bench:linux -- --file …
 */
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}
const SERVER = arg('server', 'http://127.0.0.1:5274')

async function invoke(documentId, channel, ...args) {
  const response = await fetch(`${SERVER}/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-document-id': documentId },
    body: JSON.stringify({ args }),
  })
  const body = await response.json()
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code })
  return body.result
}

const millis = async (work) => {
  const started = performance.now()
  await work()
  return performance.now() - started
}

/** One recalc: set a cell, read it back. The cell differs per writer. */
function recalc(documentId, session, column) {
  const sheetId = session.sheets[0].id
  return invoke(documentId, 'workbook:recalc', {
    sessionId: session.sessionId,
    edits: [{ sheetId, row: 0, column, input: `=1+${column}` }],
    reads: [{ sheetId, range: { startRow: 0, endRow: 0, startColumn: column, endColumn: column } }],
  })
}

async function main() {
  const file = arg('file', 'gamma-heavy-recalc.xlsx')
  const { documentRoot, directRead } = await (await fetch(`${SERVER}/dev-info`)).json()
  console.log(`  corpus ${documentRoot}`)
  console.log(`  localPath (content-addressed fast path): ${directRead ? 'on' : 'off'}\n`)

  const alice = await invoke(file, 'workbook:select')
  const bob = await invoke(file, 'workbook:select')
  console.log(`  two opens of ${file} produced ${new Set([alice.sessionId, bob.sessionId]).size} session(s)`)
  console.log(`  same snapshot path: ${alice.snapshotPath === bob.snapshotPath ? 'yes' : 'not reported to the client'}\n`)

  // Alice alone: the second request should reuse the resident model.
  const cold = await millis(() => recalc(file, alice, 1))
  const warm = await millis(() => recalc(file, alice, 1))
  console.log(`  alice, first recalc   ${cold.toFixed(0).padStart(6)} ms  (loads the model)`)
  console.log(`  alice, same edit      ${warm.toFixed(0).padStart(6)} ms  (resident)`)

  // Now Bob, on his own cell. If the cache is shared by path, this evicts her
  // model, and her next request evicts his.
  const rounds = []
  for (let i = 0; i < 3; i += 1) {
    rounds.push(await millis(() => recalc(file, bob, 2)))
    rounds.push(await millis(() => recalc(file, alice, 1)))
  }
  console.log(`  alternating, 6 turns  ${rounds.map((ms) => ms.toFixed(0)).join(' / ')} ms`)

  const mean = rounds.reduce((a, b) => a + b, 0) / rounds.length
  console.log(
    `\n  mean while alternating ${mean.toFixed(0)} ms, against ${warm.toFixed(0)} ms alone ` +
      `— ${(mean / Math.max(warm, 1)).toFixed(1)}x`,
  )

  await invoke(file, 'workbook:close', alice.sessionId).catch(() => {})
  await invoke(file, 'workbook:close', bob.sessionId).catch(() => {})
}

await main()
