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
  /**
   * Where the pages are served from.
   *
   * Relative by default, because the answer is a deployment's and not this
   * repository's: `./` makes every asset URL resolve against the directory the
   * page itself was served from, so the same build works at the site root, at
   * `/sheets/`, or behind a CDN prefix nobody told us about
   * (PAPAN-INTEGRATION.md, A2). A host that needs an absolute prefix -- assets
   * on a different origin from the pages, say -- sets `SHEETS_WEB_BASE` at
   * build time and gets exactly that.
   */
  base: process.env.SHEETS_WEB_BASE || './',
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
      output: {
        /**
         * The font faces go in `assets/fonts/`, unhashed, because upstream's
         * canvas font fallback builds two of these URLs itself -- `new
         * URL('./fonts/Carlito-Regular.ttf', import.meta.url)` in
         * `cell-font-fallback.ts`, resolved at runtime against the chunk that
         * asked. Chunks live in `assets/`, so this is where that URL points.
         * They feed the width-corrected aliases for Dosis and Aptos Narrow,
         * and Aptos Narrow is what Excel 365 gives a new workbook.
         *
         * A literal path cannot carry a content hash. These four files are
         * immutable, and the stylesheet that also references them is hashed.
         */
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.ttf'))
            ? 'assets/fonts/[name][extname]'
            : 'assets/[name]-[hash][extname]',
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
