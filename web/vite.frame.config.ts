import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * The frame page, built into the package.
 *
 * `isolate` mounts an iframe and speaks `frame-protocol.ts` to the copy of the
 * editor inside it, which is how two grids can be visible at once (a compare
 * view; Univer's internal editor hosts carry fixed element ids and collide in
 * one realm). That iframe needs a page, and the page needs a bundle
 * (PAPAN-INTEGRATION.md, A3).
 *
 * It ships in `dist/frame/` rather than being left to the host to build, for
 * one reason that matters more than convenience: the page and the component
 * speak a versioned protocol to each other. Shipping them together means a
 * host cannot deploy a frame page from one version beside a component from
 * another and discover it through a compare view that never loads.
 *
 * It is a second copy of the editor, and that is inherent -- a second realm
 * cannot share the first one's module instances. Hence `isolate` stays opt-in
 * and documented as costing a second bundle.
 *
 * Two differences from the library build:
 *
 * - **React is bundled.** This is a page, not a module a host imports. There
 *   is nobody to provide it.
 * - **It is an HTML build, not a lib build**, so `src/sheets-frame.html` is the
 *   entry and Vite emits the page with its script and stylesheet references
 *   already rewritten.
 */
export default defineConfig({
  root: resolve(here, 'src'),
  // Relative, for the same reason the pages are (A2): the host serves this
  // from wherever it serves the package, and `frameSrc` points at it there.
  base: './',
  build: {
    outDir: resolve(here, 'dist/frame'),
    // Outside the Vite root, so Vite asks before clearing it unless told.
    emptyOutDir: true,
    target: 'es2022',
    // No sourcemap, unlike the library build. This page runs the same sources
    // from the same repository, and its maps are 40 MB of a package a host
    // installs -- half the published weight for a second copy of what
    // `dist/sheets-web.js.map` already describes.
    sourcemap: false,
    rollupOptions: {
      input: { 'sheets-frame': resolve(here, 'src/sheets-frame.html') },
      output: {
        // `assets/fonts/`, unhashed, for the reason in vite.config.ts: the
        // canvas font fallback builds two of these URLs at runtime, relative
        // to the chunk that asked, and the chunks are in `assets/`.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.ttf'))
            ? 'assets/fonts/[name][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
})
