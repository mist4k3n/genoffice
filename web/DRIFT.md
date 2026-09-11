# Drift watch list

Upstream files this fork **mirrors but never modifies**. They rebase cleanly by
definition — the job here is to notice when their behavior changes, because our
code has to follow.

See `PLAN.md` → "Drift management" for the escalation tiers and the rebase
runbook.

Baseline upstream SHA: `d2b898f`

## Watched files

| File | Why we watch it | What breaks if it changes |
| --- | --- | --- |
| `apps/sheets/src/shared/desktop-api.ts` | The contract our host implements | Nothing silently — `web/` typecheck fails with the exact method. **This is the good case.** |
| `apps/sheets/src/shared/ipc-channels.ts` | `web/src/host/coverage.ts` **imports** these; server routes key off the same constants | A renamed constant fails typecheck. A changed *value* follows automatically, which is why we import rather than retype |
| `apps/sheets/src/main/sheets-main.ts` | 49 handler behaviors we reimplement in `web/server/` | Silent divergence. The only file here needing human review every rebase |
| `apps/sheets/src/main/xlsx-sidecar-client.ts` | **Imported unmodified** by `web/server/sidecar/pool.ts`. Pure node, no Electron — that is what makes the pool possible | A new Electron import breaks the server build loudly. A change to crash behaviour breaks the pool's pid watching *silently* |
| `apps/sheets/src/shared/desktop-api.ts` (schemas) | The server validates with upstream's own zod schemas | A tightened constraint arrives on rebase, which is the point. A *renamed* schema fails typecheck |
| `apps/sheets/vite.renderer.config.ts` | `web/vite.config.ts` mirrors its plugin set and root semantics | Build differences between desktop and web |
| `apps/sheets/src/renderer/index.html` | We ship our own with a web CSP | A new upstream CSP directive we do not carry |
| `apps/sheets/src/renderer/main.tsx` | The module our bootstrap imports; reads `window.desktopApi` during its own boot | Boot order assumptions. Re-run the probe if it changes |
| `apps/sheets/src/renderer/cell-function.ts` | Parses the workbook `path` structurally (`lastIndexOf('/')`) to build `CELL("filename")`. `web/server/workbook-handle.ts` issues a path-shaped token because of it | A different split rule would silently change what `CELL("filename")` returns |
| `apps/sheets/src/renderer/univer-sync.ts` | `SIDECAR_READ_BATCH_CELLS` (90,000) decides how many HTTP requests a viewport costs; `web/tools/bench-range.mjs` mirrors it | A much smaller batch would multiply round trips per scroll — the phase-03 risk returning |
| `apps/sheets/src/renderer/env.d.ts` | Declares `window.desktopApi` readonly; we `defineProperty` around it. Also **included in `web/tsconfig.json`** so the globals resolve | Our install shim; typecheck breaks loudly |
| `apps/sheets/src/preload/index.ts` | The authority on which channel each method uses. `npm run check:channels` parses it and diffs against `coverage.ts` | A renamed **literal** channel (`app:*`, `sheets:consume-new-blank`, `sheets:has-queued-workbook`, `ai:web-search`) is invisible to the compiler. `check:channels` is what catches it |
| `apps/sheets/tsconfig.json` | `web/tsconfig.json` mirrors its compiler options | Type errors appearing only in one of the two builds |

## Local patches

None — no upstream file is modified.

| Patch | Reason | Written against | Upstream PR |
| --- | --- | --- | --- |
| _(none)_ | | | |

## Mirrored implementations

Upstream code **copied** into `web/`, rather than imported. One, against a
Tier 2 budget of five. Guarded by `npm run check:mirror`, which hashes the
upstream original and fails when it changes.

| Copy | Upstream source | Why it cannot be imported |
| --- | --- | --- |
| `web/server/channels/save-plan.ts` | `writeWorkbookTo`, `apps/sheets/src/main/sheets-main.ts` (259 lines) | Pure function, but module-local in a file that imports `electron`. An upstream PR exporting it deletes the copy |

## Open upstream PRs

| Change | Tier | Status | Blocks |
| --- | --- | --- | --- |
| Fix bundled Carlito font path in `cell-font-fallback.ts:169` | 1 | not filed | nothing; fixes a real desktop bug (see `FINDINGS-00.md` §3) |
| Expose a mutation hook / `OpExecutorContext` from the renderer | 1 | not filed | phase 08. **File during phase 07** so it has time to land |
| Sidecar protocol accepting bytes instead of a `PathBuf` | 1 | not filed | phase 05, only if plaintext must never touch disk |
| `onExit` callback on `XlsxSidecarClient` | 1 | not filed | nothing. Would delete the pid-polling in `web/server/sidecar/pool.ts` — see `FINDINGS-02.md` |
| Export `writeWorkbookTo` from `sheets-main.ts` | 1 | not filed | nothing. Would delete `web/server/channels/save-plan.ts`, the fork's only mirrored implementation |

## Rebase runbook

```sh
git fetch upstream
git rebase upstream/main          # must never conflict
cd web && npm run typecheck       # method-level contract drift surfaces here
npm run check:channels            # channel-level drift the compiler cannot see
npm run check:server              # server purity + coverage agreement
npm run check:mirror              # mirrored implementations still match upstream
npm run check:drift               # watched-file diff report
npm run spike                     # smoke: does the shell still render?
```

If the rebase conflicts, something under `apps/` or `packages/` was modified.
Find it and move it into `web/`, an upstream PR, or `web/patches/`.
