# Phase 01 — `web/` scaffold and HTTP host

Status: **gate met.** The upstream Sheets renderer runs in Chrome against an
HTTP host, boots entirely through it, and receives live pushes over a WebSocket.
No upstream file was modified.

```sh
cd web
npm run mock     # terminal 1 — mock host on :5274
npm run dev      # terminal 2 — app on :5273
```

## What was built

| File | Role |
| --- | --- |
| `src/host/transport.ts` | `invoke` over HTTP POST, `subscribe` over one multiplexed WebSocket. Mirrors the only two primitives the preload exposes |
| `src/host/coverage.ts` | Status + channel for all 59 methods. **The drift detector** |
| `src/host/desktop-api.ts` | Builds a `DesktopApi` from the coverage table; one cast at the boundary |
| `src/bootstrap.ts` | Installs the host, then dynamically imports upstream `main.tsx` |
| `src/index.html` | Web CSP replacing upstream's Electron-shaped one |
| `tools/mock-server.mjs` | Dependency-free mock host: 10 channels + push endpoint |
| `tsconfig.json` | Mirrors `apps/sheets/tsconfig.json`; includes upstream `env.d.ts` |

Coverage as it stands: **10 invoke, 4 push, 5 shell no-op, 40 not yet
implemented** — and the app reports *no unimplemented method reached* during
boot, so the boot surface is fully served.

## The drift detector works, and was tested in both directions

`COVERAGE` is typed `Record<keyof DesktopApi, Entry>`. Two negative tests,
both run against the real contract:

Upstream **adds** a method (simulated by deleting an entry):

```
src/host/coverage.ts(35,14): error TS2741: Property 'getTheme' is missing in
type '{ … }' but required in type 'Record<keyof DesktopApi, Entry>'.
```

Upstream **removes** one (simulated by adding an unknown entry):

```
src/host/coverage.ts(40,3): error TS2353: Object literal may only specify known
properties, and 'aNewUpstreamMethod' does not exist in type
'Record<keyof DesktopApi, Entry>'.
```

Both name the exact method. This is the mechanism `PLAN.md` claimed; it is now
demonstrated rather than asserted.

## The whole upstream renderer typechecks clean under the web config

`npx tsc --noEmit` over `web/` pulls in the entire renderer through the
bootstrap import — roughly 98k lines — and reports **0 errors** with
`strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` all on.

That is a stronger compatibility result than the phase-00 spike gave: the
renderer is not merely loadable in a browser, it type-checks against a
browser-targeted config.

One consequence worth knowing: `exactOptionalPropertyTypes` (mirrored from
upstream) means optional properties in our own option types must be declared
`?: T | undefined`, not `?: T`, or callers cannot pass an explicit `undefined`.

## Push path verified end to end

Typing `light` at the mock server pushed `app:theme-changed`, and the renderer
applied it:

```
[mock] pushed app:theme-changed light to 2 client(s)
→ document.documentElement.getAttribute('data-theme') === 'light'
```

Chain: mock stdin → WebSocket frame → transport demultiplexer →
`onThemeChanged` subscription → upstream's own `applyTheme`. Nothing in the
renderer knows it is not Electron.

## Decisions taken (PLAN.md asked for these explicitly)

**The five shell relays are permanent no-ops for now**, not stubs-by-accident:
`onMenuAction`, `onCloseSaveRequest`, `onWorkbookRenamed`, `onRecoveryPrompt`,
`onChromePressed`. They relay events from the Electron *tab host*, which has no
web counterpart. Upstream's own standalone renderer mode runs the same way.
Each carries a `note` in `COVERAGE` naming the web equivalent to repoint it at
later (browser menu, `beforeunload`, rename UI, phase-02 crash recovery).

**Subscriptions return their unsubscribe synchronously.** Eight of the
seventeen boot methods are subscriptions; a promise-returning stub breaks boot
immediately. Both `push` and `shell` statuses return a function, never a
promise.

**One socket, multiplexed by channel name**, with local subscription
registration and bounded reconnect backoff. Subscriptions are not announced to
the server: the channel set is small and fixed, and a renderer that subscribes
late must not miss a channel already being pushed.

## Risks carried forward

- **Channel names are mirrored, not imported.** Several are string literals in
  upstream's preload rather than `IPC_CHANNELS` constants, so a renamed literal
  passes typecheck and 404s at runtime. `apps/sheets/src/preload/index.ts` is now
  on the `DRIFT.md` watch list for exactly this.
- **The dev CSP is not the production CSP.** It carries `'unsafe-inline'` and
  `'unsafe-eval'` for Vite HMR. Production must drop both, pin the API origin,
  and be re-verified — `worker-src blob:` is the directive most likely to break
  Univer's canvas workers.
- **Scroll latency is still untested.** No range streaming exists yet; this
  remains the phase-03 risk called out in `PLAN.md`.
- The Carlito font bug (`FINDINGS-00.md` §3) still shows in the console. It is a
  pending upstream PR, deliberately not patched locally.

## Next

Phase 02 — the Hono server kernel: sidecar pool, `StorageAdapter` port, session
lifecycle, and the 40 remaining channels, starting with open / read-range /
close.
