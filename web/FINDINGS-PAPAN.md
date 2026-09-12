# What the Papan briefing changes

Source: `PAPAN-BRIEFING.md` (Papan `main` @ `ded0db4c2`), alongside this file.
It is an unusually good answer and it invalidates several things I had assumed.

## 0. There is a competing decision in flight, and it is not mine to make

Papan decided on **2026-09-11** to migrate Collabora → **OnlyOffice CE 9.4**
(`docs/plans/2026-09-11_OFFICE_ENGINE_MIGRATION.md`, issue **#617**, *"Decided.
Spike, then build."* — nothing built yet).

Same motivation as this fork, same fix direction, different engine. The two
efforts collide head-on, and #617 states the constraint any alternative has to
argue against:

> office editing is **not** the primary product — we optimise for server cost
> and operational simplicity over editor polish and whitelabel.

The one place the two genuinely differ on substance: **#617 accepts a fidelity
loss as the price of client-side rendering.** This fork does not — it patches
only the changed parts of the package, and the corpus harness measures that
every run (a no-op save leaves every entry byte-identical; a one-cell edit
rewrites exactly `sheet1.xml`).

This is a product decision, not an engineering one. What follows is the
evidence I can contribute to it.

## 1. The memory measurement, which is the whole argument

Collabora's ceiling is memory inside coolwsd: **~145MB settled, ~280MB peak per
heavy `.xlsx`**, giving **~7 concurrent documents across all tenants** on
gnexis's 7.6GB box. #617's target is ~100–200 documents at ~8–15MB each.

Measured here (`npm run bench:memory -- --slope 24`), 24 independent copies of
the 8,001-row corpus workbook, one engine process, each fully indexed:

```
    #  engine RSS   cumulative Δ   per workbook
    1      29.5MB         22.8MB         22.8MB
    8      26.3MB         19.6MB          2.4MB
   16      21.8MB         15.1MB          0.9MB
   24      25.3MB         18.5MB          0.8MB
```

**The engine's RSS is flat.** Twenty-four heavy workbooks cost the same ~25MB as
one. There is no per-document slope, because the Rust sidecar streams ranges out
of the archive instead of materialising a document model — the thing LibreOffice
fundamentally cannot do.

Checked that this is streaming and not silent eviction: with twenty sessions
open and every one fully indexed, the **first** session still returns
byte-identical data.

So against #617's 8–15MB-per-connection target, the engine side is roughly two
orders of magnitude under it. **The real per-document cost in this architecture
is not RAM, it is the snapshot on disk** — see §2, which is now fixed.

Caveats, stated because they matter: one process, one machine, macOS, a 0.4MB
workbook with 56k cells. The number to re-measure before quoting anywhere that
counts is a 30MB financial workbook under Linux, and per-*connection* cost once
Yjs rooms exist.

## 2. Fixed already

**Storage can hand the engine an immutable path instead of bytes.**
Papan's blobs are SHA-256-addressed and therefore immutable — which is exactly
the guarantee a per-session snapshot exists to provide. `StorageAdapter` now has
an optional `localPath()`; when present, **no snapshot is written at all.**

This was not a micro-optimisation. A snapshot is a full duplicate of every open
workbook, and **`/tmp` is a tmpfs on Papan's hosts** — so a 30MB workbook cost
30MB of RAM per open document, against a 1.2GB office budget. That single fact
from the briefing turned the "engine is flat" result from true-but-irrelevant
into true.

The contract is immutability, not existence, and it says so: an adapter over
mutable storage must return `null`.

**The compat gate was flaky and I had reported it as clean.** ~1 run in 6 failed
on a single extra merge. Reads now settle on `indexedThroughRow`, failures name
the differing lines, and a mismatch is re-read before being believed — merge
discovery is lazy and `indexedThroughRow` covers only cell indexing. Ten
consecutive clean runs.

## 3. Wrong in my design, in priority order

**Save As is a small fix, not a missing port.** `SaveAsDialog` takes a
`customSave` callback (`features/workspace/ui/SaveAsDialog.tsx:49`) that
overrides the server path entirely; the PDF exporter already uses it. The 501
should become "produce the patched bytes and hand them to the host", and Papan's
picker does the rest. **No document-create port is needed.**

**A 409 must reach the host, not the editor.** Papan surfaces conflict as an
in-app banner with keep-mine / overwrite / show-saved-version
(`useWopiConflict` + `ConflictBanner`), and deliberately removed native 409
handling because it duplicated that UI. Our `version_conflict` currently
rejects at the renderer. It needs to become a host event carrying the current
`contentHash`.

**The CAS I rely on does not exist on the path that matters.** `TreeStorage.write()`
has three-valued conditional write; **`writeById()` — what the office path uses —
has none**, and today's office save is last-write-wins by explicit decision. The
briefing's read is that adding the parameter is small and well-shaped (the
advisory locks are already there). Until then the adapter must either use
`write()` or accept last-write-wins.

**Saves must distinguish draft from version.** Autosave and exit-save go to a
disk-backed draft store; only explicit saves create versions. Ours always writes
a version. #617 calls getting this wrong *"version spam or silent exit-save data
loss"*. A 30-second recovery copy is a draft, never a version.

**`canEdit: boolean` is too coarse and checked in the wrong place.** ~~The
lattice is~~ *Done — see FINDINGS-EMBED.md, "Permission".* `identify()` now
returns the lattice, `hidden` answers 404 and `none` 403, `readcopy` can Save
As, and every mutation is checked against the request's permission rather than
the session's. That last part was a real fail-open bug: a grant revoked
mid-session kept saving until the workbook was reopened.

**Identity has shapes I did not model.** A caller may be a *share principal*
with a synthetic id and no row in `users` (writes must stamp `actor.type =
'share'` or version history breaks its FK join), and `documentId` may be a
**compound mount id** `s_<mount>_<src>` with no row in the requesting tenant.
Both are opaque to us, which is fine — but the adapter must be told they exist.

**`/tmp` for scratch is wrong on their hosts** (tmpfs, half of RAM). Mostly
dissolved by §2, but saves still stage a temp target. Scratch must be explicit
in production.

## 4. Bigger than a fix

**There is already a Yjs xlsx persistence plugin.** Papan has a 3,788-line
custom Yjs server with a registered `xlsx`/`xls` plugin, a complete Y.Doc sheet
model (cells, formulas, styles, merges, charts, notes, hyperlinks, drawings), a
formula engine, cross-instance awareness, and a `MSG_*` save/dirty/discard/
conflict protocol. The xlsx **edit client was never wired** — the plugin is live
only as a stateless read-only preview.

Phase 06 may be mostly wiring. But there is a real tension to resolve first:
their Y.Doc is a **cell model**, and `extractContent` rebuilds the workbook from
it. That is precisely the round trip this fork avoids in order to keep
byte-level fidelity. The likely answer is to use Yjs as the transport for the
**edit journal** rather than as the document model — the journal is already the
renderer's own representation, and the save path already turns it into part
surgery. That needs designing, not assuming.

**No session affinity, and the pool needs it.** Two API instances, no sticky
routing, and the codebase treats "any request can hit any instance" as an
invariant satisfied with atomic Redis. An open workbook lives inside one engine
process, so this is a correctness problem, not tuning. There is a
specified-but-deferred **document-id shard router (#603)** for exactly this —
find it before designing a second one. Interim options: `PAPAN_SINGLE_API=1`, or
a Redis session→instance map.

**Admission control, not just a pool size.** `office-brokers.ts` does
RAM-weighted admission through a single Lua eval, because two instances can
otherwise both admit into the last slot. Our quotas are per-process and
in-memory. Given §1 the budget is far less tight, but #617 §5.G is explicit:
*"503-busy / idle-release UX: decide, don't just delete."*

**A React component, not an iframe.** The SPA ships `frame-ancestors 'none'` and
can never be framed. Editors already register as lazy React components
(`registerEditor`). Two consequences: our Vite app becomes a mountable component,
and **decks stay mounted and hidden with `display: none`** — mount-time effects
run once, ever, so canvas sizing and refresh must go through
`DeckVisibility` / `useRefreshWhenShown`.

**Password-protected workbooks are more valuable than I thought.** Papan's *only*
decryption path is LibreOffice inside the Collabora image
(`features/agent/tools/edit-office.ts`). Retiring Collabora removes it. Our
phase-05 encryption work would replace that dependency rather than merely add a
feature. Passwords belong in `@papan/keybook`, not a third secret store.

## 5. Assumptions of mine the briefing corrected

| I assumed | Actually |
| --- | --- |
| An SDK exists for the Collabora↔VFS path | None. WOPI routes call `getStorage()` directly — the seam is still open to design |
| Save As needs a new port | `customSave` already exists |
| ~10 concurrent clients is the ceiling | ~7 concurrent **documents**; co-editors of one document are ~free. Size in resident workbooks, not sessions |
| Yjs is for other document types | A full xlsx plugin exists, unwired |
| A document has a URL | Documents are **tabs**; no per-document route |
| `worker-src blob:` is the CSP risk | The policy is `frame-ancestors 'none'` and nothing else. The risk is the opposite: never framable |
| Bytes are in object storage; use signed URLs | Local content-addressed blobs. No CDN. Read the blob directly |
| Autosave comes free from Collabora | Collabora has **no** periodic autosave; exit-save only. Papan's draft store is the safety net |
| 11 UI languages | Four: `en`, `zh-CN`, `zh-TW`, `ms`. Themes are `dark`/`dim`/`light` |

## 6. What I would do next, if the answer to §0 is "continue"

1. Read `docs/plans/2026-09-11_OFFICE_ENGINE_MIGRATION.md` §5 in full — a ~60-item
   list of behaviours any replacement must match, each one a bug someone paid for.
2. Read `git show 635722b5d^:features/collab/ONLYOFFICE.md` (411 lines): Papan
   already shipped and removed a client-rendered engine. Its doc-key, save,
   dirty and conflict design is the closest prior art that exists.
3. Re-measure §1 on Linux with a 30MB workbook before anyone quotes it.
4. Then: Save As via `customSave`, conflict-as-host-event, the draft/version
   split, and the permission lattice — in that order.
