# Phase 03 — Document lifecycle and browser UX

Status: **gate met.** A user opens a real workbook in Chrome, edits a cell,
saves, and reopens it with the edit intact and every untouched package part
byte-identical. Scroll latency on the largest corpus workbook is one request
per step, median 16ms. Of the fifty-nine channels, twenty are served over
HTTP, four are pushes, three are answered by the browser itself, five are
permanent shell no-ops, and twenty-seven remain.

```sh
cd web
cp -r fixtures /tmp/corpus
npm run serve -- --dir /tmp/corpus     # terminal 1
npm run dev                            # terminal 2
npm run compat                         # the phase-02 gate, still green
npm run bench                          # scroll-latency measurements
npm test                               # prefetch correctness
```

## The gate, driven through the browser

Not asserted from the server side — driven through the renderer's own UI:

1. Open `gamma-heavy-recalc.xlsx` (8,001 rows). The renderer reports
   *"Streaming gamma-heavy-recalc.xlsx: 8,001 rows available."*
2. Edit `A1` through Univer's own API; the edit lands in the journal.
3. Click the toolbar's **Save (⌘S)** button.
4. The edit is present in `xl/worksheets/sheet1.xml` on the server.
5. Reopen in a fresh tab — `A1` reads back the edited value.

`compat` still passes: 14 workbooks, 0 failing, every archive entry preserved.

## Measuring changed the plan

PLAN.md called `read_range` over HTTP this phase's real risk and proposed
batching viewport requests and prefetching the scroll direction. The first half
turned out to be unnecessary.

| viewport | stdio | http | overhead | requests |
| --- | --- | --- | --- | --- |
| 40×18 | 0.7ms | 3.0ms | +2.3ms | 1 |
| 120×30 | 0.9ms | 3.9ms | +3.1ms | 1 |
| zoomed out 600×40 | 2.7ms | 8.3ms | +5.6ms | 1 |

Every realistic viewport is **one request**: the renderer's
`SIDECAR_READ_BATCH_CELLS` is 90,000, and a zoomed-out 600×40 view is 24,000
cells. Batching viewport requests would buy nothing.

A real scroll in Chrome on the 8,001-row workbook: **11 requests for 12 scroll
steps, median 16.2ms, max 35ms**, each 187×7.

So the cost is not overhead, it is distance. The renderer awaits those reads
one at a time inside `readSheetRangeMapped`, and that loop cannot be
parallelised without editing upstream — eleven requests on a 60ms link are
eleven 60ms stalls. Reading ahead is the one lever left, and it is the half of
the plan's proposal worth building.

## Decisions

**`path` is a path-shaped token, not `doc://<uuid>`.** PLAN.md asked to check
whether any renderer site parses it structurally before choosing. One does:
`cell-function.ts` cuts at the last separator to build Excel's
`dir/[Book.xlsx]Sheet1`. Omitting it is not an option either — `CELL("filename")`
then returns `""`, which reads as "never saved", and the ubiquitous
`=MID(CELL("filename"),FIND("]",...)+1,31)` idiom stops working. Verified in
Chrome: `/Documents/[acme-budget.xlsx]Budget`, and the idiom returns `Budget`.

**A new `local` coverage status.** Some preload methods are not requests to a
backend at all. `openExternal` is a new tab; `exportCsv` is a download of text
the renderer already serialized; `getPathForFile` is the empty string because a
browser `File` has no path. Routing these through the server would cost a round
trip to learn something the browser already knows. They stay in the coverage
table so the drift detector still covers them, and `check:server` now fails if
a `local` channel also has a server handler.

**Prefetch is opt-in** (`VITE_SHEETS_PREFETCH=1`). It is a latency optimisation
for real networks and pure overhead against a server on localhost.

**No file-picker UI was built.** PLAN.md item 2 asked for upload, download and
recent-documents UI inside `web/`. That was written before the embedding model
was settled, and it is now the wrong place for it: this app is consumed by the
client's own React frontend, which owns document identity — it already chooses
the document, and it is where a document list belongs. Building a second
picker inside the renderer would duplicate and then conflict with it. What the
browser genuinely needs and cannot get elsewhere — downloading the current
sheet as CSV — is implemented.

## Not done in this phase

- **PDF export.** Upstream renders it through a hidden Electron window; there
  is no browser counterpart. Left as `todo`, which rejects with a named error
  rather than failing obscurely. Phase 09, headless Chromium server-side.
- **Save As**, still 501: it means "create a different document" and needs a
  document-create port.
- The CSV formula-loss warning **loses its third option**. The desktop offers
  "save as .xlsx instead / continue / cancel"; a browser has no three-way
  dialog, so `confirm` carries the warning and the `.xlsx` escape hatch is
  dropped. The user is still told before losing formulas, and Save As remains
  on the ribbon.
- Clipboard is Univer's own and already browser-native; nothing was needed, and
  nothing was verified beyond that.

## Worth knowing

**`read-formulas` returns nothing until rows are indexed.** Calling it before
any `read-range` legitimately answers zero — that is upstream's lazy indexing,
not a failure. It cost half an hour before the cause was obvious.

**Two corpus workbooks cannot be recalculated.** IronCalc's importer rejects
them (`Missing "xfId"`, `Zip Error`). Checked against a directly-spawned
sidecar: both fail identically there, so this is IronCalc's limitation and not
something serving it over HTTP introduced. Upstream treats recalc as fail-soft
for exactly this reason.

**The quota works, and it caught me.** Six browser tabs left open exhausted
`maxSessionsPerTenant` and the next open answered 429 — which is the intended
behaviour, arriving as a surprise.

## Next

Phase 04 — the AI agent server-side, which is where the MVP ships.
