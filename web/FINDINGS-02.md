# Phase 02 — Hono server kernel

Status: **partially met.** The upstream renderer opens a real `.xlsx` from a
real `StorageAdapter`, through a pooled Rust sidecar, over Hono — and renders
it. Thirteen of the fifty-nine channels are served. The save pipeline is not
built, so the phase gate (`npm run compat` over the corpus) is not yet claimed.

```sh
cd web
npm run serve    # terminal 1 — Sheets server on :5274, serving web/fixtures
npm run dev      # terminal 2 — app on :5273
# then open http://localhost:5273/?doc=acme-budget.xlsx
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
| Development host: filesystem storage, dev identity, real WebSocket | `server/dev-server.ts` |

Coverage went from 10 invoke / 40 todo to **13 invoke / 37 todo**, and the probe
still reports *no unimplemented method reached* — now with a workbook on screen
rather than an empty shell.

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

## Three defects found by running it

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

## Not done in this phase

- The save pipeline: journal, part surgery, write-through, version-token bump,
  conflict rejection. This is what the phase gate needs.
- The other 37 channels, including `read-formulas`, `read-media`,
  `read-pivot-definition` and `recalc`.
- Encrypted workbooks. `SecretsAdapter` exists as a port; nothing consumes it,
  and the server must sniff CFB magic itself because the sidecar reports an
  encrypted file as `Could not find EOCD`, indistinguishable from corruption
  (`FINDINGS-00.md`).
- Sessions opened without a socket (an AI agent, a server-side job) fall back to
  the 15-minute idle sweep. Correct, but it means the socket-bound cleanup is
  not a complete answer on its own.

## Next

Phase 03 — the save pipeline and document lifecycle, which is what closes the
phase-02 gate, followed by the read channels the viewport depends on.
