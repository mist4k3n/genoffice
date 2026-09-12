# Embedding the spreadsheet in a host application

Status: **the component works; one document at a time.** A single editor mounts
into a host React tree, drives a real document, and reports everything the host
needs. Tab switching works at ~450ms. Two editors on *different* documents are
refused with an explanatory error rather than silently showing one document's
data in the other's tab.

```sh
cd web
npm run serve -- --dir /tmp/corpus     # terminal 1
npm run harness                        # terminal 2
# http://localhost:5273/harness.html?docs=a.xlsx,b.xlsx
# add &mount=active for the mode that works today
```

## What works

`<SheetsEditor documentId apiBase theme visible … />` mounts upstream's
unmodified `App`, replacing `main.tsx`'s side-effect bootstrap (which demands
`#root`, makes its own React root, and stamps `lang`/`data-theme` onto `<html>`
— none of it appropriate inside a host).

The full host surface, verified in Chrome against a real document:

```
loaded, 1 sheet(s)
selection Budget!A1
1 pending edit(s)
SAVED, rewrote [xl/worksheets/sheet1.xml]
0 pending edit(s)
```

`SAVED, rewrote [xl/worksheets/sheet1.xml]` is the fidelity claim made visible
to the host: it can see exactly which package parts a save touched.

Events are derived by **observing the renderer's own HTTP traffic**, so the
renderer stays unmodified and does not know a host exists. Theme scopes to our
container rather than `<html>`, because the tokens key off a bare
`[data-theme]` attribute selector.

## Two page-level singletons, and how far they can be fixed in this repo

Upstream has two, both because an Electron window holds exactly one workbook:

1. **`App` renders `<div id="univer-container">`**, which Univer resolves *by
   id* (`createUniver({ container: 'univer-container' })`), and which
   `shape-draw.ts`, the formula-bar toggle and the keyboard handler all find
   with `getElementById`.
2. **`window.desktopApi` is a global**, and the transport inside it carries the
   document id.

Mounting two editors originally collapsed both onto whichever came first: the
second was blank, and after a tab switch the first was blank too.

### The container id: fixed here, no upstream change

Made *owned* rather than shared — exactly one editor holds the id at a time, and
ownership moves on mount and on becoming visible. Two facts make it work, both
measured rather than assumed:

- **Univer resolves the id once and keeps the element.** Renaming a live
  container left its canvases untouched and cells still writable through it.
- **`createUniver` runs in a `useEffect`**, and React runs a parent's
  `useLayoutEffect` first — so an editor can take ownership after its own
  markup exists and before the lookup happens.

Start-up is also serialised. React runs every layout effect in a commit before
any passive effect, so two editors mounting together both claim and only then
both call `createUniver`; the second claim wins and the first resolves the wrong
element. An editor now waits for the previous one's grid before rendering.

### The host API: cannot be fixed here

Ownership routing was tried and **measured to fail**: with two editors on
different documents, *both loaded the same one*.

The reason is structural. The document load is not part of mounting — the
renderer asks for it well after the grid exists — and every later call (a scroll
read, a save) leaves at a time nobody controls. Whoever owns the API then
answers. No ordering trick fixes it, because a call has no way to say which
React tree it came from.

So a second editor on a **different** document is refused outright:

```
Cannot open "gamma-sales.xlsx" while "acme-budget.xlsx" is open in this page:
the renderer reads a single global host API, so both editors would share one
document.
```

Showing a user someone else's spreadsheet in a tab labelled with their filename
is far worse than showing them an error. Two editors on the *same* document are
allowed — they share a session, which is what they would do anyway.

### What a host does today, measured

Mount the active document only. A tab switch is a remount:

```
switch → grid ready:  515ms, 433ms, 466ms, 419ms
```

**~450ms per tab switch**, with each editor loading its own document
(`Budget!A1` and `Sales!A1` respectively) and no errors. Unsaved work is not
lost — it lives in the server session — but scroll position and selection are.

### Two bugs found building it

Both from releasing ownership too eagerly, and both worth recording because
neither was visible in review:

- The routing proxy returned `undefined` for methods once ownership was
  released, so the renderer's own teardown call to `closeWorkbook` threw
  mid-unmount and left the page unable to mount anything afterwards. The last
  owner's API now survives release.
- An editor that unmounted during start-up held the mount queue for its full
  timeout, turning every tab switch into a twenty-second wait.

### If true multi-document is wanted

Either pass the host API to `App` instead of reading a global — a small
additive upstream change, tracked in `DRIFT.md` — or give each editor its own
iframe, since a frame has its own realm and therefore its own globals, at the
cost of a second copy of the bundle.

## What this does not yet cover

- `exportBytes()` is declared and not implemented — it is the Save As path, and
  it needs the server to return patched bytes instead of persisting them.
- Theme: Papan has `dark` / `dim` / `light`; upstream has `light` / `dark` /
  `system`. `dim` has no mapping yet.
- Locale: Papan ships `en`, `zh-CN`, `zh-TW`, `ms`; upstream has eleven with
  different codes. The mapping is unwritten.
- The selection bridge **polls at 250ms** rather than subscribing. Univer's
  selection events differ across versions and an event name that stops firing
  after an upgrade is exactly the silent breakage the Papan briefing warns this
  bridge is prone to. A subscription is better if a stable event exists.
- Nothing here has run inside Papan. It runs inside a harness built to Papan's
  described constraints, which is a different and weaker claim.
