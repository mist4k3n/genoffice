import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * Phase-00 spike server: serves upstream's Sheets renderer, unmodified, in a
 * plain browser.
 *
 * Mirrors apps/sheets/vite.renderer.config.ts (which is only `root` plus
 * @vitejs/plugin-react) except that the root is web/src, so the entry can
 * install a host bridge on `window` before upstream's main.tsx is evaluated.
 *
 * Nothing under apps/ or packages/ is read for configuration — only imported.
 * Keep it that way: see PLAN.md, "The governing invariant".
 */
export default defineConfig({
  root: resolve(here, 'src'),
  // Three entries: the standalone app, the host harness that mounts the editor
  // as a component the way an embedding application would, and the page an
  // isolated editor runs inside (see src/embed/IsolatedSheets.tsx).
  build: {
    rollupOptions: {
      input: {
        index: resolve(here, 'src/index.html'),
        harness: resolve(here, 'src/harness.html'),
        'sheets-frame': resolve(here, 'src/sheets-frame.html'),
      },
    },
  },
  plugins: [react()],
  server: {
    port: Number(process.env.SHEETS_WEB_PORT) || 5273,
    strictPort: true,
    fs: {
      // The module graph deliberately reaches outside the Vite root into
      // apps/sheets/src/renderer and packages/*/src. Both are inside the repo.
      allow: [repoRoot],
    },
  },
  resolve: {
    // One React instance. Workspace packages are symlinks into packages/*,
    // so without this both the renderer and @genoffice/ui can resolve their
    // own copy and hooks break at runtime with a confusing error.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    // Workspace packages export raw .ts through their exports map; esbuild
    // pre-bundling them as if they were published CJS breaks the CSS subpaths.
    exclude: ['@genoffice/ui', '@genoffice/i18n', '@genoffice/agent-core'],
  },
})
