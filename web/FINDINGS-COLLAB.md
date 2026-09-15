# Collaboration spike

What two people on one document cost today, what has to change before they can
both edit it, and one risk found by reading the engine rather than running it.

Nothing here is built. This is the investigation that decides what to build.

```sh
npm run bench:linux -- --viewers 4 --file <name>       # the measurement below
SERVER_ARGS=--direct-read BENCH=tools/spike-collab.mjs npm run bench:linux
```

## 1. The ceiling is in viewers, not in documents

`FINDINGS-PAPAN.md` §1 measures N *different* workbooks. Collaboration asks the
other question, and the answer is not the same claim:

```
  4 concurrent sessions on ONE document: large-450000.xlsx (30.9 MB, 5.4M cells)
  baseline engine 4.6 MB

    #  engine RSS   cumulative Δ   per viewer
    1      42.9MB         38.4MB        38.4MB
    2      63.1MB         58.6MB        29.3MB
    3      78.2MB         73.6MB        24.5MB
    4      94.3MB         89.8MB        22.4MB

  4 distinct session(s) for one document, 22.4 MB per viewer
```

**22.4 MB per viewer, against 22.2 MB per document.** A second reader of a
workbook costs exactly what a second workbook costs, because `SessionRegistry`
keys by session id: every open takes its own snapshot, opens its own engine
session, and parses the file again.

So "a few hundred heavy documents on a 7.6 GB box" is true only if each is open
once. Five people in one budget is five parses of that budget. For a
collaborative editor that is the wrong unit, and it is the first thing to fix —
before any of the syncing, because it also decides *where* the syncing happens.

## 2. First pillar: one engine session per document, many clients

The change is contained and it is entirely ours — `web/server/`, no upstream
drift:

- index the registry by `(tenantId, documentId)` as well as by session id,
- hand a second opener the session that already exists, refcounted,
- close on the last client rather than the first,
- keep `identify()` as the authority on rights. It already runs on **every**
  request and every mutation is checked against its result, so a shared session
  does not share permission. What must go is `require()`'s assumption that a
  session belongs to one `userId`.

**It is safe because the engine session is read-only.** Every call into it —
`readRange`, `readFormulaCells`, `readMedia`, `readPivotDefinition`, `recalc`,
and the save's `writeWorkbookTo` — reads `session.snapshotPath` and writes, if
anywhere, into a per-request scratch directory. Nothing mutates the open
workbook. That is what makes one session serviceable by many clients without a
lock, and it is worth re-checking whenever a channel is added.

The payoff is not only memory: a shared session is the thing an op log needs to
be sequenced *against*.

## 3. Second pillar: sequence the journal, do not add a CRDT

Edits live in the browser. `edit-journal.ts` is already an operation log —
cell values, styles, structural ops, sheet ops, charts, tables, pivots — and it
is already **the** overlay: streaming evicts and re-installs viewport cells, and
the journal re-applies itself over each re-install. It also already rebases
pending cells across structural ops, which is the part a naive design gets
wrong.

So the shape is a server-sequenced op log, not a CRDT:

| | |
| --- | --- |
| Order | The shared session's instance assigns it. One writer of record, no merge function to argue about |
| Transport | `server/push.ts` already broadcasts per document over the socket |
| Apply | The journal's existing re-application path, driven by a remote entry instead of a local one |
| Save | Unchanged — the journal is the save payload, whoever wrote each entry |

A CRDT buys convergence without a sequencer. We have a sequencer: the document
is already pinned to one instance (`SessionDirectory`, `421 session_elsewhere`).
Adding Yjs would mean two sources of truth for the same edit and a second
rebase implementation beside the one that already exists.

### What is genuinely hard

- **The journal has around sixty `record*` entry points.** Relaying cell values
  is a demo; relaying a pivot refresh, a sheet duplicate and a page-setup change
  is the actual surface. It wants an explicit, enumerated op type — a compile
  error when upstream adds the sixty-first — the way `coverage.ts` handles
  `DesktopApi`.
- **Undo.** Univer's undo stack is local and would happily undo someone else's
  edit. Per-author undo is a design decision, not a detail.
- **Drafts stop meaning one thing.** A 30-second recovery copy per client, of a
  document several clients are editing, is several divergent recoveries.
- **`onConflict` changes meaning.** Version conflict is currently "someone else
  saved". With shared sessions the common case moves inside the session, and the
  banner should fire less, not more.
- **Presence is not free but it is separable.** Cursors and selections can ship
  on the same socket long before edits do, and would be useful on their own.

## 4. A risk found by reading the engine: the recalc cache is keyed by path

`recalc.rs` keeps a resident IronCalc model per **workbook path**, together with
the edits already applied to it, and reuses it only when every applied edit is
also present in the incoming request:

```rust
let resident = cache.entries.remove(&key).filter(|entry| {
    entry.mtime == mtime && entry.size == size
        && entry.applied.keys().all(|key| edits.iter().any(…))
});
```

Two people editing *different* cells never satisfy that. Each request drops the
other's model and reloads the workbook through IronCalc's importer.

Today this is latent, because two sessions get two snapshot paths. It stops
being latent the moment `localPath()` is used — which is exactly Papan's
configuration, since its blobs are content-addressed and immutable. Sharing the
engine session (§2) does not fix it either: the cache key is the path, not the
session.

Correctness is safe — the filter exists precisely so one user's edits cannot be
read by another. What is at risk is cost: a full reload of a heavy workbook on
every alternating keystroke.

### Why this is a reading and not a measurement

`tools/spike-collab.mjs` exists to measure it and cannot, because **IronCalc
refuses to import every workbook in the corpus**:

```
acme-budget.xlsx          XML Error: Missing "xfId" XML attribute
gamma-sales.xlsx          XML Error: Missing "xfId" XML attribute
gamma-heavy-recalc.xlsx   Zip Error: specified file not found in archive
large-450000.xlsx         The formula engine could not process this workbook
```

The last is `tools/make-fixture.mjs`'s own output, so the generator cannot stand
in either. Upstream already expects this: `univer-sync.ts` gives recalc a
budget of `RECALC_MAX_FAILURES = 3` and then stops asking, falling back to the
workbook's cached values. So on this corpus **live recalculation is off**, and
has been throughout — the streaming reader's cached values are what has been on
screen.

That is worth knowing on its own. It also means the thrash cannot be confirmed
until there is a fixture IronCalc will read, which is the first task if this
matters: an Excel-produced workbook rather than a synthesised one.

## 5. Still unmeasured

- **Per-connection cost on the Node side.** Server RSS ran 190–290 MB across
  the memory benchmarks, which is V8 plus bookkeeping and was never attributed.
  A room per document with sockets, presence and an op buffer is a new cost and
  belongs on the same axis as §1.
- **Whether a shared session actually collapses the per-viewer cost**, rather
  than moving it. §1 says what the duplicate costs; it does not prove the
  dedupe recovers it. The same `--viewers` run, after the change, is the check.

## Suggested order

1. Shared engine session per document, and re-run `--viewers 4`. Server-side,
   no upstream drift, and it is the prerequisite for everything else.
2. Presence on the existing socket — selections and cursors. Small, useful
   alone, and it proves the room without touching the journal.
3. An Excel-produced heavy fixture, then settle §4.
4. The op log, enumerated against the journal the way `coverage.ts` is
   enumerated against `DesktopApi`.
