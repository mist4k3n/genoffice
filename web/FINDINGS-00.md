# Phase 00 findings

Run against `genoffice @ d2b898f`, macOS, Chrome, Node 22, Vite 7.3.

## 1. Architecture spike: PASSED

**The upstream Sheets renderer runs unmodified in a browser.**

`web/` serves `apps/sheets/src/renderer` through its own Vite config, installs a
stub `window.desktopApi` before importing upstream's `main.tsx`, and the full
application shell renders: ribbon with all seven tabs, formatting toolbar,
formula bar, grid with headers and frozen panes, sheet tabs, AI panel, status
bar, dark theme applied.

Renderer module graph evaluated in **3.5s cold** (unbundled dev server, ~110
renderer modules plus Univer). No upstream file was modified.

Reproduce:

```sh
cd web && npm install && npm run spike   # http://localhost:5273
```

This validates the central claim in `PLAN.md`: the web delivery is not a port.
It is the same renderer with a different host bridge.

### What this does not prove

The stub answers four methods and rejects everything else, so nothing that
requires a workbook was exercised — no file open, no range streaming, no save,
no formula evaluation. Scroll latency over HTTP, the risk called out for phase
03, is untested and untestable until the server exists.

## 2. The boot surface: 17 of 59 methods

The probe (`web/src/stub-desktop-api.ts`) records every `DesktopApi` access. The
renderer touches 17 distinct methods before the shell is interactive. The
remaining 42 are reached only on user action.

Regenerate with `npm run api:list`.

**Implement first (phase 01), in observed call order:**

| # | Method | Kind | Notes |
| --- | --- | --- | --- |
| 1 | `getLanguage` | invoke | blocks first paint |
| 2 | `getTheme` | invoke | blocks first paint |
| 3 | `onThemeChanged` | subscribe | |
| 4 | `getAiPanelPrefs` | invoke | |
| 5 | `onAiPanelPrefsChanged` | subscribe | |
| 6 | `notifyPendingEdits` | invoke | dirty-state push to the shell |
| 7 | `getAutoSaveDefault` | invoke | |
| 8 | `onAutoSaveDefaultChanged` | subscribe | |
| 9 | `onRecoveryPrompt` | subscribe | |
| 10 | `aiGskStatus` | invoke | auth probe |
| 11 | `onWorkbookRenamed` | subscribe | |
| 12 | `getAiSettings` | invoke | |
| 13 | `consumeNewBlankWorkbook` | invoke | shell handoff |
| 14 | `hasQueuedWorkbook` | invoke | shell handoff |
| 15 | `onMenuAction` | subscribe | native menu relay |
| 16 | `onCloseSaveRequest` | subscribe | |
| 17 | `onLanguageChanged` | subscribe | |

Eight of the seventeen are subscriptions. They are called synchronously and must
return an unsubscribe function — a promise-returning stub breaks the renderer
immediately. The single WebSocket multiplexed by channel name, described in
`PLAN.md` phase 01, covers all eight.

Four of them (`onMenuAction`, `onCloseSaveRequest`, `onWorkbookRenamed`,
`onRecoveryPrompt`) exist to relay events from the Electron *shell* — the tab
host, not Sheets itself. On the web these have no source and can return a no-op
unsubscribe permanently, or be repointed at web equivalents (browser menu,
`beforeunload`, rename UI). **Decide this in phase 01 rather than stubbing and
forgetting.**

## 3. Upstream bug found: bundled Carlito never loads

**This is a real defect in upstream, not an artifact of the spike, and it
affects the desktop app.**

`apps/sheets/src/renderer/cell-font-fallback.ts:169` builds the font URL as:

```ts
`url(${new URL('./fonts/Carlito-Regular.ttf', import.meta.url).href})`
```

`apps/sheets/src/renderer/fonts/` **does not exist**. The fonts live in
`packages/ui/src/fonts/`, which is where `styles.css` correctly reaches them via
the package export (`url('@genoffice/ui/fonts/Carlito-Regular.ttf')`, resolved by
both dev servers to the right path — verified).

Under upstream's own dev server the broken request is masked: Vite's SPA
fallback answers `/fonts/Carlito-Regular.ttf` with **HTTP 200 and
`Content-Type: text/html`**, so the browser gets `index.html` and fails silently
at font decode. The spike surfaces it as a visible 404 plus
`OTS parsing error: invalid sfntVersion` only because its Vite root differs.

### Why it matters

The file's own comment states the intent precisely:

> Carlito is bundled, not installed — `local()` alone can never resolve it.

So on any machine without Calibri or Aptos installed, the alias FontFaces have
no source at all. Cell text metrics — column auto-width, wrap points, `####`
overflow — measure against a different face than intended. On a developer Mac
`local('Helvetica Neue')` covers it and nobody notices; on a Linux CI box or a
headless render server it does not.

### Proposed fix (Tier 1 — upstream PR)

Use the same package export the stylesheet already uses, as a Vite URL import,
so the asset is resolved and emitted in production builds too:

```ts
import carlitoRegular from '@genoffice/ui/fonts/Carlito-Regular.ttf?url'
import carlitoBold from '@genoffice/ui/fonts/Carlito-Bold.ttf?url'
```

Small, benefits the desktop app equally, and is exactly the shape of change
`PLAN.md` classifies as Tier 1. **Do not patch this locally.**

## 4. Config notes worth keeping

Three settings in `web/vite.config.ts` that are not obvious and were needed:

- `server.fs.allow: [repoRoot]` — the module graph deliberately leaves the Vite
  root to reach `apps/` and `packages/`.
- `resolve.dedupe: ['react', 'react-dom']` — workspace packages are symlinks;
  without this the renderer and `@genoffice/ui` can resolve separate React copies
  and hooks fail at runtime.
- `optimizeDeps.exclude` for `@genoffice/*` — those packages export raw `.ts`
  through their exports map, and esbuild pre-bundling breaks the CSS subpaths.

No upstream configuration was read or copied — only mirrored deliberately.
`apps/sheets/vite.renderer.config.ts` is on the `DRIFT.md` watch list for this
reason.

## 5. Corpus audit — `test-files/`, 10 workbooks

Tools: `npm run audit`, `npm run fidelity`, `npm run spike:encryption`.

### 5a. The corpus is synthetic. The stop criterion is still unevaluated.

Across all ten files there are **6 distinct functions**: `AVERAGE`, `AND`, `IF`,
`MOD`, `SUM`, `IFERROR`. All six have registered executors. No charts, no
pivots, no drawings, no conditional formatting, no data validation, no defined
names anywhere in the set.

Real financial models use dozens to hundreds of functions and are full of those
features. **This corpus cannot answer the question phase 00 exists to answer.**
Treat the formula verdict below as "nothing disproved", not "cleared".

One parsing trap worth recording: the generated files emit namespace-prefixed
XML (`<x:sheet>`, `<x:f>`), and the first version of the audit silently reported
zero sheets and zero formulas for six of ten files. Any tool reading OOXML here
must be prefix-tolerant.

### 5b. Univer's formula engine is far better stocked than assumed

`@univerjs/engine-formula` exports `ALL_IMPLEMENTED_FUNCTIONS`: **511 registered
executors**, plus 4 the app registers itself (`CELL`, `RATE`, `MINIFS`,
`MAXIFS`).

Every modern function flagged as unverified in `PLAN.md` is present: `XLOOKUP`,
`LAMBDA`, `LET`, `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, `TEXTJOIN`, `IFS`,
`SUMIFS`, `XMATCH`, `TEXTSPLIT`.

This materially de-risks the largest unknown in the plan. **It is not proof of
correctness** — registration says an executor exists, not that spill semantics
or edge cases match Excel. The value diff is still required.

### 5c. The "protected" file is not encrypted

`unlocksheet-sample-protected-excel-file.xlsx` is a plain `PK` zip carrying:

```xml
<sheetProtection ... sheet="1" ... password="E321"/>
```

That is a legacy 16-bit **worksheet protection** hash. The file opens with no
password; the hash only gates editing locked cells. All ten files in the corpus
are plain zips — none is a CFB container.

This is exactly the distinction in the requirement table, and the good news is
that **this case already works today**: `worksheet.rs:451` reads the `password`
attribute into `has_password`, and the app fails closed on rewrites that cannot
preserve the hash.

**Still needed for phase 05: a real password-to-open file.** In Excel that is
File → Info → Protect Workbook → Encrypt with Password, not sheet protection.

### 5d. Encryption round-trip: PASSED (synthesised file)

Since the corpus had none, `npm run spike:encryption` synthesises an encrypted
workbook with the same library upstream uses for Docs, then verifies the
round-trip. All 12 checks pass:

- encrypt produces a CFB container carrying an `EncryptedPackage` stream
- decrypt returns a plain zip, **byte-identical to the original**
- same part names, same part sizes
- wrong password rejected, and the message matches the `/password is incorrect/`
  probe `docx-encryption.ts` keys off — so upstream's wrong-password vs
  unsupported-scheme distinction carries over to xlsx unchanged

**Unverified:** that real Excel reopens the encrypted output. The spike leaves
the file in a temp directory; open it in Excel before trusting phase 05.

### 5e. IronCalc import is stricter than the OOXML spec

The sidecar builds and runs. `open`, `read_range`, `read_formula_cells` and
`close` all work on every file. `recalc_cells` fails on **4 of the 5**
formula-bearing workbooks:

| File | Error | Cause |
| --- | --- | --- |
| `acme-budget.xlsx` | `Missing "xfId" XML attribute` | `<x:xf>` in `cellXfs` has no `xfId` |
| `acme-inventory.xlsx` | same | same |
| `gamma-sales.xlsx` | same | same |
| `gamma-heavy-recalc.xlsx` | `Zip Error: specified file not found` | no `xl/styles.xml` at all |
| `unlocksheet-…xlsx` | — | **works: 6/6 formula values match cached `<v>`** |

`xfId` on `cellXfs/xf` is **optional** per ECMA-376, and `xl/styles.xml` is an
optional part. Excel always writes both, so Excel-authored files are fine — but
files from generators are not, and a client receiving workbooks from other
systems will hit this.

Impact is bounded: this is the *second* engine. Univer's engine in the browser
is independent and unaffected. What breaks is the `recalcWorkbook` path.

### 5f. IronCalc writes diagnostics to stdout, corrupting the protocol

**The most serious finding of the run.** Recalculating `gamma-heavy-recalc.xlsx`
produced:

```
STDOUT lines: 32001 | of which NOT JSON: 32000
STDERR lines: 0
sample: "Unexpected type (empty) in HeavyRecalc!D2"
```

IronCalc `println!`s one line per empty cell straight into the sidecar's
newline-delimited JSON channel.

Upstream survives it only because `xlsx-sidecar-client.ts:280` wraps
`JSON.parse(line)` in a `try/catch` and drops unparseable lines. So it is latent
today — but:

- 32,000 spurious lines per recalc is pure overhead on the hot path
- in the **pooled, multi-tenant sidecar of phase 02** this garbage interleaves
  with real responses across concurrent requests
- any diagnostic line that happened to begin with `{` would be parsed as a
  response

**Tier 1 upstream PR.** The robust fix is for the sidecar to claim a private fd
for protocol writes at startup and point fd 1 at stderr, so any library
`println!` can never reach the protocol channel. Suppressing IronCalc's output
around the call is the smaller alternative.

### 5g. A real encrypted workbook — `TestLocked.xlsx`

The corpus now contains a genuine password-to-open file. `npm run decrypt`
reports:

```
container: CFB (OLE2)
encrypted: true
scheme:    Agile (AES-128/SHA1, spinCount 100000)
```

Two things this already establishes without the password:

- `officecrypto-tool` parses the `EncryptionInfo` descriptor without complaint,
  so the scheme is supported — it fails with "password is incorrect", not
  "unsupported".
- 18 wrong passwords were each rejected with exactly the message
  `docx-encryption.ts` keys off (`/password is incorrect/`), so upstream's
  wrong-password vs unsupported-scheme split carries over to xlsx unchanged.

Note the scheme is **AES-128/SHA-1**, while the comment in
`docx-encryption.ts` describes Agile as AES-256/SHA-512. Agile is
parameterised; the comment describes Word's default, not the only case. No code
change needed — just do not narrow the implementation to the documented pair.

**Round-trip verified with the real password.** `npm run decrypt` passes every
check:

- decrypts to a valid OOXML zip (10 parts, `xl/workbook.xml` present)
- re-encrypts to a CFB container, and re-decrypting returns the identical payload
- **the sidecar opens the decrypted payload** (1 sheet, `Sheet 1`) — the whole
  phase-05 flow, sniff to engine, proven end to end

One check remains that no tool here can do: opening the re-encrypted file in
real Excel with the same password. The tool leaves it in a temp directory.

### 5h. The sidecar cannot tell "encrypted" from "corrupt"

Handing the encrypted file to the sidecar gives:

```
workbook_error: invalid Zip archive: Could not find EOCD
```

That is the same error a truncated or damaged file produces. The server
therefore **cannot** use the sidecar's failure to decide whether to prompt for
a password.

**Design consequence for phase 05:** sniff the CFB magic in `web/server/`
before the file ever reaches the sidecar, exactly as `docx-encryption.ts` does
with `isCfbFile` / `isEncryptedDocx`, and decrypt upstream of it. This holds
whichever way the disk-plaintext decision goes, so it is not blocked on that
question.

### 5i. Fidelity diff: 203 formula cells, 0 mismatches

With two Excel-authored workbooks in the corpus the diff finally has something
real to compare. IronCalc's recalculation matches Excel's cached `<v>` exactly:

| File | Formulas | Compared | No cache | Mismatch |
| --- | --- | --- | --- | --- |
| `Book 1.xlsx` | 123 | 123 | 0 | **0** |
| `Book.xlsx` | 80 | 80 | 0 | **0** |
| `unlocksheet-…xlsx` | 6 | 0 | 6 | 0 |

`Book 1.xlsx` is not a toy: 14 sheets, 13 tables, structured references
(`SUM(ExpenseSummary[[#This Row],[Jan]:[Dec]])`), `SUMIFS` over table columns,
`SUBTOTAL(109, …)`, and `DATE(YEAR(TODAY()),…)`. All exact.

The six "no cache" cells are formula cells the writer shipped without a cached
result, so there is nothing to compare — not a failure. IronCalc computed them
consistently (`25 + 48 + 43.75 + 40 + 55.5 = 212.25`, matching its own `SUM`).

**Two harness bugs had to be fixed to get here, and both would mislead anyone
re-running this:**

1. `RecalcCell` returns the value as `formatted` — a *display* string. Comparing
   it against the raw cached `<v>` reports every currency, percent and date cell
   as a false mismatch (`1263` vs `"1,263.00"`, `46026` vs `"1/4/26"`). The raw
   value is in the optional `number` field, omitted for text results.
2. An initial version read a non-existent `value` field and scored 100% mismatch
   across the board.

Until it was corrected the tool reported 88/123 and 80/80 "failures" that were
entirely artefacts. Treat a high mismatch rate as a harness bug first.

### 5j. Chart and table extraction works

`npm run visuals` asks the sidecar what it made of the drawing parts, rather
than just noting that the parts exist:

| File | Sheets | Visuals | Tables |
| --- | --- | --- | --- |
| `Book 1.xlsx` | 14 | 1 chart | 13 |
| `Book.xlsx` | 2 | 1 chart | 0 |

Extraction is detailed, not a stub — a chart comes back with `chartTypes`,
`grouping`, `barDirection`, `legend` position, `gapWidthPct`, `gridlines`,
`dataLabels`, `dispBlanksAs`, `categoryAxisFormat`, and full `series` with
category labels, plus a drawing anchor in EMU.

**Images and shapes verified with `Book 2.xlsx`** (964 KB, 29 media parts):

| Kind | Count | Bytes served |
| --- | --- | --- |
| image | 24 visuals over 14 distinct media paths | 798 KB, all valid PNG |
| shape | 5 | — |

`read_media` returned correct bytes for **all 24 images, 0 failures**, verified
by magic-number check rather than by length alone. Shapes come back with
`fillColor`, `lineColor`, `name`, anchor and text `paragraphs`.

**Caveat worth knowing: SVG graphics degrade to their PNG fallback.** The
drawing declares 14 `.svg` relationships and uses the `svgBlip` extension, but
every extracted visual points at the PNG:

```
image visuals: 24 | distinct mediaPaths: 14
any .svg referenced: false
mediaTypes: image/png
```

Office stores modern icons as an SVG plus a raster PNG fallback; the sidecar
resolves only `r:embed` (the PNG) and never the `svgBlip` vector. Nothing is
lost or broken — that PNG exists precisely for consumers that cannot do SVG —
but such graphics will be raster at high zoom and in print/export. If the client
cares about crisp icons, that is a Tier 1 upstream enhancement, not a bug.

**Pivot tables remain completely unverified.** No fixture contains one, and it
is the requirement carrying the largest caveat in `PLAN.md` (rebuild-on-refresh
rather than a live pivot cache). A workbook with a real pivot is the single most
valuable file still missing.

### 5k. Baseline timings

`open` is 0–2ms for every file in the corpus, including the 383 KB / 32,000-
formula one — the lazy design means open does not parse cell data. No meaningful
recalc baseline was obtained, because the heavy file fails IronCalc import.

## 6. Housekeeping: `test-files/` breaks the invariant

`npm run check:drift` flags all ten files — they sit outside `web/`. They are
fixtures, not code, so the fix is one line in `.gitignore` (or move them under
`web/fixtures/`). Left as-is, every rebase carries them.

## 7. Not yet done — blocked on a representative corpus

These parts of phase 00 need the real workbooks and cannot be run here:

- **Formula coverage audit.** The tooling target is clear: enumerate the live
  Univer registry via `function-registry-probe.ts`, extract every function used
  across the corpus, rank the misses by occurrence. Still unknown, and still the
  stop criterion: dynamic arrays, spill, `LET`, `LAMBDA`, `XLOOKUP`,
  `FILTER`/`SORT`/`UNIQUE`.
- **Fidelity diff.** Recalculated values against each file's cached `<v>`;
  open/save/reopen OOXML part comparison.
- **Encryption spike.** Whether `officecrypto-tool` round-trips the real
  protected `.xlsx` files such that Excel reopens them.
- **Baseline.** Open time, peak memory and save time per file, under Collabora
  and under the Electron app.

**To unblock:** drop 20–50 representative workbooks somewhere outside the repo
and point the audit at them. The encrypted ones matter most, because they gate
phase 05's disk-plaintext decision.

## Verdict

The architecture is validated, phase 01 is a concrete list of 17 methods, the
encryption round-trip works, and Univer's formula engine is much better stocked
than the plan assumed.

**The stop criterion remains unevaluated.** The corpus is synthetic: 6 distinct
functions, no charts, no pivots, no conditional formatting, and no genuinely
encrypted file. Nothing was disproved; nothing was cleared either.

Two upstream PRs are now warranted regardless of what the real corpus shows:
the Carlito font path (§3) and the sidecar stdout channel (§5f).

Phase 01 can begin — the boot surface is known and independent of the formula
question. Do not commit a delivery date until the audit runs against real client
workbooks.
