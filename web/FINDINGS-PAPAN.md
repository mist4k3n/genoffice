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

Measured on **Linux**, in a container, on both architectures
(`web/tools/bench-container/`). The macOS numbers this section used to carry are
retracted below.

### Cost per resident *document*

24 independent copies of the corpus workbook (0.4 MB, 56k cells), one engine
process, each fully indexed:

```
    #  engine RSS   cumulative Δ   per workbook
    1      26.6MB         22.1MB         22.1MB
    8      62.1MB         57.6MB          7.2MB
   16     101.5MB         96.9MB          6.1MB
   24     139.9MB        135.3MB          5.6MB
```

**~5.6 MB per resident workbook**, linear, on a 4.5 MB baseline. amd64 gives
5.8 MB — the architectures agree.

### Cost per resident *heavy* document

The number #617 actually cares about. A generated 30.9 MB workbook, 450k rows ×
12 columns, **5.4 million cells** (`tools/make-fixture.mjs`), three copies, each
fully indexed:

```
    #  engine RSS   cumulative Δ   per workbook
    1      42.4MB         37.8MB         37.8MB
    2      62.6MB         58.0MB         29.0MB
    3      77.9MB         73.4MB         24.5MB
```

**~25 MB per resident heavy workbook** (amd64: 24.3 MB).

### And it stops growing with the file

| workbook | cells | on disk | per resident copy |
| --- | --- | --- | --- |
| corpus | 56k | 0.4 MB | 5.6 MB |
| generated | 240k | 1.3 MB | 11.7 MB |
| generated | 1.2M | 6.8 MB | 24.9 MB |
| generated | 3.6M | 20.6 MB | 24.7 MB |
| generated | 5.4M | 30.9 MB | 24.5 MB |

Past roughly 7 MB of file the cost is flat: **4.5× the data for the same
25 MB.** That is the streaming reader showing — the engine holds a bounded
working set, not the document. It is the thing LibreOffice fundamentally cannot
do, and it is why the comparison is not close: Collabora is **~145 MB settled,
~280 MB peak** for one heavy `.xlsx`, against ~25 MB here that does not grow
with the workbook.

### Retraction: the macOS measurement was not a measurement

This section previously reported the engine's RSS as **flat across 24 open
documents** — 24 workbooks costing the same ~25 MB as one. That was wrong, and
the way it was wrong is worth keeping.

Re-run on macOS with the same code, engine RSS *falls* as workbooks are added:
28.9 MB at 17 open, 6.8 MB at 18, 24.5 MB at 20, 7.9 MB at 24, and "reclaimed
−3222%" after closing them. A resident set that shrinks when you add documents
is not a result; `ps rss` on macOS reports a compressed, purgeable working set
and cannot answer this question at all. The Linux series is monotonic, smooth,
and reproduces on both architectures.

The retracted claim was flat in the wrong variable. Cost **is** flat in document
*size*, which is the interesting property and is measured above. It was never
flat in document *count*.

### What this means for the ceiling

Against #617's target of 100–200 documents at 8–15 MB each: small documents come
in under it at 5.6 MB, heavy ones sit above it at ~25 MB. On gnexis's 7.6 GB
box, engine memory alone would allow a few hundred heavy documents where
Collabora allowed **~7**. The binding constraint has moved somewhere else.

### The half that is not reclaimed is a free list, not a leak

**The allocator does not give it back.** After closing all three heavy
workbooks the engine sits at ~41 MB against a 4.5 MB baseline — **50%
reclaimed**, and 68–70% for the small ones, on both architectures.

This section previously left that as a worry with a guess attached (glibc arena
retention, `MALLOC_ARENA_MAX` the likely lever). The guess was half right, and
it was pointing at the wrong problem.

Retained RSS is either memory the allocator holds on a free list — reusable, so
a long-lived process never pays for it twice — or memory the engine never
released, which compounds. The two are indistinguishable from outside and have
opposite consequences for sizing a box, so `bench-memory.mjs` now takes
`--reopen N`: open the same workbooks again, N times over, and watch what the
peak does. A leak climbs by the cost of one pass each time; a free list
plateaus.

Four passes of three 30.9 MB workbooks, where a leak would reach ~300 MB:

| glibc tunables | per workbook | reclaimed | resident peak, pass 1 → 4 |
| --- | --- | --- | --- |
| *(none — the default)* | 25.0 MB | 49% | 79 → 83 → 86 → **105 MB** |
| `MALLOC_ARENA_MAX=1` | 23.0 MB | 52% | 75 → 75 → 83 → 81 MB |
| `MALLOC_TRIM_THRESHOLD_=131072` | 22.4 MB | 51% | 76 → 76 → 76 → 75 MB |
| both | **22.2 MB** | 55% | 71 → 72 → 70 → **71 MB** |

So the 50% is a free list. It is reused, the process plateaus, and no
configuration reclaims it — which is the right answer, because handing pages
back to the kernel only to fault them in again on the next open is a cost, not
a saving.

**What the tunables actually fix is drift.** Under the default allocator the
peak grows 32% over four open/close cycles — 79 MB to 105 MB for the same three
documents — and that is the shape that matters for a process that stays up for
weeks. Both tunables together hold it flat at ~71 MB and shave 11% off the
per-workbook cost as well. The run-to-run reproduction is close enough to be
dull: a second default run gave 83 / 86 / 105 against the first's 83 / 86 / 105.

It costs no code. The engine is spawned with an inherited environment, so
setting these on whatever supervises the Node API is enough:

```sh
MALLOC_ARENA_MAX=1
MALLOC_TRIM_THRESHOLD_=131072
```

`MALLOC_MMAP_THRESHOLD_=65536` was tried alongside them and changed nothing —
the large allocations are already going to mmap.

Caveats that remain: one engine process, containers on one laptop, and
per-*connection* cost once Yjs rooms exist is still unmeasured.

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
process, so this is a correctness problem, not tuning.

*Addressed, as far as this side can.* The server could not previously tell a
misrouted call from a dead session — both answered `session_gone` (410), whose
correct client response is to reopen. On two instances that is roughly half of
every session's calls reopening a workbook that is still open.
`SessionDirectory` (`server/ports.ts`) is the port that makes them different:
`claim` on open and on use, `release` on close and eviction, `lookup` on a
miss. The shape is Papan's own `office:bkr:*` broker keys.

A session another instance holds now answers **421 Misdirected Request**, code
`session_elsewhere`, naming the owner. A directory that is down degrades to the
old 410 rather than a 500, because reopening is correct either way — only
expensive.

Three ways to finish it, and the choice is Papan's, not this package's:

1. **`PAPAN_SINGLE_API=1`.** Works today, no directory needed. gnexis already
   measured api-1 at 809 MB across 29 restarts and called it pure cost.
2. **Route by session.** The specified-but-deferred **document-id shard router
   (#603)** is exactly this, and #617 §4 keeps it as engine-agnostic. Find it
   before designing a second one.
3. **`SessionDirectory.forward`.** Supply it and the package proxies the
   misdirected call to the owning instance itself. Addressing stays where the
   addresses are — the instances already reach each other on localhost:3001
   and :3002.

Verified end to end in `tests/affinity.test.ts`: two routers over one
directory, 421 carrying the owner's id and 410 for a session nothing holds,
and with a forwarder supplied the client never learns it was misrouted.

**Sockets are the other half.** `documentChanged` reaches the sockets *this*
instance holds. Two tabs balanced onto two instances is precisely the case our
own save path exists to cover, so `announceChange` hands that broadcast to the
host, which publishes — Redis pub/sub already carries Yjs awareness — and calls
`documentChanged` on every instance. Absent, delivery stays local, which is all
a single-instance host has.

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
