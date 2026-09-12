# Embedding the spreadsheet in a host application

Status: **multi-document works.** Several editors mount into a host React tree,
each on its own document, each reporting its own dirty state, saves and
selection. Switching tabs no longer remounts anything.

Getting there took one deliberate upstream change — the host bridge is now
per-instance rather than a `window` global — recorded in
[UPSTREAM-CHANGES.md](./UPSTREAM-CHANGES.md). The container-id half needed no
upstream change; the sections below record which approaches failed and why,
because the failures are the useful part.

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

### The host API: required the upstream change

Ownership routing was tried first and **measured to fail**: with two editors on
different documents, *both loaded the same one*.

The reason is structural. The document load is not part of mounting — the
renderer asks for it well after the grid exists — and every later call (a scroll
read, a save) leaves at a time nobody controls. Whoever owns the API then
answers. No ordering trick fixes it, because a call has no way to say which
React tree it came from.

Until it was fixed, a second editor on a different document was refused
outright, because showing a user someone else's spreadsheet in a tab labelled
with their filename is far worse than showing them an error.

`App` now takes the bridge as a prop. Verified in the harness with two
documents mounted together: each loads its own file, selections are reported
per document (`Budget!A1` and `Sales!A1`), and there are no errors.

For reference, the previous fallback — mounting only the active tab — cost
**~450ms per switch** (515 / 433 / 466 / 419ms), since every switch was a full
remount and reopen. That is the latency the upstream change removes.

### Two bugs found building it

Both from releasing ownership too eagerly, and both worth recording because
neither was visible in review:

- The routing proxy returned `undefined` for methods once ownership was
  released, so the renderer's own teardown call to `closeWorkbook` threw
  mid-unmount and left the page unable to mount anything afterwards. The last
  owner's API now survives release.
- An editor that unmounted during start-up held the mount queue for its full
  timeout, turning every tab switch into a twenty-second wait.

### The option not taken

An **iframe per editor** also works — verified — because a frame has its own
realm and therefore its own globals, and it needs no upstream change at all. It
was rejected in favour of the in-page component: Papan embeds editors as React
components, its SPA ships `frame-ancestors 'none'`, and each frame would carry
another copy of the bundle. Worth remembering if the upstream change ever
becomes unmaintainable.

## Save As, and the imperative handle

`SheetsHandle` is wired: `save()`, `exportBytes()`, `exportCsv()`, `reload()`
and `pendingEdits()`, reached through a ref (React 19 passes one as a plain
prop).

Every command drives the renderer through **upstream's own `onMenuAction`**,
repointed from the Electron native menu at the host (`src/host/commands.ts`,
one bus per editor). That choice is the whole design:

> Save As needs the pending edit journal, and the journal lives inside the
> renderer. Collecting it is the several hundred lines of `save-actions.ts`
> that walk the Univer state, batch the structural ops, and chunk the upload.
> Driving the command the renderer already listens for costs nothing.
> Reimplementing it host-side would be a second save path to keep correct
> forever.

COVERAGE gained a `host` status for this. `onMenuAction` had been `shell` — a
permanent no-op — with a comment saying to repoint it at a web equivalent once
one existed. This is that equivalent, and without a host it falls back to the
no-op, so the standalone page is unchanged.

### Save As does not save

`exportBytes()` returns bytes and changes nothing. The server assembles the
patched archive in its scratch directory, parks it behind a one-shot token, and
`GET /export/:token` streams it once and deletes it. The document is not
written, its version is not bumped, the sidecar session is not reopened, and
**the journal stays pending** — the copy has the edits, and so does the editor.

A GET rather than another `/invoke` channel because the payload is a file:
base64 through the JSON endpoint would inflate a 30MB workbook by a third on
both sides to move bytes a GET already moves. The bytes stay on disk until
fetched rather than in a map, because a resident set that stays flat is the
property this fork is being judged on.

What the renderer receives is `{ canceled: true }` — upstream's own shape, and
the accurate one, since nothing was saved *to this document*. It is also
literally upstream's semantics for the CSV branch of Save As: *"the journal
stays pending; the session keeps its identity (a copy semantics)"*. The
`export` half is stripped by the bridge, so upstream's `.strict()` result
schema stays satisfied on the only side that parses it.

**The cost of that choice, stated plainly:** the renderer's status bar reads
*"Save canceled."* after a Save As that succeeded. It is cosmetic and it is
wrong. Fixing it means an upstream change — a result the renderer can tell
apart from a cancel — which is not worth it for a status line while the host's
own chrome is reporting the real outcome.

### Who gets the bytes

The ribbon's own Save As button is still there and a user can click it. It
produces the same export, which arrives at the host as `onSaveAsRequest`.
`exportBytes()` takes precedence when a caller is waiting. So a host that
offers Save As only through its own chrome still answers the button that is
already on screen, instead of doing nothing.

## Conflict

Papan's `ConflictBanner` has three buttons — keep-mine, overwrite,
show-saved-version — and its trigger is a realtime `oo-conflict` broadcast:
*the file changed while the room is dirty*. All three, and the trigger, now
work. Verified in the harness, which reproduces the banner.

### The trigger is the part that was missing

Upstream's guard is a re-hash at save time, so it can only ever report a
conflict **after** someone tried to save. A banner exists to say so while there
is still a choice, which means the editor has to learn about it while idle.

`SheetsRouter.documentChanged(documentId)` is how. The host calls it from
wherever it learns that storage moved — its own realtime layer, a webhook, the
write path of another editor — and the server tells every session that is
behind. There is no port for storage to announce itself and polling `head()`
would be a guess dressed up as a fact, so the host is the source of truth
about its own storage.

Our own save path raises it too, for the case the host cannot see: two tabs on
one document, where the write went through *our* storage adapter rather than
through anything Papan's realtime layer watches.

`onConflict` now carries `source`: `'announced'` (idle, banner-shaped) or
`'rejected'` (a save that already failed). Same conflict, found early or late.

### Addressing, and why it is not optional

A push reaches every socket watching a document — including the socket whose
own save caused the change. So the message names the **stale sessions**, and a
client recognises itself by the session id it got when it opened. Without
that, saving in one tab raises a banner in that same tab, which is the fastest
way to teach people to ignore banners.

The session id changes on every save (the server reopens the sidecar over the
saved bytes), so the client re-reads it from the save result as well as from
the open.

### Overwrite

`handle.save({ overwrite: true })`. It does not skip the version check, it
*moves* it: the save becomes a compare-and-set against what storage holds now,
so a document that moves **again** mid-save still conflicts. What the person
approved was overwriting the version they were shown.

The flag cannot originate in the renderer — it is a decision a person made —
and `onMenuAction` carries an action and nothing else. So it is latched on the
host command bus and claimed by the bridge on the call the action produces,
one-shot with a 30-second window. A command the renderer returns early from
produces no call at all, and an overwrite left standing would attach itself to
whatever saved next; an autosave inheriting a person's decision about a
document they are no longer looking at is the failure that window closes.

It rides as a **second argument**. Upstream's preload sends exactly one, so
`args[1]` is unambiguously ours, and upstream's `.strict()` request schema
stays usable verbatim — a flag folded into the request the renderer builds
would fail the renderer's own validation before leaving the browser.

### Show saved version

`readOnly` on the component, which travels as a header the server **intersects**
with what `identify()` returned. A downgrade only: a client can give up rights
it has and can never claim rights it does not. Mounting a second editor on the
same document with `readOnly` gives the side-by-side compare view, on a fresh
session that reads what storage holds now.

### Measured

```
tab A edits, saves          → tab B: CONFLICT (announced), tab A: no banner
tab B saves                 → rejected, version_conflict, current version carried
tab B Overwrite             → saved; tab B's edit is in the file, tab A's is gone
external change + notify    → both tabs: CONFLICT (announced)
Show saved version          → second editor mounts, readOnly=true
```

## Theme scoping is half-broken

Found while testing the above, and it is not what this component's own comment
claimed. `theme="dark"` scopes correctly. **`theme="light"` does not**, on a
browser whose OS prefers dark.

Upstream's `tokens.css` defines the dark palette under a bare
`[data-theme='dark']` selector, which any container matches — but the light
palette only under `:root`, and `:root` is `<html>`. A container asking for
light therefore defines nothing and inherits the dark values `<html>` picked up
from the `prefers-color-scheme` block.

Stamping `<html>` would fix it and is what upstream's `main.tsx` does, but the
attribute is page-global and Papan has its own theming. This belongs with the
theme mapping work below, now with a known mechanism rather than a suspicion.

### Fixed on the way past

`HostTransportError` now carries the server's `detail`. The conflict event read
`detail.currentVersion` off a field that was never populated, so every conflict
reported an empty version — a banner that could say a conflict happened and
nothing else.

Unmounting an editor now closes its WebSocket. It did not before: every editor
a host had ever mounted kept one open for the life of the page.

## What this does not yet cover

- Theme: Papan has `dark` / `dim` / `light`; upstream has `light` / `dark` /
  `system`. `dim` has no mapping yet, and scoped `light` does not work at all —
  see "Theme scoping is half-broken" above.
- Locale: Papan ships `en`, `zh-CN`, `zh-TW`, `ms`; upstream has eleven with
  different codes. The mapping is unwritten.
- The selection bridge **polls at 250ms** rather than subscribing. Univer's
  selection events differ across versions and an event name that stops firing
  after an upgrade is exactly the silent breakage the Papan briefing warns this
  bridge is prone to. A subscription is better if a stable event exists.
- Save As for a **read-only** session is refused, because a session is still
  `canEdit: boolean`. Exporting a copy is exactly what Papan's `readcopy`
  permission means, so this resolves with the permission lattice, not before.
- Nothing here has run inside Papan. It runs inside a harness built to Papan's
  described constraints, which is a different and weaker claim.
