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
| `apps/sheets/src/shared/ipc-channels.ts` | Server routes key off these constants | Typecheck fails if a constant is renamed; a changed *value* is silent, so diff it |
| `apps/sheets/src/main/sheets-main.ts` | 49 handler behaviors we reimplement in `web/server/` | Silent divergence. The only file here needing human review every rebase |
| `apps/sheets/vite.renderer.config.ts` | `web/vite.config.ts` mirrors its plugin set and root semantics | Build differences between desktop and web |
| `apps/sheets/src/renderer/index.html` | We ship our own with a web CSP | A new upstream CSP directive we do not carry |
| `apps/sheets/src/renderer/main.tsx` | The module our bootstrap imports; reads `window.desktopApi` during its own boot | Boot order assumptions. Re-run the probe if it changes |
| `apps/sheets/src/renderer/env.d.ts` | Declares `window.desktopApi` readonly; we `defineProperty` around it. Also **included in `web/tsconfig.json`** so the globals resolve | Our install shim; typecheck breaks loudly |
| `apps/sheets/src/preload/index.ts` | `web/src/host/coverage.ts` mirrors its channel names verbatim — several are string literals, not `IPC_CHANNELS` constants | A changed literal channel is **silent**: typecheck still passes, the call 404s at runtime. Diff this one every rebase |
| `apps/sheets/tsconfig.json` | `web/tsconfig.json` mirrors its compiler options | Type errors appearing only in one of the two builds |

## Local patches

None. Target: **under five**, per the Tier 2 budget.

| Patch | Reason | Written against | Upstream PR |
| --- | --- | --- | --- |
| _(none yet)_ | | | |

## Open upstream PRs

| Change | Tier | Status | Blocks |
| --- | --- | --- | --- |
| Fix bundled Carlito font path in `cell-font-fallback.ts:169` | 1 | not filed | nothing; fixes a real desktop bug (see `FINDINGS-00.md` §3) |
| Expose a mutation hook / `OpExecutorContext` from the renderer | 1 | not filed | phase 08. **File during phase 07** so it has time to land |
| Sidecar protocol accepting bytes instead of a `PathBuf` | 1 | not filed | phase 05, only if plaintext must never touch disk |

## Rebase runbook

```sh
git fetch upstream
git rebase upstream/main          # must never conflict
cd web && npm run typecheck       # contract drift surfaces here
npm run check:drift               # watched-file diff report
npm run spike                     # smoke: does the shell still render?
```

If the rebase conflicts, something under `apps/` or `packages/` was modified.
Find it and move it into `web/`, an upstream PR, or `web/patches/`.
