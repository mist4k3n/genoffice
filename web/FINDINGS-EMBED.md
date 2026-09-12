# Embedding the spreadsheet in a host application

Status: **the component works; two of them do not.** A single editor mounts
into a host React tree, drives a real document, and reports everything the host
needs. Mounting two at once produces a blank editor, and that is an upstream
constraint rather than a bug in the embed.

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

## The blocker: one editor per page

Two `<SheetsEditor>` instances mounted together leave the second blank, and
switching to it leaves the *first* blank too.

Measured in the harness — two tabs, both mounted, one hidden:

| | container | canvases |
| --- | --- | --- |
| visible tab | 1254×733 | toolbar + grid (2508×1335) |
| hidden tab | 0×0 | **none** |

After switching tabs, the newly visible one still had **zero canvases** and the
newly hidden one collapsed to 0×0. Neither is usable.

Two hard singletons underneath, both from the Electron model of one window per
workbook:

1. **`window.desktopApi` is a global**, and the transport baked into it carries
   the document id. Two documents need two of them.
2. **`App` renders `<div id="univer-container">`**, which Univer resolves *by id*
   (`createUniver({ container: 'univer-container' })`), and which
   `shape-draw.ts`, the formula-bar toggle and the keyboard handler all find
   with `getElementById`. Two instances produce two elements with one id, and
   every one of those lookups silently returns the first.

### The workaround, measured

Mounting only the active tab works. A tab switch is a full remount and reopen:

```
switch → grid ready:  502ms, 464ms, 471ms, 433ms
```

**~450ms per tab switch.** Noticeable, and far better than an iframe reload,
but it is a remount — unsaved state lives in the server session, so nothing is
lost, but scroll position and selection are.

### The fix

A small, well-shaped upstream change: thread a container id through
`App` → `ExcelShell` → the three helpers, and let the host API be injected
rather than read from `window`. Both are additive and neither changes desktop
behaviour. Filed in `DRIFT.md` as a Tier 1 PR.

Until then a host with tabs mounts the active document only, and
`mount=active` is the supported mode.

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
