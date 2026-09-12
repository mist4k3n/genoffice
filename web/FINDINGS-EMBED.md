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

### Show saved version — mounts, but the pane beside it goes dead

`readOnly` on the component travels as a header the server **intersects** with
what `identify()` returned. A downgrade only: a client can give up rights it
has and can never claim rights it does not. Mounting a second editor on the
same document with `readOnly` does produce the side-by-side view, on a fresh
session reading what storage holds now.

**It is not usable yet, and this corrects an earlier claim here.** Two editors
visible *at the same time* break each other: `#univer-container` is a
page-level element id, upstream resolves the grid's keyboard host from it
(`App.tsx`, `const gridHost = document.getElementById('univer-container')`),
and only one editor can own it. The second editor to mount takes it, and the
first stops accepting input.

Verified to be nothing to do with the read-only work: with the compare pane
mounted **fully editable**, the primary pane froze just the same.

`singletons.ts` solved this for *tab switching*, where one editor is visible at
a time. Simultaneous visibility is a different problem and needs the container
id scoped per editor — five call sites across four upstream files, so a real
upstream change and a decision to make, not an oversight.

Until then a host should show the stored version some other way: its own
viewer, a download, or a modal that replaces the editor rather than sitting
beside it.

### Measured

```
tab A edits, saves          → tab B: CONFLICT (announced), tab A: no banner
tab B saves                 → rejected, version_conflict, current version carried
tab B Overwrite             → saved; tab B's edit is in the file, tab A's is gone
external change + notify    → both tabs: CONFLICT (announced)
Show saved version          → second editor mounts, readOnly=true
                              (but see above: the pane beside it stops taking
                               input -- a page-singleton limit, pre-existing)
```

## Draft and version

`#617` names the two ways of getting saves wrong: *"version spam or silent
exit-save data loss."* Papan avoids both by routing autosave and exit-save to a
draft store and only explicit saves to the file. That split now exists here,
and almost none of it needed inventing — **upstream already draws the same
line.**

Its renderer writes a crash-recovery copy every 30 seconds while a workbook is
dirty, on its own timer, through its own channel (`workbook:write-recovery`),
deliberately separate from Save and deliberately not the document. On the
desktop that copy lands under userData. Here it lands in a `DraftAdapter` the
host supplies.

So the mapping is one line long:

| Upstream channel | Goes to |
| --- | --- |
| `workbook:write-recovery`, every 30s while dirty | the draft store |
| `workbook:save`, a person pressing Save | a version, and the draft is deleted |

Upstream's AutoSave pill writes the *document* every 30 seconds, which is
version spam by Papan's standard. It ships **off** by default here, which is
not a new opinion: Papan's Collabora is configured the same way
(`per_document.autosave_duration_secs=0`), with the draft as the safety net. A
host that turns it on is choosing versions, and can.

### The draft comes back silently

On open, a draft outranks the stored document and no one is asked. That is
Papan's rule — its WOPI `GetFile` serves a non-stale draft ahead of storage —
and it is the difference between "your edits came back" and a restore prompt
posing a question the user has no way to evaluate. Upstream's desktop
`recoveryPrompt` channel stays unimplemented on purpose.

### Staleness, and the work it deletes

A draft records the storage version it was edited from. When that no longer
matches, the draft is **deleted**, not offered: those edits describe a document
that no longer exists. Papan does the same thing with
`draftHash !== file.contentHash`.

Worth being plain about the consequence — that deletion loses the unsaved work.
It is the right trade (silently reapplying edits to someone else's newer
document is worse) and it is why the conflict banner matters: while the session
is live, `documentChanged` raises the conflict at the moment the document
moves, which is when there is still a person able to decide. The stale-draft
deletion is what happens when nobody was there.

The recovery channel refuses to write for the same reason: a session already
behind the document produces no draft rather than a doomed one.

### The dirty indicator would otherwise lie

Restoring a draft leaves the edit journal **empty** — the edits are in the bytes
the engine opened — so the renderer honestly reports zero pending edits for a
document that differs from what storage holds. A host wiring only
`onDirtyChange` would show "saved".

Hence `onDraftRestored`. Papan persists its own dirty flag server-side for
exactly this reason: it has to survive a session ending.

### Measured

```
edit, wait for the 30s tick   → draft written; document byte-identical
reload the page               → edits back, onDraftRestored fired, 0 pending edits
explicit save                 → version written, draft deleted
document changes, then reopen → stale draft deleted, storage opened, nothing restored
```

### Not covered

Exit-save. A browser tab closing cannot reliably finish an async save, so the
30-second draft is the whole safety net and `beforeunload` is the whole
warning. Papan's Collabora is in the same position — its exit-save is a
best-effort write from a server-side process, which we do not have.

## Permission

`identify()` returned `canEdit: boolean`. It now returns Papan's lattice
verbatim — `owner | admin | readwrite | readcopy | hidden | none` — because the
boolean was answering three different questions with one bit, and getting two
of them wrong.

**`readcopy` was indistinguishable from `none`.** It is a real and common
state: a person who may open a workbook and take a copy, and may not change the
original. Under a boolean it collapsed to `canEdit: false`, and Save As — the
one thing that state exists to allow — was refused. It now works.

**`hidden` was indistinguishable from `none` too.** It means the caller must
not learn the document exists, which is a different *answer*, not a different
message. `hidden` is now `404 not_found`; `none` is `403 forbidden`.

`owner` and `admin` are not yet distinguished from `readwrite`. Nothing here
needs to be, and the day something does (delete, share, change permissions) the
value will already have arrived rather than being a contract change.

### The fail-closed bug this found

The write checks read **the session's** captured permission, so a grant revoked
mid-session kept saving until the workbook was reopened. The briefing is
explicit that permission must be re-resolved on every read and every save, and
this was failing open.

Every mutation gate now reads the **request's** permission. The session still
records what was true at open, because the workbook's `readOnly` flag was
reported from it and the reopen after a save has to report the same thing — but
that is a fact about the past, not an authorisation.

Measured, against a session opened as `owner`:

```
readcopy + save (with edits)      → 403 forbidden
readcopy + save-as, unmodified    → export token          ← the readcopy unblock
readcopy + save-as, with edits    → 403 forbidden         ← no laundering
owner    + save-as, with edits    → export token
owner session, permission revoked → 403 forbidden         ← fail-closed
owner    + save                   → a version
hidden   / none  at open          → 404 / 403
```

### A viewer may copy, and may not launder

Save As for a read-only session is allowed only when the request carries no
changes. Otherwise "export a copy" becomes a write path that produces modified
bytes for someone who may not modify.

That check is derived from the payload rather than from a list of field names,
and the reason is drift: upstream adds mutation kinds regularly — sparklines,
pivot refreshes, protected ranges — and a hand-written list would silently stop
covering them. Anything in the request that is not its own identity counts, so
a field upstream adds later is refused for a viewer by default rather than
allowed by omission.

### Read-only in the UI, not only at the boundary

**Upstream's renderer ignores `WorkbookFile.readOnly`.** It is in the schema,
the server sets it honestly, and nothing in `apps/sheets/src/renderer` reads
it. Left at that, a viewer sees a fully editable grid, types into it, and finds
out at Save with a 403. Papan's Collabora does not behave that way, and neither
does Excel: read-only means the cells do not take input.

Univer already has the mechanism, and this component already holds the editor's
own `univerAPI` through `onRuntime`, so no upstream change was needed.
`read-only.ts` calls `setEditable(false)` on the workbook, which gates the
commands every mutation runs through — the ribbon's included, because upstream's
ribbon actions call the same facade (`range.setValues`) the in-cell editor does.

Measured, with the whole thing mounted read-only:

```
type into a cell   → nothing; 0 pending edits
ribbon Bold        → nothing; 0 pending edits
Delete             → nothing; 0 pending edits
exportBytes()      → 12019 bytes, "rewrote nothing"   ← readcopy still works
an editable editor elsewhere on the page → unaffected
```

Applied on a retry loop rather than once: the workbook arrives after the
runtime does, and a save replaces it with a fresh one that starts editable.

### One editable workbook per unit id

Univer keys edit permission by *unit id*, and upstream names a workbook after
its content — `file-<sha256>`. **Two editors showing the same document share a
unit**, and share the permission with it.

Measured: locking a read-only pane also froze the editable pane beside it, and
the user's unsaved workbook silently stopped taking input while looking
completely normal.

So a read-only editor locks the unit only while no editable editor shares it,
gives the lock back if one appears, and tells the host through `onError` when
it cannot lock. The asymmetry is deliberate: an unlocked viewer can scribble in
a grid whose session the server holds read-only and loses the scribbles; a
locked editor loses the user's real work with nothing to indicate anything is
wrong.

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
