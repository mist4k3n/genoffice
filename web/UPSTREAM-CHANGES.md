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
- **The `univer-container` element id is untouched.** It is also a page-level
  global, but it is handled entirely in `web/src/embed/singletons.ts` by giving
  it to one editor at a time — see `FINDINGS-EMBED.md` for why that works where
  the same trick fails for the API.

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
