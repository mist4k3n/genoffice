# GenOffice Sheets on the web

Serves the GenOffice Sheets renderer in a browser, backed by a Hono router that
speaks to the same Rust spreadsheet engine the desktop app uses.

Built to be embedded in [Papan](./PAPAN-BRIEFING.md) as a React component,
replacing its Collabora deployment.

```sh
cd web && npm install

cp -r fixtures /tmp/corpus            # the save checks mutate documents
npm run serve -- --dir /tmp/corpus    # terminal 1 — API + engine on :5274
npm run dev                           # terminal 2 — the app on :5273
# http://localhost:5273/?doc=acme-budget.xlsx

npm run harness                       # the embedding harness instead
# http://localhost:5273/harness.html?docs=acme-budget.xlsx,gamma-sales.xlsx
```

## How it fits together

```
browser                          server (your Hono app)
─────────────────────────        ──────────────────────────────
<SheetsEditor documentId … />    createSheetsRouter({ storage, identify })
  upstream renderer, unmodified    ├─ POST /invoke/:channel
  host bridge per instance ────▶   ├─ GET  /events   (WebSocket pushes)
                                   ├─ session registry + quotas
                                   └─ pool of xlsx-engine processes
```

The renderer is imported from `apps/sheets`, not copied. Everything it used to
ask Electron for now goes over HTTP; `web/src/host/coverage.ts` is the table of
all 59 methods and is typed `Record<keyof DesktopApi, …>`, so an upstream
contract change is a compile error naming the method.

### More than one instance

An open workbook lives inside one engine process on one instance — it is where
the file is, not a cache of it. One instance needs nothing extra. Behind a
balancer that does not pin by session, pass two more options:

```ts
createSheetsRouter({
  storage,
  identify,
  instanceId: process.env.INSTANCE_ID,
  sessions: redisSessionDirectory, // claim / lookup / release
  announceChange: (id, version) => bus.publish('sheets:changed', { id, version }),
})
```

`sessions` makes "this session is on another instance" (**421**,
`session_elsewhere`, naming the owner) a different answer from "this session
ended" (410) — without it they are the same answer, and the client reopens a
workbook that is still open. Add `forward` to the directory and the package
proxies the call itself instead of reporting it.

`announceChange` is the socket half: pushes reach the sockets _this_ instance
holds, so a host with several publishes and calls `documentChanged` on each.

## Embedding

### The package

```sh
npm run build      # dist/sheets-web.js, dist/sheets-web.css, dist/sheets-web.d.ts
npm run check:lib  # compiles a throwaway consumer against the built package
```

`npm run build` is the library build (`vite.lib.config.ts`) plus a rolled-up
declaration, and it is what a host installs. It runs on Vite 8, whose bundler
is rolldown: the same build under Vite 7 never finished rollup's render phase
in a quarter of an hour. React is external — the host owns
its own copy, and a second one is the hooks error `dedupe` exists to prevent.
Everything else is bundled, so embedding this does not mean installing the
renderer's dependency tree. `npm run build:app` is the other build: the three
HTML pages, which is what `npm run dev` serves. Those build with a relative
`base`, so they work wherever they are served from; a deployment that needs an
absolute prefix — assets on another origin, say — sets `SHEETS_WEB_BASE` at
build time.

```tsx
import { SheetsEditor } from '@mist4k3n/sheets-web'
import '@mist4k3n/sheets-web/style.css'
```

The stylesheet is a separate import because a bundler that does it for you is a
bundler deciding when the host's own CSS loses a specificity tie. Nothing else
is importable: the `exports` map seals `src/`, which is where the relative paths
into `apps/sheets` live, and `npm run check:lib` fails if a deep import starts
resolving.

The package is `private`, because publishing it is a registry decision this
repository should not make silently. `npm pack` produces the tarball; a private
registry needs `private` dropped and a `publishConfig` added.

```tsx
<SheetsEditor
  documentId={fileId}
  apiBase="/sheets"
  theme={papanTheme}
  locale={papanLocale}
  visible={isActiveTab}
  onDirtyChange={(n) => setDirty(n > 0)}
  onSaved={(e) => toast(`Saved — rewrote ${e.touchedEntries.length} part(s)`)}
  onConflict={(e) => showConflictBanner(e.currentVersion)}
  onSelectionChange={(s) => setAiContext(s)}
/>
```

Several viewers of the same document share one workbook in the engine: the
second person to open it costs nothing, and so does the twelfth. Each still
gets its own session handle, its own permission and its own liveness —
`/health` reports `sessions` (viewers) and `workbooks` (what they hold)
separately.

Several editors may be mounted at once, each on its own document. `visible`
matters: a host that hides a tab with `display: none` rather than unmounting it
must say so, because a canvas in a hidden subtree measures zero and nothing
resizes it back.

Two editors that must be **visible at the same time** need `isolate`, which
runs that editor in its own frame. Univer names its internal editor hosts with
fixed element ids, so two visible grids collide in one realm and a frame is the
only second realm available. Props, ref and events are identical either way;
`frameSrc` says where the frame's page is served (default `sheets-frame.html`,
relative to the bundle). Several editors with one visible at a time stay inline
— a frame costs another copy of the bundle.

### The assistant is off

The app's own AI panel does not render unless you ask for it with `ai`. Two
reasons, and either one is enough: a host that embeds Sheets beside its own
assistant wants one chat panel rather than two, and the channels the panel
needs (`aiStream`, `aiChat`, `setAiSettings`, the attachment readers) are not
among the ones this router serves — it would open onto 501s.

Off removes every entry point, not just the panel: the ribbon's AI group, the
prompt that follows a drag-selection, and Translate, which is an AI prompt
behind a ribbon button. What stays is the context a host assistant needs —
`onSelectionChange` reports what the user has selected, so your own panel can
quote it.

`theme` and `locale` are scoped to each editor's container, so two editors can
differ and neither touches the host's `<html>`. Both take the host's own
values: `theme` accepts `light` / `dark` / `dim` / `system` (`dim` has no
upstream palette and resolves to dark, `system` is resolved here and follows
the OS live), and `locale` accepts any BCP-47 tag. Changing either one is an
event on the live session — the grid repaints, the strings change, the document
stays open.

### Commands

A ref gives the host `save()`, `exportBytes()`, `exportCsv()`, `reload()` and
`pendingEdits()`.

```tsx
const sheets = useRef<SheetsHandle>(null)

// Save As is the host's flow with our bytes: the editor patches the workbook,
// the host decides where the copy goes.
async function saveAs() {
  const { bytes, suggestedName } = await sheets.current!.exportBytes()
  await picker.save(bytes, suggestedName)
}
```

`exportBytes()` writes nothing. The document keeps its version and the editor
keeps its unsaved edits — the copy carries them too. Add `onSaveAsRequest` to
answer the editor's own ribbon Save As button, which produces the same bytes
without anyone calling the handle.

### Conflict

`onConflict` fires while the document is open, not only when a save fails, so
a host can show a banner while there is still a choice to make. Tell the server
when your storage moves:

```ts
// wherever you learn the document changed — realtime, webhook, another writer
await sheets.documentChanged(fileId)
```

The three resolutions a banner offers map to three calls:

| Button             | Call                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| Keep mine          | dismiss the banner; nothing to call                                     |
| Overwrite          | `handle.save({ overwrite: true })`                                      |
| Discard mine       | `handle.reload()`                                                       |
| Show saved version | mount a second `<SheetsEditor readOnly isolate />` on the same document |

`overwrite` does not skip the version check — it moves it to a compare-and-set
against what storage holds now, so a document that moves _again_ mid-save still
conflicts. `readOnly` is a downgrade the server intersects with the rights
`identify()` granted; it can never raise them.

## Serving it

```ts
app.route('/sheets', createSheetsRouter({
  storage,                 // head / get / put with version tokens
  identify: (req) => …,    // { userId, tenantId, documentId, permission }
  secrets,                 // optional: passwords for encrypted workbooks
  drafts,                  // optional: where unsaved work lives between saves
}).app)
```

### Two environment variables worth setting

```sh
MALLOC_ARENA_MAX=1
MALLOC_TRIM_THRESHOLD_=131072
```

The engine inherits the API process's environment. Without these, glibc's
allocator drifts under repeated open/close: the same three heavy workbooks cost
79 MB resident on the first cycle and 105 MB on the fourth. With them it holds
flat at ~71 MB, and each workbook costs 11% less. Measured in
`FINDINGS-PAPAN.md` §1.

### Permission is a lattice, resolved per request

`permission` is `owner | admin | readwrite | readcopy | hidden | none`, not a
boolean, because three distinctions matter:

|                             |                                                                  |
| --------------------------- | ---------------------------------------------------------------- |
| `owner` `admin` `readwrite` | read, copy, write                                                |
| `readcopy`                  | read and copy — Save As works, saving does not                   |
| `hidden`                    | answered as `404`: the caller must not learn the document exists |
| `none`                      | answered as `403`                                                |

`identify()` runs on every request and **every mutation is checked against that
result**, never against what the session recorded at open. A grant you revoke
fails on the next call, not at the next open.

Pass `readOnly` on the component for a viewer and the grid stops taking input —
typing, the ribbon, Delete — the way Excel's read-only does, while Save As
still works. It is a downgrade only: the server intersects it with the rights
`identify()` granted.

One limit: **two editors visible at the same time break each other** — the
second to mount takes the keyboard. Univer renders its internal editor hosts
with fixed element ids, so two of them in one realm collide. Mounting several
editors is fine as long as one is visible at a time, which is what a tab bar
means; a genuinely side-by-side view needs an iframe.

### Drafts are not versions

The editor writes a recovery copy every 30 seconds while a workbook is dirty,
through a channel that never touches the document. Give it a `DraftAdapter` and
that copy survives a crash or a closed tab; leave it out and an interrupted
session loses whatever was pending.

A draft is served ahead of storage on the next open, silently, and deleted the
moment a real save supersedes it — or the moment the document moves underneath
it, since edits to a version that no longer exists cannot be applied. Wire
`onDraftRestored` if you show a dirty indicator: a restored draft leaves the
edit journal empty, so `onDirtyChange` reports zero for a document that is not
saved.

Only an explicit save writes a version. The AutoSave toggle, which writes the
document on a timer, is **off by default** for that reason.

`StorageAdapter` may also offer `localPath()`. Where content is stored
immutably — content-addressed blobs, say — the engine reads storage directly and
no per-session snapshot is written at all.

## This fork modifies upstream. Read this before you edit.

The fork keeps its delta under `web/` so `git rebase upstream/main` stays clean.
**One deliberate exception exists**, and it is documented in
[UPSTREAM-CHANGES.md](./UPSTREAM-CHANGES.md): the renderer's host bridge is
per-editor-instance rather than a `window` global, so one page can hold several
documents.

The invariant is therefore not "nothing outside `web/` changes" but:

> Every file outside `web/` that differs is declared in `upstream-changes.json`
> and justified in `UPSTREAM-CHANGES.md`.

`npm run check:drift` fails on anything undeclared. Adding to that list is a
decision someone writes down.

## Checks

| Command                                | What it protects                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                    | The whole renderer under the browser config. An un-threaded host call is a type error                                                                       |
| `npm test`                             | Prefetch correctness, export-slot lifetime, the save/Save As split                                                                                          |
| `npm run compat`                       | Every corpus workbook: HTTP service vs a directly-spawned engine, plus a save round trip. **Saves over what it reads** — serve a copy, never `web/fixtures` |
| `npm run check:lib`                    | A host can import the built package and typecheck against it, and cannot reach past its exports map                                                         |
| `npm run check:base`                   | The built pages load every asset they reference when served from a prefix rather than the site root                                                         |
| `npm run check:drift`                  | Undeclared changes outside `web/`, and upstream movement in watched files                                                                                   |
| `npm run check:channels`               | Channel names still match the preload. The compiler cannot see these                                                                                        |
| `npm run check:host-global`            | A stray `window.desktopApi` read, which silently reintroduces cross-document bleed                                                                          |
| `npm run check:server`                 | No browser globals server-side; coverage and handlers agree both ways                                                                                       |
| `npm run check:mirror`                 | The one copied upstream function still matches its original                                                                                                 |
| `npm run check:upstream`               | `apps/sheets` still compiles and its own test suite still passes                                                                                            |
| `npm run bench` / `bench:memory`       | Scroll latency; resident memory per open workbook                                                                                                           |
| `npm run bench:linux`                  | The same memory benchmark in a Linux container — macOS `ps rss` cannot answer it                                                                            |
| `npm run bench:linux -- --viewers N`   | What the Nth reader of **one** document costs                                                                                                               |
| `node tools/make-fixture.mjs --rows N` | Generate a heavy workbook; the corpus tops out at 0.4 MB                                                                                                    |

## Where things are

|                        |                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `PLAN.md`              | The phase plan, and the reasoning behind the architecture                                   |
| `UPSTREAM-CHANGES.md`  | **Every change outside `web/`, and why**                                                    |
| `DRIFT.md`             | Watched upstream files; what breaks when each moves                                         |
| `FINDINGS-0x.md`       | What each phase actually established, including what failed                                 |
| `FINDINGS-EMBED.md`    | Embedding: the singletons, and how far each could be fixed                                  |
| `FINDINGS-PAPAN.md`    | What the Papan briefing changed                                                             |
| `PAPAN-INTEGRATION.md` | **What has to be true before Papan can open a document**, and who owns each piece           |
| `FINDINGS-COLLAB.md`   | The collaboration spike: what two people on one document cost                               |
| `server/`              | The Hono router, session registry, engine pool                                              |
| `src/host/`            | The browser-side bridge: transport, coverage table, prefetch                                |
| `src/embed/`           | The mountable component and its host API; `index.ts` is the package's entire public surface |
| `vite.lib.config.ts`   | The library build. `vite.config.ts` is the page build, and they share nothing               |
| `protocol.ts`          | The short list of wire shapes that are ours, not upstream's                                 |
