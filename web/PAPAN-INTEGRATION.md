# Integrating with Papan

What has to be true before GenOffice Sheets can open a document inside Papan,
who owns each piece, and how to tell when it is done.

Context lives in three other files and is not repeated here:
[PAPAN-BRIEFING.md](./PAPAN-BRIEFING.md) is Papan's own description of itself,
[FINDINGS-PAPAN.md](./FINDINGS-PAPAN.md) is what that briefing changed and what
the memory measurements say, and [FINDINGS-COLLAB.md](./FINDINGS-COLLAB.md) is
the collaboration spike.

Items are marked **[us]** (this repository) or **[papan]** (the platform), and
**blocking** if a document cannot open without it.

---

## A. Delivery — [us]

### A1. There is no library build — **blocking**

`web/` builds three HTML pages (`index`, `harness`, `sheets-frame`). Its
`package.json` has no `main`, no `exports`, no `types`. Papan imports
`<SheetsEditor>` as a React component, and there is currently nothing to
import.

Two options, and it is a real choice:

| | |
| --- | --- |
| **Library build** | `vite build --lib` plus `.d.ts` emit, published to a private registry. Papan depends on a version. Upgrades are deliberate |
| **Source dependency** | Papan consumes `web/src/embed` through a workspace or submodule. No publish step, but Papan's bundler then compiles upstream's renderer and inherits its build constraints |

The library build is the better default — the renderer's module graph reaches
into `apps/sheets/src/renderer` and `packages/*/src`, and making Papan's
bundler responsible for that couples the two repositories' build configuration.

**Done when:** Papan can `import { SheetsEditor } from '@…/sheets-web'` and
typecheck against it.

### A2. `base` path — **blocking**

The production build emits absolute asset URLs (`/assets/…`). Verified by
building: the fonts, chunks and CSS all resolve that way. Served anywhere but
the site root, every asset 404s.

**Done when:** `base` matches where Papan serves the bundle, and a built page
loads its CSS and its Carlito faces from that prefix.

> A related dev-only wrinkle, recorded so nobody chases it: in `vite dev` the
> `@genoffice/ui/fonts/*.ttf` URLs inside upstream's CSS resolve relative to
> `styles.css` instead of through the package's exports map, so the dev server
> answers them with `index.html` and Chrome logs `invalid sfntVersion`. The
> production build resolves them correctly. Canvas metrics depend on Carlito
> (it is metric-compatible with Calibri), so this would matter if it were real;
> it is not.

### A3. Serve `sheets-frame.html`

Only needed for `isolate` — two editors visible at once, which is what the
conflict banner's compare view is. It has to be reachable at whatever
`frameSrc` says, and it makes its own API calls, so if it is served from
another origin Papan's session cookie needs `SameSite=None`.

**Done when:** a compare view renders two grids.

### A4. Bundle weight

22 MB of build output, dominated by one 10.6 MB chunk (≈3 MB gzipped). That is
fine behind a lazy route and not fine in an app shell every Papan page loads.
Univer's locale bundles are already split per language; the remaining chunk is
the editor itself.

**Done when:** the editor's chunks are loaded on demand, and Papan's initial
payload is unchanged by this integration.

---

## B. Adapters — [papan]

All of these are arguments to `createSheetsRouter`. The shapes are in
[server/ports.ts](./server/ports.ts).

### B1. `StorageAdapter` — **blocking**

`head` / `get` / `put(documentId, bytes, expectedVersion)`. The version token
is what makes concurrent saves decidable, so it must be a real version of the
bytes — Papan's `contentHash` is exactly right.

**Also implement `localPath()`.** Papan's blobs are SHA-256-addressed and
immutable, which is the precise guarantee a per-session snapshot exists to
provide, so returning a path skips the copy entirely. On hosts where `/tmp` is
a tmpfs that copy is RAM: 30 MB per open document against a 1.2 GB office
budget. **The contract is immutability, not existence** — if anything can
rewrite those bytes in place, return `null`.

**Done when:** a document opens, and `/health` shows no growth in scratch
usage per open.

### B2. `identify()` — **blocking**

Runs on every request; throw to reject (the router answers 401). Returns
`{ userId, tenantId, documentId, permission }`.

`permission` is a lattice, not a boolean, and the three distinctions matter:

| | |
| --- | --- |
| `owner` `admin` `readwrite` | read, copy, write |
| `readcopy` | read and copy — Save As works, saving does not |
| `hidden` | answered `404`: the caller must not learn the document exists |
| `none` | answered `403` |

Every mutation is checked against the *request's* result, never against what
the session recorded at open, so a revoked grant fails on the next call.

**Done when:** a viewer cannot save, a `hidden` document 404s, and revoking a
grant mid-session fails the next write rather than the next open.

### B3. WebSocket attach — **blocking in practice**

Papan's Hono backend attaches any socket that can `send` a string:
`router.attachSocket(documentId, socket)`. The socket is the web's equivalent
of a destroyed renderer — it is how the server learns a tab closed. Without it,
sessions live until the 15-minute idle sweep and a handful of refreshes can
exhaust a tenant's quota with nothing actually open.

**Done when:** closing a tab frees its workbook within the socket grace (45s
by default), visible in `/health`.

### B4. `documentChanged()`

Call it wherever Papan learns a document moved — realtime, webhook, another
writer. It is what makes the conflict banner appear *while there is still a
choice*, rather than at the moment a save fails.

With more than one API instance, also pass `announceChange`: pushes reach only
the sockets the calling instance holds, so the host publishes and then calls
`documentChanged` on each.

### B5. Session affinity — a decision, not a task — **blocking**

An open workbook lives inside one engine process on one instance. Behind nginx
with no sticky routing, half of every session's calls land on the wrong
machine. Three valid answers:

1. **`PAPAN_SINGLE_API=1`.** Nothing to build. Caps throughput at one process.
2. **The #603 document-id shard router.** Already planned; this becomes one
   more consumer of it.
3. **`SessionDirectory` over the existing Redis.** `claim` / `lookup` /
   `release` makes "this session is on another instance" a **421**
   (`session_elsewhere`, naming the owner) rather than a **410**. Add
   `forward` and the package proxies the call itself.

Without one of these, a misrouted call is indistinguishable from an expired
one, and the client reopens a 30 MB workbook that is still open elsewhere.

**Done when:** a call to the wrong instance answers 421 or is forwarded, never
410.

### B6. Ship the engine binary — **blocking**

`xlsx-sidecar` is a Rust binary and must be in the API image for
`linux/amd64`, with `XLSX_SIDECAR_PATH` pointing at it. The two-stage build in
[tools/bench-container/Dockerfile](./tools/bench-container/Dockerfile) is a
working reference: `rust:1-trixie` builds it, the runtime image copies it.

### B7. Allocator environment

```sh
MALLOC_ARENA_MAX=1
MALLOC_TRIM_THRESHOLD_=131072
```

Set on whatever supervises the Node API; the engine inherits it. Without them
glibc drifts under repeated open/close — the same three heavy workbooks cost
79 MB resident on the first cycle and 105 MB on the fourth. With them it holds
flat at ~71 MB and each workbook costs 11% less. `FINDINGS-PAPAN.md` §1.

### B8. Quota numbers

Defaults are 16 workbooks, 512 MB and a 15-minute idle timeout per tenant.
They now count **workbooks, not viewers** — ten people in one budget hold one
workbook — so pick real numbers against ~22 MB per heavy workbook and ~5.6 MB
per ordinary one.

### B9. `DraftAdapter`

Optional, and its absence is a data-loss decision: the editor's 30-second
recovery timer becomes a no-op and an interrupted session loses whatever was
pending. A draft records the storage version it was edited from, so it can be
served ahead of storage on the next open and deleted once stale.

Wire `onDraftRestored` if Papan shows a dirty indicator: a restored draft
leaves the edit journal empty, so `onDirtyChange` reports zero for a document
that is not saved.

---

## C. Unserved channels — [us], scope decision

`src/host/coverage.ts` is the authority; 26 methods are still `todo`. Six are
AI and are switched off by default (Papan has its own assistant — see
`UPSTREAM-CHANGES.md`, Change 8); two are desktop screen capture and will never
apply. The remaining eighteen, by what they cost Papan:

| Group | Methods | Why it matters |
| --- | --- | --- |
| Export | `exportPdf`, `exportCsv` | "Download as PDF/CSV" answers 501 today |
| Create | `createDocument` | "New spreadsheet" |
| Recovery | `writeWorkbookRecovery`, `replyRecoveryPrompt`, `reportCloseSaveResult` | Pairs with B9; without them the prompt has nowhere to go |
| Host dialogs | `autoRenameWorkbook`, `confirmCsvSave` | Small; map to Papan flows the way Save As did |
| Merge | `selectWorkbooksForMerge`, `openWorkbooksForMerge` | A whole feature. Drop it or build it |
| Media | `readLocalImage`, `addPastedImage`, `fetchImage`, `webSearch`, `imageSearch`, `generateImage` | Only if Papan wants image insert |
| Attachments | `pickAttachments`, `addAttachmentPaths`, `readAttachment`, `readAttachmentImage` | Composer attachments; AI-adjacent |

`selectWorkbook` appears in the `todo` list for a different reason — it is
served, but as "the document this connection is authorised for" rather than as
a file dialog.

None of these block a document opening. They block specific buttons, so the
decision is which buttons Papan ships in its first version.

---

## D. Verification gaps — [us] + [papan]

These do not block a first integration. They block calling it production.

### D1. There is no Excel-produced fixture, and recalculation is off

IronCalc refuses to import **every** workbook in the corpus, with three
different errors, including `tools/make-fixture.mjs`'s own output. Upstream
expects this — `RECALC_MAX_FAILURES = 3`, then fall back to the workbook's
cached values — so live formula recalculation has been off throughout and the
streaming reader's cached values are what has been on screen.

**Needed:** a handful of real Papan documents, produced by Excel, as a second
corpus. Everything below depends on having one.

### D2. The recalc cache thrash

`recalc.rs` keys its resident model by workbook **path** and reuses it only
when every already-applied edit is in the incoming request. Two people editing
different cells never satisfy that, so each evicts the other and the workbook
reloads. Latent today (two sessions, two snapshots); **not latent once
`localPath()` is on**, which is B1. Correctness is safe; cost is not.
`FINDINGS-COLLAB.md` §4.

### D3. Per-connection memory

The memory work measures per *document* and now per *viewer*. The Node side is
unattributed — server RSS ran 190–290 MB across the benchmarks. A room per
document with sockets, presence and an op buffer is a new cost on the same
axis.

### D4. Encrypted and legacy workbooks

Encrypted `.xlsx` is detected and refused with `428 password_required`;
`SecretsAdapter` exists as a port and nothing consumes it. Legacy `.xls` is
detected and refused with an explanation. Both are honest failures rather than
corruption errors — but if Papan's corpus contains either, that is a feature,
not a message.

### D5. Soak test

N viewers, sockets connecting and dropping, idle reaping, on a box the size of
the real one. The numbers quoted here come from a container on a laptop.

---

## E. Security and operations — [papan]

- **CSP.** Papan sends `frame-ancestors 'none'`. Same-origin frames are
  unaffected, but the isolate frame and the WebSocket origin both need
  confirming against the live policy.
- **Cookies.** A frame served from another origin needs `SameSite=None`, since
  it makes its own API calls.
- **Metrics.** `/health` already reports sidecar pool, sessions *and*
  workbooks, push and export stats. Wire it to Papan's monitoring rather than
  inventing counters.

---

## Shortest path to a document opening in Papan

1. **A1** library build, **A2** `base`.
2. **B1** storage with `localPath()`, **B2** `identify()`.
3. **B6** the engine binary in the image, **B7** the two environment variables.
4. **B3** socket attach.
5. **B5** pick an affinity answer.

Everything else can follow a working editor. **C** decides which buttons ship;
**D** decides when it is production.
