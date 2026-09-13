# Upstream changes carried by this fork

**Read this before editing anything outside `web/`.**

The fork's original rule was that nothing outside `web/` changes, so
`git rebase upstream/main` never conflicts. That rule now has exactly one
exception, taken deliberately. The rule that replaces it:

> Every file outside `web/` that differs from upstream is listed in
> `web/upstream-changes.json` and justified here. `npm run check:drift` fails on
> anything undeclared.

Nothing is silently modified. Adding a file to that list is a decision someone
has to write down, which is the point.

---

## Change 1 — the host bridge is per editor instance

**Files:** 23 (one new, 22 modified), all under `apps/sheets/src/renderer/`.
**Baseline:** upstream `d2b898f`.

### Why

`App` read `window.desktopApi` directly, at 80 call sites across 21 files. In
Electron that is correct and simple: a window holds exactly one workbook, so a
page-level global and an editor instance are the same thing.

In a browser they are not. Papan opens documents as **tabs inside one page**,
and the shell keeps them mounted. With a global bridge, every editor on the page
addresses whichever document claimed the global last.

This is not a theoretical risk. It was measured: two editors mounted on
different documents, and **both loaded the same one** — a tab labelled
`acme-budget.xlsx` rendering `gamma-sales.xlsx`'s data.

### Why it could not be solved in `web/`

Three approaches were tried before changing upstream:

1. **Route the global to whichever editor is "current."** Fails, and the failure
   is structural: the document load happens long after mount, and later calls (a
   scroll read, a save) leave at times nobody controls. Whoever owns the global
   then answers. A call cannot say which React tree it came from.
2. **Serialise editor start-up so each owns the global while initialising.**
   Helps mounting, does nothing for the calls that matter, which all happen
   afterwards.
3. **An iframe per editor.** This *does* work — verified — because a frame has
   its own realm and therefore its own globals. It was rejected in favour of the
   in-page component: Papan embeds editors as React components, its SPA ships
   `frame-ancestors 'none'`, and each frame would carry another copy of the
   bundle.

Showing a user another document's data is the worst failure available here, so
before this change the second editor was refused outright.

### What changed

**New: `renderer/host-api.ts`** — a React context plus `useHostApi()`, both
falling back to `window.desktopApi`.

**`App` takes two optional props**, and defaults preserve desktop behaviour
exactly:

```ts
export interface AppProps {
  readonly api?: DesktopApi
  readonly onRuntime?: (runtime: UniverRuntime | null) => void
}
```

`onRuntime` exists because the `__univerAPI` dev global has the same problem in
miniature: it names whichever editor mounted last. With two editors open, a
selection bridge reading it reported the wrong document's active cell — observed,
then fixed by handing each editor its own runtime.

**The 80 call sites resolve the bridge three ways**, matching how the renderer is
already written — no new plumbing was invented:

| Where | How | Files |
| --- | --- | --- |
| Inside `App` | `hostApi`, a local const | 1 |
| Modules given per-instance state | `state.api` on `LazyWorkbookState` | 9 |
| React components | `useHostApi()` | 5 |
| Context objects | `deps.api`, `ctx.api` | 4 |
| AI skill factories | an `api` first parameter | 4 |

`LazyWorkbookState` gaining one field is what kept this small: it is already
threaded through most of the renderer, so nine files needed a one-token change.

### What did *not* change

- **No behaviour changes on the desktop.** Every entry point defaults to
  `window.desktopApi`; the Electron app takes exactly the path it took before.
- **No change to the `DesktopApi` contract**, the IPC channels, or the preload.
- **No change to the `DesktopApi` contract**, the IPC channels, or the preload.

### Rebasing

The change is mechanical, which is what makes it survivable. After
`git rebase upstream/main`:

```sh
cd web
npm run typecheck        # an un-threaded call site is a type error, not a silent bug
npm run check:drift      # undeclared files outside web/ fail here
npm run check:channels
npm run test && npm run compat
```

A conflict in these files is almost always upstream adding a new
`window.desktopApi` call. Resolve it by resolving the bridge the way its
neighbours do — the table above says which. **`npm run typecheck` catches a
missed site**, because `DesktopApi` is not implicitly available anywhere it was
threaded away.

The one thing typecheck cannot catch is a *new* `window.desktopApi` read
upstream adds in a file we never touched. `npm run check:host-global` fails on
those.

### How to retire this

Send it upstream. It is additive, changes no default behaviour, and the desktop
app is unaffected. If upstream takes it, delete the entries from
`upstream-changes.json` — `check:drift` will then report them as stale.

---

## Change 2 — the grid container id is per editor instance

**Files:** 7 modified under `apps/sheets/src/renderer/` — `App.tsx`,
`ExcelShell.tsx`, `univer-state.ts`, `shape-draw.ts`, `visual-actions.ts`,
`clear-selection-keyboard.ts`, `styles.css`.

### Why

`ExcelShell` rendered `<div id="univer-container">`, and four places resolved
that element **by id**: Univer itself (`createUniver({ container })`), the
shape-draw overlay, the formula-bar toggle, and the keyboard handler. One id is
fine for one App. Two Apps on one page produce two elements with one id, and
every `getElementById` returns the first — so one of the two grids is styled
and driven through the other's container while looking completely normal.

`web/src/embed/singletons.ts` used to work around this by *owning* the id:
exactly one editor held it, and it was renamed off the others as ownership
moved. That worked, and it was a hack on live DOM that had already needed a
second mechanism (start-up serialisation) to stop two editors claiming it in
one React commit.

### What changed

`univer-state.ts` gains `nextGridContainerId()`, a counter. `App` takes one id
per instance and passes it to `ExcelShell`, to the Univer preset, to the
formula-bar toggle and to shape draw. Styling and the keyboard predicate key
off a new `data-univer-grid` attribute instead, because they want *a* grid
rather than a particular one — `clear-selection-keyboard.ts` keeps `#univer-container`
in its selector group so its upstream test passes unmodified.

The ownership and parking code in `singletons.ts` is deleted.

### What this does **not** fix

Two grids **visible at the same time** still cannot both take keyboard input,
and the remaining cause is inside Univer rather than upstream: it renders its
internal editor hosts with fixed ids. Measured on a page with two editors:

```
__editor___INTERNAL_EDITOR__DOCS_NORMAL                    ×3
univer-doc-selection-container-__INTERNAL_EDITOR__DOCS_NORMAL ×3
univer-sheet-main-canvas_file-<sha>                        ×3
```

Nothing outside Univer can rename those. Several editors *mounted* with one
visible at a time — a tab bar, which is Papan's shape — works, and is what this
change makes structurally sound rather than a DOM trick. A genuinely
side-by-side view needs a separate realm, which means an iframe; see
`FINDINGS-EMBED.md`, "The option not taken".

### Rebasing

The same routine as Change 1. A conflict here is upstream adding another
`getElementById('univer-container')`: give it `gridContainerId` if it is inside
`App`, or `data-univer-grid` if it only needs to find a grid.

---

## Change 3 — upstream's tests build the state the app builds

**Files:** 10 under `apps/sheets/tests/`.

Not a feature: these are the repairs Change 1 owed. The tests construct
`LazyWorkbookState` with `as unknown as LazyWorkbookState`, so the host bridge
field added by Change 1 was **not** a type error in them — it was `undefined` at
runtime, and 34 tests failed for reasons that looked like product bugs. They
now supply `api` the way `App` does, through a getter, because several install
their stub after building the state and some run with no `window` at all.

`npm run check:upstream` compiles `apps/sheets` and runs its suite, so the next
change to these modules cannot break them quietly. One failure is allowed and
listed in `upstream-changes.json`: it fails at the baseline commit too.

---

## Change 4 — theme and language are scoped, and the host owns them

**Files:** `packages/ui/src/tokens.css`, `apps/sheets/src/renderer/App.tsx`,
`apps/sheets/src/renderer/i18n/locale.tsx`.

### Why

Upstream's renderer owns the whole document, so it puts `data-theme` and `lang`
on `<html>` and reads them back from there. Embedded, `<html>` belongs to the
host: Papan has its own theme switcher on that element, and two editors on one
page may legitimately differ — the conflict banner's compare view is precisely
a read-only editor beside an editable one.

Scoping the attributes to each editor's own container is the fix, and three
upstream assumptions stood in the way.

### What changed

**1. The light palette is bound to an attribute, not only to `:root`.**
`tokens.css` defined the dark palette under a bare `[data-theme='dark']`
selector — which any element matches — but the light palette only under
`:root`, which is `<html>` and nothing else. A container asking for light
therefore defined no tokens at all and inherited whatever `<html>` had. On a
system-dark browser, or inside a host whose own chrome is dark, that is dark
values under a `data-theme="light"` attribute. The selector is now
`:root, [data-theme='light']`. Equal specificity to the dark block, which
follows it, so nesting a dark editor inside a light page still resolves.

**2. Univer's `darkMode` resolves from the grid container, not from `<html>`.**
`App.tsx` mirrored `<html data-theme>` into Univer's own dark flag, because the
grid is painted on canvas and cannot follow CSS tokens. Embedded, that read the
*host's* theme: dark chrome over a light grid. `isDarkTheme()` now starts at
this instance's `gridContainerId` and walks up to the nearest `[data-theme]`
ancestor. On the desktop that ancestor is `<html>`, so the behaviour is
unchanged; in the browser it is the editor's own container.

**3. `LocaleProvider` no longer insists on writing `<html lang>`.**
A new `stampDocumentLang` prop, defaulting to `true`, so `main.tsx` is
untouched. The embedder passes `false` and puts the tag on its own container,
where it still drives `:lang()` and Chromium's per-language font fallback.

### What this makes possible, in `web/`

`web/src/host/settings.ts` gives the bridge a local source for
`onThemeChanged` and `onLanguageChanged` beside the wire one. These were push
channels — the server announces, the renderer listens — which is right on the
desktop and backwards in a browser, where the host's switcher is in the same
document and the server never hears the click. With both sources, changing the
`theme` or `locale` prop is an event rather than a remount: Univer's canvas
repaints and every non-React translator follows, on the same session.

`locale` is also no longer cast. Papan sends BCP-47 (`zh-CN`, `ms-MY`) and
upstream keys its dictionaries by a shorter code; `normalizeLang` — upstream's
own function — does the mapping, so all four of Papan's locales land on a real
dictionary and an unknown tag falls back to English instead of rendering keys.

### What did *not* change

`'dim'`. Papan's switcher offers light / dim / dark; upstream has no dim
palette, and a dim palette is twenty-odd colour decisions belonging to whoever
owns the design, not a shade this package can derive. The embed accepts `dim`
and resolves it to dark. If a real one lands it is a third block in
`tokens.css` and one more case in `web/src/embed/theme.ts`.

`dir`. `ar` and `he` are supported languages and nothing upstream sets
`dir="rtl"` for them. That is upstream's gap, not one this change introduces,
and fixing it is not a scoping question.

### Rebasing

The `tokens.css` hunk is a two-line selector and will conflict only if upstream
restructures the file; keep `[data-theme='light']` beside `:root`. The
`App.tsx` hunk conflicts if upstream touches `isDarkTheme`; keep the walk up
from `gridContainerId`. The `locale.tsx` hunk is additive.
