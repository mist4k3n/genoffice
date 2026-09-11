# Phase 02 — Hono server kernel

Status: **gate met.** The upstream renderer opens a real `.xlsx` from a real
`StorageAdapter`, through a pooled Rust sidecar, over Hono, renders it, and
saves it back with every untouched part byte-identical. Seventeen of the
fifty-nine channels are served.

`npm run compat` — the phase gate — passes over the corpus: **6,061 cells
compared across 14 workbooks with zero mismatches**, every archive entry
preserved, the one encrypted fixture correctly skipped as known-unsupported.

```sh
cd web
cp -r fixtures /tmp/corpus              # the save checks mutate documents
npm run serve -- --dir /tmp/corpus      # terminal 1 — server on :5274
npm run dev                             # terminal 2 — app on :5273
npm run compat                          # terminal 3 — the gate
# or open http://localhost:5273/?doc=acme-budget.xlsx
```

## What runs

| Piece | File |
| --- | --- |
| Host-facing ports: storage, identity, secrets, quotas | `server/ports.ts` |
| Coded errors the browser can branch on | `server/errors.ts` |
| Sidecar pool with session affinity and crash recovery | `server/sidecar/pool.ts` |
| Session registry, snapshots, quotas, idle reaping | `server/sessions.ts` |
| Runtime-agnostic push, and socket-bound session lifetime | `server/push.ts` |
| The Hono router | `server/router.ts` |
| 10 boot channels | `server/channels/app.ts` |
| open / read-range / close | `server/channels/workbook.ts` |
| Save + the chunked edit transfer | `server/channels/save.ts` |
| Verbatim mirror of upstream's `writeWorkbookTo` | `server/channels/save-plan.ts` |
| Encrypted / legacy-xls detection | `server/workbook-format.ts` |
| Development host: filesystem storage, dev identity, real WebSocket | `server/dev-server.ts` |

Coverage went from 10 invoke / 40 todo to **17 invoke / 33 todo**, and the probe
still reports *no unimplemented method reached* — now with a workbook on screen
rather than an empty shell. The browser's own network log shows the ten boot
channels, then `workbook:select`, then `workbook:read-range` per viewport
chunk, all 200.

## Verified against the running server, not asserted

- `acme-budget.xlsx` opens end to end: 1 sheet, 7 entries, 2 styles, sha256 over
  the snapshot bytes, and `A1:F12` returning 47 real cells.
- The renderer renders it. Its own status line reads *"Workbook fully loaded —
  formulas recalculate live, rows/columns editable."*
- Two open workbooks land on two different processes (`perProcess [1,1,0,0]`),
  so least-loaded placement works.
- Killing **all four** sidecar processes under an open session: the loss is
  detected, the session is invalidated, the next read returns `410 session_gone`
  immediately instead of hanging for the 30s request timeout, a
  `sheets:session-lost` frame reaches that document's socket, and the pool
  returns to four warm processes.
- A session survives a socket blip and dies when the socket really goes.
- A save writes through: `A1` "Line" becomes "PHASE-02-SAVED" on disk, only
  `xl/worksheets/sheet1.xml` is rewritten, the other six entries stay
  byte-identical, and the archive passes an independent integrity check.
- A concurrent write is rejected `409 version_conflict` carrying
  `currentVersion`, so the client can rebase rather than only be told no.

Security paths, all checked against the live server:

| Case | Result |
| --- | --- |
| Valid sessionId used under a different document id | `410 session_gone` — no leak, and no confirmation the id exists |
| Unknown but well-formed session uuid | `410 session_gone` |
| Reversed range | `400 invalid_request`, upstream's own message |
| Extra field in the request | `400` — upstream's schemas are `.strict()` |
| Path traversal in the document id | `400 invalid_request` |
| Missing document | `404 not_found` |
| No identity | `401` |
| Unimplemented channel | `501` |

## Four defects found by running it

**The coverage table's channel names were invented.** 32 of 59 were wrong:
`workbook:select` had been written `sheets:select-workbook`,
`shell:open-external` as `sheets:open-external`. Nothing caught it — the typed
table detects a renamed *method*, but a channel is only a string, and the mock
server had retyped the same names and was wrong identically, so every request
returned 200. One was live rather than pending. Fixed by importing
`IPC_CHANNELS` instead of retyping, plus `npm run check:channels`, which
re-derives every entry from the preload source.

**A browser refresh leaked a session.** Measured: one reload took the open
session count from 2 to 3. Upstream closes a window's sessions when its renderer
is destroyed; on the web nothing calls `closeWorkbook`, so the workbook stayed
resident for fifteen minutes. A handful of refreshes would exhaust a tenant's
quota with nothing actually open. The socket is the web's equivalent of that
destroyed renderer, so session lifetime is now bound to it, behind a 45s grace
longer than the client's 15s reconnect backoff.

**Errors pointed at the wrong component.** A blocked path traversal returned
`sidecar_failed`, and a missing document returned a 500 carrying the server's
absolute filesystem path to the browser.

**The compat harness lied, in my favour.** It took the corpus directory as its
own flag while the server took it separately, so once the first run had saved
anything the two pointed at different bytes — and the second run reported three
`entryCount` failures that were entirely the harness's own. (The underlying
difference was legitimate: a save drops `xl/calcChain.xml`, which is what Excel
does when a cell changes.) The harness now discovers the directory from the
server, so the two cannot disagree.

## Decisions

**The pool polls for liveness, and that is a workaround.** `XlsxSidecarClient`
has no exit callback: it rejects in-flight requests, nulls its process, and
respawns lazily on the next request with every session inside it gone. Nothing
tells the pool. Watching the pid works, but an `onExit` hook upstream would
delete the whole mechanism — now tracked in `DRIFT.md`.

**The server does not own the WebSocket.** The upgrade differs per runtime
(`@hono/node-ws`, Bun, Deno, Cloudflare), and picking one would pin the client's
Hono app to it. The host attaches anything that can `send` a string.

**No second copy of zod.** Upstream's schemas resolve zod from the repo root;
installing our own would make every `instanceof ZodError` silently false. Zod
errors are detected structurally instead.

**A DOM-free tsconfig for the server is not possible without drift.** It would
be better — it would have caught the `Set<WebSocket>` — but upstream's shared
modules are compiled with DOM by both its projects, and `shared/desktop-api.ts`
type-imports `@genoffice/ui`, so the compile fails inside upstream's own
sources. `npm run check:server` enforces the rule on our files instead.

## One copy of upstream code, deliberately

`server/channels/save-plan.ts` is a **verbatim mirror** of `writeWorkbookTo`
from `sheets-main.ts` — the fork's only copied implementation.

It is a pure function that reads nothing but the save request and the session's
sheetId→name map, and it would be importable if upstream exported it. It does
not: it is module-local inside a 4,000-line file that imports `electron`.

Rewriting it was the alternative and a worse one. Nearly every one of its 259
lines resolves a sheetId for a different feature of the format — structural
ops, filters, hyperlinks, conditional formatting, data validation, protections,
page setup, notes, tables, pivots, sparklines, theme, defined names,
recalculated values. A reimplementation would have to reproduce each branch
exactly and would lose fidelity silently wherever it did not.

`npm run check:mirror` hashes upstream's version and fails when it changes,
telling you to re-copy rather than reconcile by hand. An upstream PR exporting
the function would delete the file.

## Not done in this phase

- **Save As.** It means "create a different document", which needs a
  document-create port. Refused with a 501 rather than silently overwriting the
  document the user was branching from.
- The other 33 channels, including `read-formulas`, `read-media`,
  `read-pivot-definition` and `recalc`.
- **Decrypting** encrypted workbooks. They are now *detected* and answered with
  `428 password_required` instead of an EOCD error indistinguishable from
  corruption, and `SecretsAdapter` exists as a port — but nothing consumes it.
- Legacy `.xls` is detected and refused with an explanation rather than
  mis-reported as corrupt.
- Sessions opened without a socket (an AI agent, a server-side job) fall back to
  the 15-minute idle sweep. Correct, but it means the socket-bound cleanup is
  not a complete answer on its own.

## Next

Phase 03 — browser document lifecycle: the remaining read channels
(`read-formulas`, `read-media`, `read-pivot-definition`, `recalc`), Save As
against a document-create port, and the `beforeunload` path that replaces the
desktop's close-save prompt.
