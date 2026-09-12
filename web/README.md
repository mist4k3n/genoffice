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

## Embedding

```tsx
<SheetsEditor
  documentId={fileId}
  apiBase="/sheets"
  theme="dark"
  visible={isActiveTab}
  onDirtyChange={(n) => setDirty(n > 0)}
  onSaved={(e) => toast(`Saved — rewrote ${e.touchedEntries.length} part(s)`)}
  onConflict={(e) => showConflictBanner(e.currentVersion)}
  onSelectionChange={(s) => setAiContext(s)}
/>
```

Several editors may be mounted at once, each on its own document. `visible`
matters: a host that hides a tab with `display: none` rather than unmounting it
must say so, because a canvas in a hidden subtree measures zero and nothing
resizes it back.

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

| Button | Call |
| --- | --- |
| Keep mine | dismiss the banner; nothing to call |
| Overwrite | `handle.save({ overwrite: true })` |
| Discard mine | `handle.reload()` |
| Show saved version | mount a second `<SheetsEditor readOnly />` on the same document |

`overwrite` does not skip the version check — it moves it to a compare-and-set
against what storage holds now, so a document that moves *again* mid-save still
conflicts. `readOnly` is a downgrade the server intersects with the rights
`identify()` granted; it can never raise them.

## Serving it

```ts
app.route('/sheets', createSheetsRouter({
  storage,                 // head / get / put with version tokens
  identify: (req) => …,    // { userId, tenantId, documentId, canEdit }
  secrets,                 // optional: passwords for encrypted workbooks
  drafts,                  // optional: where unsaved work lives between saves
}).app)
```

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

| Command | What it protects |
| --- | --- |
| `npm run typecheck` | The whole renderer under the browser config. An un-threaded host call is a type error |
| `npm test` | Prefetch correctness, export-slot lifetime, the save/Save As split |
| `npm run compat` | Every corpus workbook: HTTP service vs a directly-spawned engine, plus a save round trip. **Saves over what it reads** — serve a copy, never `web/fixtures` |
| `npm run check:drift` | Undeclared changes outside `web/`, and upstream movement in watched files |
| `npm run check:channels` | Channel names still match the preload. The compiler cannot see these |
| `npm run check:host-global` | A stray `window.desktopApi` read, which silently reintroduces cross-document bleed |
| `npm run check:server` | No browser globals server-side; coverage and handlers agree both ways |
| `npm run check:mirror` | The one copied upstream function still matches its original |
| `npm run bench` / `bench:memory` | Scroll latency; resident memory per open workbook |

## Where things are

| | |
| --- | --- |
| `PLAN.md` | The phase plan, and the reasoning behind the architecture |
| `UPSTREAM-CHANGES.md` | **Every change outside `web/`, and why** |
| `DRIFT.md` | Watched upstream files; what breaks when each moves |
| `FINDINGS-0x.md` | What each phase actually established, including what failed |
| `FINDINGS-EMBED.md` | Embedding: the singletons, and how far each could be fixed |
| `FINDINGS-PAPAN.md` | What the Papan briefing changed |
| `server/` | The Hono router, session registry, engine pool |
| `src/host/` | The browser-side bridge: transport, coverage table, prefetch |
| `src/embed/` | The mountable component and its host API |
| `protocol.ts` | The short list of wire shapes that are ours, not upstream's |
