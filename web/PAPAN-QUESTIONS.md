# Briefing for the Papan agent — integrating GenOffice Sheets

You are working in the **Papan** codebase. I am working on a separate repo: a
fork of GenOffice (an Electron office suite) that we are turning into a
**browser-delivered spreadsheet served by a Hono backend**, to replace the
Collabora deployment Papan uses today.

I need to understand Papan properly before designing the integration seams.
This document is a list of questions. Please answer them from the actual code.

## How to answer

- **Cite real code**: `path/to/file.ts:123`, with the relevant signature, type,
  or schema pasted in. I would much rather have 20 lines of a real interface
  than a paragraph describing it.
- **Say "I don't know" or "doesn't exist yet"** where that is the answer. A
  confident wrong answer here costs me a rewrite; a gap costs me one question.
- **Distinguish what is implemented from what is planned.** If something exists
  only in a design doc or a stale branch, say so.
- **Volunteer things I did not ask.** I have flagged why each answer matters.
  If a constraint I clearly have not anticipated exists, tell me — especially
  around auth, tenancy, compliance, or how Collabora is wired today.
- Where Papan has an internal SDK for this (I am told one exists for the
  Collabora↔VFS path), point me at the package and its public surface rather
  than re-describing it.

## What I am building, concretely

The spreadsheet renderer runs in the browser. Everything it used to ask
Electron for now goes over HTTP/WebSocket to a Hono router that I hand to your
app. It is mounted like this, and these three things are what Papan must
supply:

```ts
import { createSheetsRouter } from '@genoffice/sheets-web/server'

const sheets = createSheetsRouter({
  storage,        // read/write the document bytes  → Section A
  identify,       // who is asking, for which doc   → Section C
  secrets,        // passwords for encrypted files  → Section I
})
app.route('/sheets', sheets.app)
```

The storage port I have today looks like this. **The single most useful thing
you can tell me is what in Papan maps onto it, and where it does not fit:**

```ts
type VersionToken = string   // opaque; compared for equality, never ordered

interface StorageAdapter {
  head(documentId: string): Promise<WorkbookMetadata>
  get(documentId: string): Promise<{ bytes: Uint8Array; version: VersionToken; name: string
                                     displayPath?: string }>
  // expectedVersion is the version the editor believed it was editing.
  // A mismatch must reject, not overwrite.
  put(documentId: string, bytes: Uint8Array,
      expectedVersion: VersionToken | null): Promise<WorkbookMetadata>
}
```

A workbook is opened once per session, snapshotted server-side, edited as a
journal of cell edits in the browser, and saved by patching **only the changed
parts** of the .xlsx (we rewrite one `sheet1.xml`, not the whole package — that
is how we keep byte-level fidelity Collabora loses).

---

## Section A — The VFS and how bytes are stored

*Unblocks: the StorageAdapter implementation, and whether my optimistic-
concurrency design survives contact with reality.*

1. What is the **public API of the VFS SDK**? Paste the main interface/types.
   How do I read a file's bytes and write them back, given some identifier?
2. What **identifies a file**? A UUID, a path, a `(workspace, path)` pair,
   something else? Is that identifier stable across renames and moves?
3. Is there a **version / revision / ETag** concept?
   - Does a write produce a new revision, or overwrite in place?
   - Is there **conditional write** support — "write only if the current
     version is X"? This is the crux: my save rejects with `409` plus the
     current version so the client can rebase. If the VFS cannot do a
     compare-and-swap, I need to know now, because the alternative (a lock, or
     last-write-wins) changes the design.
   - Is there version history a user can browse or restore?
4. How are **bytes actually stored** — S3/R2/GCS, a database blob, a local
   filesystem, something layered? Is there a CDN or signed-URL path I should
   use for reads instead of streaming through Hono?
5. **Size limits**, typical and maximum. Are there financial workbooks in the
   tens of MB? Does the SDK stream, or does it hand me a whole Buffer?
6. Is there **server-side encryption at rest**, and are there constraints on
   writing **plaintext to local disk**? My server currently writes a private
   snapshot of each open workbook to a scratch directory, and the Rust engine
   reads it from there. If decrypted financial data must never touch a disk,
   tell me — it is a solvable problem but it changes the engine's protocol.
7. Are there **per-file locks** today (because Collabora holds one), and if so,
   who takes and releases them?
8. What **metadata** does a file carry that the editor should show or preserve —
   display name, folder path, owner, tags, MIME type, custom properties?

## Section B — Save, Save As, and your dialog

*Unblocks: the save pipeline's outer edges. Right now my Save As returns 501,
deliberately, because it means "create a new document" and I have no port for
that. You have your own Save As dialog, so this is where our two systems meet.*

9. Walk me through **what happens today when a user saves in Collabora**. Who
   initiates it, what call reaches Papan, what does Papan do with the bytes?
10. Your **Save As dialog**: where does it live (frontend? which component?),
    what does the user choose (folder, name, format?), and what API does it
    call to create the new file? Paste that API's signature.
    - After a Save As, what is the client expected to do — navigate to the new
      document, keep editing the old one, swap identity in place?
11. Is **autosave** expected? Collabora autosaves on a timer. Does Papan rely on
    that? Should the web spreadsheet save periodically, only on explicit save,
    or both? Is there a "dirty" indicator in your UI that needs to know?
12. **Conflict handling today**: if two users open the same file, or someone
    edits it outside the editor, what does Papan currently do? What *should* it
    do? I can surface a conflict with the current version attached, but I need
    to know what your UI wants to do with it.
13. **Rename**: can a document be renamed while open? The renderer has a
    rename-notification channel that is currently a no-op on the web. Is there
    a rename event I should subscribe to?
14. Does Papan keep an **audit log** of saves, or require one? Does a save need
    to record who, when, and what changed?
15. What happens to a document that a user **abandons with unsaved changes** —
    is there an expectation of crash recovery / draft persistence? (The desktop
    app writes a recovery copy every 30s; I have not wired that up for the web,
    and whether I should depends on your answer.)

## Section C — Identity, permissions, tenancy

*Unblocks: `identify(request) → { userId, tenantId, documentId, canEdit }`, and
the per-tenant quotas I already enforce.*

16. How does the **React frontend authenticate** to the Hono backend? Session
    cookie, bearer JWT, something else? Paste the middleware that establishes
    the caller.
17. How is **per-document permission** resolved? Is there a
    `can(user, 'edit', file)` helper? What are the distinct levels — owner,
    editor, commenter, viewer?
    - Is **read-only** a real state a user can be in? I map it onto the
      workbook's `readOnly` flag, which the renderer honours.
18. Is there a **tenant / workspace / organisation** concept above the user? I
    meter concurrent sessions and resident memory per tenant, and I need to
    know what the right grouping key is.
19. How does **Collabora get its credentials today**? If this is WOPI, I would
    like to see the `CheckFileInfo` / `GetFile` / `PutFile` handlers — they
    encode a lot of decisions I would otherwise have to re-derive.
20. Are there **sharing / public link** flows where the caller is anonymous or
    semi-authenticated?

## Section D — How Collabora is wired today

*Unblocks: knowing what I must match, and what I can drop. This is the section
where I most expect to learn something I did not know to ask about.*

21. How is Collabora **embedded in the frontend** — iframe with postMessage, or
    something else? Paste the message protocol if there is one (the host↔editor
    messages you send and receive).
22. What does the **host application need from the editor** — title changes,
    dirty state, "user clicked our Save button", export requests, presence?
23. How is Collabora **deployed and scaled** — container per tenant, shared
    pool, sticky sessions at the load balancer?
24. You mentioned it **saturates around 10 concurrent clients**. What is the
    actual bottleneck you observed (CPU, memory, per-document processes), and
    what is the **target concurrency** I should design for? A number here
    directly sizes my process pool.
25. What does Collabora currently **do well** that users would notice losing?
    I would rather know now than discover it in a bug report.

## Section E — Embedding the new editor

*Unblocks: how the spreadsheet is delivered into Papan's UI.*

26. Should the spreadsheet be an **iframe** (like Collabora) or a **React
    component mounted in your app**? The renderer is React + a canvas grid; both
    are possible, and they have different auth, theming, and routing
    consequences.
27. How does Papan handle **theming** (light/dark) and **i18n**? The editor has
    its own theme tokens and an 11-language dictionary, and I would rather drive
    them from Papan's state than let them disagree.
28. What **routing** does a document URL have today, and what should it be?
29. Are there **existing UI shells** the editor should sit inside — breadcrumbs,
    a file title bar, a share button, comments?

## Section F — Collaboration and Yjs

*Unblocks: phase 06. The requirement is real-time multi-user editing; I need to
know what already exists so I extend it rather than build a second system.*

30. **Where is Yjs used today**, and for what? Which document types?
31. Is there a **y-websocket (or Hocuspocus, or custom) server**? Where does it
    run, how does it authenticate, how is the Yjs document **persisted**?
32. Is there an **awareness/presence** implementation — cursors, selections,
    user colours — that the spreadsheet should join?
33. How does this interact with Collabora, which does its own collaboration
    internally? Do the two coexist today, or is Yjs for other document types
    only?
34. What are the **expectations for a spreadsheet specifically** — live cell
    edits from multiple users, or something looser like presence plus locking?

## Section G — The AI agent

*Unblocks: phase 04, which is where the MVP ships.*

35. Where does the **AI agent live** (service, package, route), and what model
    provider does it use? Paste the tool-calling setup if there is one.
36. How does it currently **read and write documents**? Does it go through the
    VFS, through Collabora, or does it not touch spreadsheets yet?
37. What does "**full access over the spreadsheet**" mean in Papan's product
    terms — answer questions about the data, edit cells, create sheets, build
    charts, all of it?
38. Is there an existing **tool/function schema** the agent uses that I should
    conform to, rather than inventing a parallel one?
39. Does the agent run **server-side with its own credentials**, or on behalf of
    the signed-in user? This decides whether it goes through the same
    permission checks as a human.

## Section H — Deployment and scale

*Unblocks: a correctness issue I cannot resolve alone. My server pins an open
workbook to a specific engine process, because the parsed workbook lives inside
that process's memory. If Papan runs multiple backend instances behind a load
balancer, a request for an open session must reach the same instance.*

40. How many **backend instances** run in production? Is there **session
    affinity / sticky routing** available at the load balancer, or should I
    assume any request can hit any instance?
41. If there is no affinity, is there a **shared cache (Redis) or a message
    bus** I could use to route by session — or should the editor's document
    sessions be pinned some other way?
42. What is the **runtime** — Node, Bun, containers, serverless? My engine is a
    **native Rust binary** the server spawns as a child process. If any part of
    the backend runs somewhere that cannot spawn processes (edge, serverless),
    that is a hard constraint I need immediately.
43. What are the **memory limits** per instance? Each open workbook holds a
    parsed copy in the engine process.
44. Is there **observability** I should emit into — metrics, tracing, structured
    logging conventions?

## Section I — Security and compliance

*Unblocks: the secrets port, and whether my snapshot-to-disk design is legal for
your data.*

45. Some workbooks are **password-protected** (ECMA-376 encrypted). Where would
    the password come from — prompt the user each time, or does Papan store it?
    If stored, where and under what key management?
46. Are there **compliance constraints** on the document data — residency,
    retention, "must not persist decrypted content", customer-managed keys?
47. What is the **CSP** on the Papan frontend? The spreadsheet needs
    `worker-src blob:` for its canvas workers, and that is the directive most
    likely to be blocked.
48. Are **uploads scanned** (AV, DLP) before storage, and does a save from the
    editor need to pass through the same pipeline?

## Section J — Anything else

49. What do you wish someone had told you before working on this part of Papan?
50. Is there an architecture doc, ADR set, or README I should read in full? If
    so, point me at it rather than summarising — I will read it.

---

## Output I would find most useful

1. Answers in order, each with file references.
2. The **VFS SDK's public interface**, pasted verbatim.
3. The **WOPI (or equivalent) handlers** for Collabora, pasted verbatim.
4. Your **auth middleware**, pasted verbatim.
5. A short list at the end of **"things you assumed that are wrong."** That
   section is worth more to me than the other four combined.
