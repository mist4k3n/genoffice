# Sheets on the web: phase-by-phase implementation plan

Status: plan only; no code landed. Target is a browser Sheets editor consumed by
a React frontend and a Hono backend, replacing a Collabora deployment that
saturates at ~10 concurrent clients.

This fork must stay rebasable against `upstream/main` indefinitely. That
constraint drives the entire architecture below, and it rules out the obvious
approach of extracting `apps/sheets/src/**` into packages.

## The governing invariant

> `git diff upstream/main -- . ':!web'` is empty. Always.

Every line this fork adds lives under `web/`. No file that exists upstream is
ever modified, moved, or deleted. Git only reports a conflict when both sides
change the same file, so `git rebase upstream/main` cannot conflict — there is
nothing on our side for it to collide with.

This document lives at `web/PLAN.md` rather than `docs/` for the same reason.

### Why extraction was rejected

The earlier draft of this plan proposed extracting `domain/`, `gateway/`,
`shared/` and `renderer/` into six packages. That is better code and it is the
wrong trade here. It is a large in-place file move across `apps/sheets/`, which
upstream develops continuously. Renames plus upstream edits to the renamed files
produce conflicts on every rebase, forever. The cost compounds; the benefit does
not.

If package extraction is still wanted for its own sake, the correct route is a
PR to `genspark-ai/genoffice` — behavior-neutral refactors are exactly what
upstream can absorb. Merged upstream it costs nothing to maintain. Carried as a
fork delta it is a permanent tax.

## Why this works: three pre-existing seams

None of this required upstream to change. All three properties already hold.

**1. The renderer's only host coupling is one global.**
`window.desktopApi` — 80 call sites, ~59 methods. Plus `window.projectApi` in
exactly 3 places, all already optional-chained. The renderer imports nothing
from `src/main/` or `src/preload/`, and has zero `node:` or `electron` imports.

**2. Upstream already supports running hostless.**
`apps/sheets/src/renderer/main.tsx` guards every bridge call, with comments
saying "dev renderer without the preload bridge" and "standalone runs have no
`app:get-theme` handler". The standalone mode is intentional, not accidental.

**3. The renderer is already a plain Vite React app.**
`apps/sheets/vite.renderer.config.ts` is `root: 'src/renderer'` plus
`@vitejs/plugin-react`, nothing else. `npm run dev:renderer -w @genoffice/sheets`
already serves it on :5174 for HMR. It builds for a browser today.

So the web app is not a port. It is the same renderer, served by our own Vite
config, with `window.desktopApi` implemented over HTTP instead of IPC.

## Performance: the shim costs nothing

This needs stating plainly because it is the obvious objection and it is wrong.

The shim adds **zero runtime cost**. `window.desktopApi` is a plain object of
async functions — the preload implementation is `validate → ipcRenderer.invoke →
parse`, and the HTTP implementation is `validate → fetch → parse`. Same shape, no
proxy, no extra serialization hop, no added indirection.

Vite aliasing into `../apps/sheets/src/**` emits **byte-identical bundles** to
importing the same files from a `packages/sheets-react`. Same source, same
tree-shaking, same code splitting. A bundler does not care where files sit on
disk.

**The real performance risk is lazy streaming, and it is identical under every
architecture.** `read_range` was cheap over stdio and is not cheap over HTTP.
Extraction into packages does not improve it by one millisecond. The levers that
actually matter are:

- batching viewport range requests instead of issuing them per-visible-block
- prefetching in the scroll direction
- a server-side range cache keyed by `(sessionId, sheetId, range)`
- napi-rs on the server (phase 06) if process-per-session dominates

None of those depend on repo layout. Choose the layout for maintainability and
rebase cost; fix performance in phases 03 and 06 where it actually lives.

## SDK ergonomics without drift

The published package surface is independent of the source layout. This is the
other objection worth answering directly: consumers must never write
`import ... from '../apps/sheets/src/renderer/...'`, and they will not.

```
web/packages/sheets-react/
  src/index.ts        export { SheetsEditor } from './SheetsEditor'
  tsup.config.ts      bundles aliased upstream source; rolls up .d.ts
web/packages/sheets-client/    the DesktopApi-over-HTTP implementation
web/packages/sheets-server/    the Hono router
```

```ts
// what your app writes
import { SheetsEditor } from '@mist4k3n/sheets-react'
import { createSheetsRouter } from '@mist4k3n/sheets-server'
```

Bundle the declarations (`tsup --dts`, or api-extractor) so the published `.d.ts`
inlines upstream types rather than referencing paths consumers cannot resolve.
The relative-path ugliness is confined to one build config in `web/` and is
invisible downstream. Clean SDK and clean rebase are not in tension.

## Architecture

```
apps/  packages/  tools/  docs/  e2e/   <- untouched, byte-identical to upstream
web/                                     <- the entire fork delta
  package.json          own deps, own lockfile (root workspaces never edited)
  vite.config.ts        aliases into ../apps/sheets/src/**
  tsconfig.json
  DRIFT.md              watch list of upstream files we mirror
  src/
    index.html          our CSP, our entry
    bootstrap.ts        sets window.desktopApi, then imports upstream main.tsx
    host-http.ts        implements DesktopApi over fetch + WebSocket
  server/
    router.ts           Hono routes mirroring the 49 ipcMain handlers
    sidecar-pool.ts     pooled xlsx-sidecar processes
    session.ts          sessionId <-> user <-> document binding
    storage.ts          StorageAdapter port (you inject S3/GCS/whatever)
    encryption.ts       ECMA-376, phase 05
    agent.ts            agent loop, phase 04
  tools/
    check-drift.mjs     CI: fails if a watched upstream file changed
```

`web/` is its own npm root with its own lockfile. That is deliberate: adding
`web/*` to the root `package.json` `workspaces` array would modify an upstream
file and break the invariant for the sake of one line.

### The bootstrap

```ts
// web/src/bootstrap.ts
import { createHttpDesktopApi } from './host-http'

window.desktopApi = createHttpDesktopApi({
  baseUrl: import.meta.env.VITE_SHEETS_API,
  documentId: new URLSearchParams(location.search).get('doc')!,
})

// upstream's entry, imported unmodified
await import('../../apps/sheets/src/renderer/main')
```

### Free drift detection

`apps/sheets/src/shared/desktop-api.ts` is a TypeScript interface. Our host
implements it:

```ts
export function createHttpDesktopApi(opts: Opts): DesktopApi { /* ... */ }
```

When upstream adds or changes a method, **our build fails with a type error
naming exactly what changed**. No watching, no diffing, no discipline required.
The same applies to `ipc-channels.ts`: key the Hono routes off the upstream
channel constants and a renamed channel becomes a compile error rather than a
404 at runtime.

This is the strongest argument for the shim approach over extraction. Extraction
gives you cleaner code and manual drift tracking. The shim gives you messier
imports and automatic drift tracking. For a fork that must rebase forever, the
second is worth more.

## What we reuse vs. rewrite

| Reused unmodified (by import) | Lines |
| --- | --- |
| `src/renderer/**` | ~98k |
| `src/gateway/**` | ~13.2k |
| `src/domain/**` | ~5.8k |
| `src/shared/**` (as the contract we implement) | ~3.4k |
| `src/main/xlsx-sidecar-client.ts` | 317 |
| `native/xlsx-engine/**` (Rust) | ~17.5k |

| Rewritten in `web/server/` | Why |
| --- | --- |
| The 49 `ipcMain` handler bodies in `sheets-main.ts` | Electron-shaped: `ipcMain`, `dialog`, `BrowserWindow`, `app.getPath`. The heavy lifting they call into is imported, not copied |
| Window/menu/dialog lifecycle | No equivalent on a server |
| `temp-files.ts`, `recovery-policy.ts` | Filesystem and crash semantics differ |

`sheets-main.ts` is the one file whose *behavior* we mirror without importing.
It goes on the drift watch list. Note that this is a review task on a file that
rebases cleanly, not a merge conflict.

## The `path` field

The upstream contract passes `path: string` throughout — 61 fields. Do not
change it. The server issues opaque handles and passes them *as* that string
(`doc://<uuid>`), so the contract is untouched and the renderer is none the
wiser.

Caveat to verify in phase 01: a few renderer sites derive a display name from the
path. Check whether any of them parse it structurally rather than just showing
it. If one does, supply a path-shaped opaque token instead
(`/workspace/<uuid>/<filename>.xlsx`) rather than modifying upstream.

## Collaboration: architecture decision

Three constraints:

1. **Univer's collaboration is not open source.** It lives in `@univerjs-pro/*`
   — 27 packages published with npm license `"None"`. This repo deliberately
   hand-wrote its own `createUniver` (`apps/sheets/src/renderer/create-univer.ts`)
   to avoid pulling them in; the comment says "collaboration mode intentionally
   omitted". Enabling it means a commercial licence from DreamNum.
2. **Univer is OT-shaped, not CRDT-shaped.** It is built on commands and
   mutations. A Yjs bridge needs mutation↔`Y.Doc` mapping, echo suppression, and
   undo reconciliation between `IUndoRedoService` and `Y.UndoManager`.
3. **Lazy streaming fights CRDT directly.** Sheets never holds a whole workbook
   in the browser — it streams viewport ranges from the sidecar (`read_range`)
   and keeps an `edit-journal.ts` overlay. A `Y.Doc` wants the whole document.

**Decision: server-authoritative op log, not a CRDT cell model.** The server
assigns a monotonic sequence number per operation and holds the authoritative
`in-memory-workbook`. Yjs carries presence only — cursors, selections, names.

This reuses `workbook-dsl.ts` and `op-executor.ts` unchanged, preserves lazy
streaming, and produces a server-side audit log for free. It also matches the
direction upstream already took for Slides: see `docs/slides-op-journal.md`,
where every applied transaction is appended to a per-session `opLog` with a
monotonic `seq`. Follow that precedent rather than inventing a second model —
and it means a future upstream collaboration feature is likely to be *compatible*
with this choice rather than in conflict with it.

The trade: no offline editing with automatic merge. Every client must be
connected to commit. For a shared financial workbook that is usually correct
anyway — silent CRDT merges of concurrent row inserts produce results no
accountant can explain.

## Requirement status

| Requirement | State | Notes |
| --- | --- | --- |
| Open/save `.xlsx` | **have** | Save is zip-part surgery in the sidecar (`save_archive`), not a re-serialize — unmodeled parts survive round-trip |
| AI agent over the workbook | **have** | `domain/workbook-dsl.ts` (Zod op DSL) → `ChangePlan` → `op-executor.ts`, the same path the ribbon uses. `AgentTransport` is already an interface |
| Images, shapes, charts | **have** | `visuals.rs` reads, `WorkbookVisuals.tsx` renders, `gateway/xlsx-*` writes |
| React + Hono + JS SDK | **have** | Renderer is React 19, zero `node:` imports |
| Open `.xls` | **partial** | Read only, via `convert_workbook` (calamine) → xlsx temp copy. No save-back to `.xls`; Excel behaves the same |
| Pivot tables | **partial** | Create/edit/refresh/slicers/timelines exist, but rebuild-on-refresh, not Excel's live pivot cache. Output cells are baked and edit-protected |
| Excel formulas | **partial** | Univer `@univerjs/engine-formula` covers most builtins; repo patches `CELL`, `RATE`, `MINIFS`/`MAXIFS`, lexer, null results, IFS empty-set, `_xlfn.` future functions. Missing functions fall back to the file's cached `<v>` — correct on open, stale after an edit. **Dynamic arrays, spill, `LET`, `LAMBDA`, `XLOOKUP`, `FILTER`/`SORT`/`UNIQUE` unverified — see phase 00** |
| Password-protected workbooks | **missing** | Every `hasPassword` in Sheets is worksheet/workbook *protection*, not encryption. Real ECMA-376 decryption exists only in `apps/docs/src/main/docx-encryption.ts` |
| Real-time collaboration | **missing** | The only requirement that is a project rather than a task |

## Phase map

| # | Phase | Rough | Unblocks |
| --- | --- | --- | --- |
| 00 | Audit and spikes | 1–2 wk | everything; has a stop criterion |
| 01 | `web/` scaffold and HTTP host | 2–3 wk | 02 |
| 02 | Hono server kernel | 3–4 wk | 03, 04, 05 |
| 03 | Document lifecycle and browser UX | 2 wk | 04 |
| 04 | AI agent server-side | 1–2 wk | **MVP ships** |
| 05 | Encrypted workbooks | 1–2 wk | parallel with 03–04 |
| 06 | Load profile and napi-rs | 1–2 wk | the Collabora comparison |
| 07 | Presence | 2 wk | 08 |
| 08 | Shared editing | 6–10 wk | real collaboration |
| 09 | Parity backlog | ongoing | — |

Roughly 10–14 weeks to MVP for one to two engineers. That is shorter than the
extraction-based plan by about a month, because phases 01 and 02 of that plan
(package extraction, host abstraction) no longer exist.

Durations are calibration, not commitment. Phase 00 is what turns them into
defensible estimates.

---

## Phase 00 — Audit and spikes

Cheapest phase, highest information. No production code.

### Spike first: does the renderer boot in a browser?

One day. Serve `apps/sheets/src/renderer` with a plain Vite config, inject a stub
`window.desktopApi` whose methods reject, and load it in Chrome. If the shell
renders — ribbon, empty grid, dialogs — the entire architecture above is
validated. If it does not, find out why now.

### Formula coverage

1. Collect 20–50 real client workbooks, including encrypted ones and the largest.
2. Install deps, enumerate the live Univer function registry via
   `apps/sheets/src/renderer/function-registry-probe.ts`. Extract every function
   name used across the corpus and diff against the registry.
3. **Rank misses by occurrence.** One unsupported function in one file is noise;
   `XLOOKUP` in forty files is a schedule change.
4. Test specifically for dynamic arrays and spill, `LET`, `LAMBDA`, `XLOOKUP`,
   `FILTER`/`SORT`/`UNIQUE`. These could not be verified from source.

### Fidelity

1. Open each workbook and diff every recalculated value against the file's cached
   `<v>`. Mismatches are bugs the client will find first otherwise.
2. Round-trip each file (open, save, reopen) and compare OOXML parts.

### Encryption spike and baseline

1. Two days: does `officecrypto-tool` decrypt *and re-encrypt* the actual
   protected `.xlsx` files, Standard and Agile both, such that Excel reopens the
   result?
2. Record open time, peak memory and save time per file — under Collabora today
   and under the Electron app. This is the comparison to quote later.

**Stop criterion:** if functions the client's models depend on are missing from
the engine, the work becomes upstream formula-engine development and the
timeline is a different conversation. Discover this in week one.

---

## Phase 01 — `web/` scaffold and HTTP host

The phase that replaces "extraction" and "host abstraction" from the earlier
plan. Nothing outside `web/` is touched.

1. **Scaffold `web/`** as an independent npm root: own `package.json`, own
   lockfile, own `tsconfig.json`. Root workspaces stays untouched.
2. **Vite config** with `root: 'web/src'` and aliases resolving
   `@genoffice/*` and relative reaches into `../apps/sheets/src/**`. Mirror the
   plugin set from `apps/sheets/vite.renderer.config.ts` — it is only
   `@vitejs/plugin-react`.
3. **`web/src/index.html`** with a web-appropriate CSP (upstream's is
   Electron-shaped: `connect-src 'self' ws://localhost:*`). Ours must allow the
   API origin.
4. **Implement `DesktopApi` over HTTP.** Type the export as the upstream
   interface so every unimplemented method is a compile error. Work through the
   ~59 methods in dependency order: open, read range, close first; save, visuals,
   AI later. Stub the rest with typed `notImplemented()` so the build stays green.
5. **Model the push channel.** Several methods are `onXxx(listener)` subscriptions
   — theme changes, AI stream, save progress, range pushes. These become a single
   WebSocket multiplexed by channel name, with the same callback shape so the
   renderer sees no difference.
6. **Bootstrap** sets the global, then dynamically imports upstream `main.tsx`.
   Order matters: the global must exist before that import is evaluated.
7. **`DRIFT.md`** — the watch list. Start it now with `sheets-main.ts` and the
   renderer's `index.html` CSP.

**Gate:** the real Sheets UI loads in Chrome against a mock server, opens a
fixture workbook, and scrolls a large sheet. No upstream file has been modified —
verified by `git diff upstream/main -- . ':!web'` returning empty in CI.

---

## Phase 02 — Hono server kernel

The sidecar keeps its stdio JSON protocol untouched. What is new is everything
around it.

1. **Sidecar pool.** N warm processes, requests dispatched by `sessionId`
   affinity (an open workbook lives in one process). Idle eviction, crash restart
   with session invalidation, end-to-end cancellation — the `cancel` command
   already exists but must now reach the right process.
2. **Routes mirroring the 49 handlers.** Key them off upstream's
   `IPC_CHANNELS` constants so a renamed channel is a compile error. Import the
   implementation — `gateway/*`, `xlsx-sidecar-client.ts` — rather than copying
   handler bodies.
3. **`StorageAdapter` port.** `get`/`put`/`head` with version tokens, injected by
   the host app. Never bake in S3. `gateway/xlsx-gateway.ts` and
   `xlsx-package-io.ts` use `node:fs`; give them a scratch directory and let the
   adapter own durable storage.
4. **Session lifecycle.** Bind each `sessionId` to a user and a document.
   Per-tenant caps on concurrent sessions and resident bytes. Idle timeout with a
   save-or-discard decision the client is told about.
5. **Validate server-side.** Every inbound payload against the upstream Zod
   schemas, regardless of what the client claims to have validated.
6. **Save pipeline.** Journal from the client, part surgery through the sidecar,
   write through the adapter, bump the version token. Reject on version conflict
   with the current version attached so the client can rebase.

```ts
// what your Hono app writes
import { createSheetsRouter } from '../web/server/router'

app.route('/sheets', createSheetsRouter({
  storage: myS3Adapter,
  auth: (c) => myUserFrom(c),
  secrets: myVaultAdapter,
  sidecar: { poolSize: 8, idleEvictMs: 300_000 },
}))
```

**Gate:** `npm run compat` and the xlsx benchmarks pass against the HTTP service
rather than a spawned binary, for the phase-00 corpus.

---

## Phase 03 — Document lifecycle and browser UX

1. **Opaque handles as `path`.** Server issues `doc://<uuid>`; the contract is
   unchanged. Verify no renderer site parses the path structurally; if one does,
   issue a path-shaped token instead of editing upstream.
2. **Web open and save UI.** Upload, download, recent documents per user. This is
   new UI in `web/`, not a modification of the ribbon — reuse `@genoffice/ui`
   components so it looks native to the app.
3. **Electron-only affordances degrade gracefully.** Native menus are already
   duplicated by the in-app ribbon. `shell.openExternal` becomes a link.
   Clipboard falls back to the async Clipboard API, with an in-product clipboard
   for OOXML fidelity between sheets.
4. **Lazy streaming over the network — the phase's real risk.** `read_range` was
   cheap over stdio and is not cheap over HTTP. Batch viewport requests, prefetch
   the scroll direction, and measure scroll latency on the largest file early.
5. Print and PDF export currently run through a hidden Electron window. Stub
   here, pick up in phase 09.

**Gate:** a user opens, edits, saves and reopens a real client workbook in Chrome
with byte-identical OOXML output and acceptable scroll latency on the largest
file in the corpus.

---

## Phase 04 — AI agent server-side (MVP ships)

Small because the design is already right. `AgentTransport` is an interface with
the Electron IPC transport as one implementation, and the agent's mutating tool
already routes through the same `ChangePlan` path as a human ribbon click.

1. **Write an HTTP/SSE `AgentTransport`** alongside upstream's
   `createIpcTransport`. Drop-in; no changes to the tool set.
2. **Move the agent loop into Hono.** Provider keys move from the user's home
   directory into the injected secret store, scoped per tenant.
3. **Choose where the agent reads.** Either it calls the same range-read routes
   the browser uses, or it drives a headless `in-memory-workbook` server-side.
   The second is faster for whole-sheet reasoning and is available today.
4. **Re-validate every proposed operation server-side.** The agent is now a
   network-reachable path into a customer's financial data — a prompt-injected
   workbook must not be able to produce an operation the schema would reject.
5. Rate-limit and budget per tenant. Agent turns over a large workbook are the
   most expensive request type in the system.

**Gate:** an agent-proposed edit lands through `ChangePlan` with undo intact, and
a hostile workbook cannot make the agent write outside its granted scope.

---

## Phase 05 — Encrypted workbooks (parallel with 03–04)

Self-contained, and the crypto already exists upstream — for Docs, not Sheets.

1. **Import `apps/docs/src/main/docx-encryption.ts`** from `web/server/`. It
   handles Standard (AES-128/SHA-1) and Agile (AES-256/SHA-512) with CFB
   container sniffing, and was written as a deliberately swappable single
   integration point. `officecrypto-tool` covers `.xlsx` too. Import it; do not
   copy it.
2. **Decide where plaintext lives — before writing code.** The sidecar takes a
   file path, so decrypted bytes must currently hit disk. Either extend the
   sidecar protocol to accept bytes (which means a Rust change — send it upstream
   as a PR, it is generally useful), or mount tmpfs and guarantee plaintext never
   reaches persistent storage. For financial documents this is a compliance
   answer, not a preference.
3. **Password handling:** prompt in `web/` UI, hold in memory for the session
   only, never log, never persist, never include in error messages.
   Wrong-password is a distinct reason code that reprompts; unsupported scheme is
   a different message.
4. **Re-encrypt on save** with the same scheme the file arrived in. Verify by
   opening the result in real Excel — a file only this system can read is a
   failure.
5. Out of scope unless the corpus demands it: legacy `.xls` XOR obfuscation.

**Gate:** Excel opens a workbook this system encrypted; a wrong password is
rejected cleanly; no plaintext appears on persistent storage under any code path,
verified by audit not assumption.

---

## Phase 06 — Load profile and the napi-rs decision

1. **Load-test with the phase-00 corpus** at rising concurrency until
   degradation. Attribute the cause: resident memory, process count, or JSON
   serialization across stdio.
2. **Publish the Collabora comparison** at identical concurrency and files.
3. **If process-per-session is the bottleneck, wrap the crate with napi-rs.**
   Removes spawn cost and the JSON hop; lets one Node process hold many
   workbooks. Use async tasks so the event loop never blocks, and keep the
   existing client interface so nothing above it changes. Note this is additive —
   a new crate target under `web/`, not a modification of the upstream crate.
4. **If memory is the bottleneck, napi-rs will not help** — the fix is session
   eviction policy, range-read caching and per-tenant caps. Diagnose first.

**Gate:** a measured concurrency figure with an attributed bottleneck, not an
estimate.

---

## Phase 07 — Presence

1. **Yjs awareness over WebSocket** — who is in the workbook, their selection
   range, cursor, name and color. This is the role Yjs plays here: awareness, not
   the grid.
2. **Soft locking:** show who is editing a range before two people collide.
   Advisory, not enforced.
3. **Version-conflict UX:** when a save is rejected on the version token, tell
   the user who saved first and offer reload-or-branch. Needed the moment two
   people can open the same document, which is now.

**Gate:** two browsers see each other's selections live. State clearly that this
is presence, not co-editing.

---

## Phase 08 — Shared editing over the op log

Server-authoritative ordering over the existing operation DSL. Budget generously
and sequence the sub-steps strictly. Follow `docs/slides-op-journal.md` —
upstream already built the per-session `opLog` with monotonic `seq` that this
phase needs.

### 08a — Ordering spine

1. Server assigns a monotonic sequence number per operation and holds the
   authoritative `in-memory-workbook` per document.
2. Clients send ops optimistically, apply locally, and hold them pending until
   acknowledged with a sequence number.
3. Persist the log. Replay from the last saved file plus the op log is both crash
   recovery and audit trail.

### 08b — Rebase and undo

1. Rebase pending local ops against incoming remote ones. Start with the cases
   where rebase is identity (disjoint ranges) and reject-and-retry everything
   else before attempting clever transforms.
2. **Reconcile with Univer's undo stack.** A remote edit must never be undone by
   a local Cmd+Z. This is subtle and is where the phase overruns if it overruns.

### 08c — Widen the op surface

1. **Cell values and formatting first.** Ship this and stop; it covers most real
   co-editing.
2. **Structural ops second** — insert and delete rows and columns. These break
   address shifting, formula references and the edit journal simultaneously,
   which is why they are not in the first slice.
3. **Pivots, charts and drawings stay last-writer-wins.** State this explicitly
   rather than letting it be discovered in a demo.

**Gate:** a scripted two-client conflict suite — concurrent row-insert plus
cell-edit, and concurrent edits to the same cell — converges identically on both
clients and the server, repeatably, under induced network delay.

---

## Phase 09 — Parity backlog

Ongoing, driven by phase 00's findings.

1. Fill formula gaps by frequency in real client files, not by spec completeness.
   **Send these upstream as PRs** — they benefit the desktop app equally and cost
   nothing to maintain once merged.
2. Print and PDF export: replace `printToPDF` in a hidden Electron window with a
   headless-Chromium service using the same print HTML.
3. Live pivot refresh, if users demand it over the current rebuild model.
4. Font substitution metrics — the server cannot read the user's installed fonts,
   so documents referencing Calibri or PingFang need deliberate substitution or
   they reflow.

---

## Drift management

### The rebase runbook

```sh
git fetch upstream
git rebase upstream/main        # must never conflict
cd web && npm run typecheck     # this is where drift surfaces
node web/tools/check-drift.mjs  # watched-file diff report
```

Step 3 is the whole discipline. A clean rebase plus a failing typecheck means
upstream changed the contract and you know precisely where.

### `web/tools/check-drift.mjs`

Two jobs, both in CI:

1. **Enforce the invariant.** Fail if `git diff upstream/main --name-only`
   reports anything outside `web/`.
2. **Report watch-list movement.** For each file in `DRIFT.md`, print the diff
   since the last recorded upstream SHA. These never conflict — they are files we
   mirror rather than modify — so a human must read them.

Initial watch list: `apps/sheets/src/main/sheets-main.ts` (handler behavior we
reimplement), `apps/sheets/src/renderer/index.html` (CSP), and
`apps/sheets/vite.renderer.config.ts` (build settings we mirror).

### Escalation policy: drift is not binary

The invariant above is the *default*, not a religion. Rebase cost scales with the
surface area you touch. Three surgical hook points is trivial friction; a
100k-line file move is permanent pain for an identical runtime. So the question
is never "zero drift or conflict forever" — it is "how much drift, deliberately,
and recorded where."

Escalate only one tier at a time, and only when the tier below genuinely cannot
work.

**Tier 0 — additive under `web/`.** The default. Covers phases 00 through 07
entirely. No upstream file touched; rebase cannot conflict.

**Tier 1 — upstream PR.** For changes that are generally useful to the desktop
app too. Merged upstream they cost nothing to maintain. Three candidates are
already visible:

- a sidecar protocol that accepts bytes instead of a `PathBuf` (phase 05)
- missing formula functions (phase 09)
- a collaboration hook point in the renderer (phase 08, below)

**Tier 2 — tracked patch under `web/patches/`.** For things upstream declines or
that are too fork-specific to propose. Applied on checkout, one file per concern,
each documented in `DRIFT.md` with the reason and the upstream SHA it was written
against. A patch conflicts only when upstream edits those specific lines, and the
conflict is small and localized. **Budget: keep the total under five.** Past that,
reconsider whether the design is fighting the codebase.

**Tier 3 — moving or restructuring upstream files.** Do not. This is the one that
makes rebasing permanently painful while delivering no runtime benefit whatever.
If the code organization genuinely needs to change, that is a Tier 1 PR.

### The known Tier 1 case: phase 08

Shared editing needs to intercept local mutations and apply remote ones.
`op-executor.ts` exports `applyChangePlan` and takes an explicit
`OpExecutorContext`, which is close to what is needed — but that context is
constructed inside `App.tsx` and is not exported. There is no current way to
drive it from outside the renderer.

This is the one place where the additive approach is expected to run out. The
right answer is a small upstream PR exposing a mutation hook, which upstream
plausibly wants anyway: `docs/slides-op-journal.md` shows they are already
building op-log collaboration groundwork for Slides. Propose it early in phase
07 so it has time to land before phase 08 needs it, and keep a Tier 2 patch as
the fallback if it does not.

## Standing risks

- **Lazy streaming over HTTP.** Range reads were cheap over stdio. Over a network
  they are the difference between a spreadsheet and a slideshow. Measure scroll
  latency on the largest file in phase 03, not phase 08.
- **Upstream could refactor the bridge.** The whole architecture rests on
  `window.desktopApi` staying the seam. If upstream restructures it, the
  typecheck breaks loudly and the fix is mechanical — but budget for it. The risk
  is low: this shape has survived the app's whole history and the standalone-dev
  mode depends on it too.
- **Contract coupling to a moving target.** The upstream contract is ~59 methods
  and grows. Every addition is a compile error you must implement or stub. That
  is the cost of the approach, and it is much lower than merge conflicts.
- **Ask DreamNum about a Univer Pro licence before phase 08.** If collaboration
  licenses below the cost of a quarter of engineering, phase 08 changes entirely.
  One email, sent before committing the quarter.

## Open decisions

These block work and are not engineering calls:

1. **Does plaintext of an encrypted workbook ever touch disk?** Blocks phase 05's
   design, and determines whether a sidecar-protocol PR to upstream is needed.
2. **Server-authoritative op log, or true CRDT?** Recommendation above is the op
   log. The CRDT case only holds if offline editing is a hard requirement.
3. **Is a Univer Pro licence on the table?** Changes phase 08 entirely.
4. **What is the real p95 workbook size?** Decides whether lazy streaming can be
   dropped for collaborative sessions, which would simplify phase 08
   substantially.
