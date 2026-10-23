import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { thirdPartyNotices } from './tools/license-notices'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * The library build: the editor as something a host application can import.
 *
 * `vite.config.ts` builds three HTML pages and is what `npm run dev` serves.
 * This builds one ES module from `src/embed/index.ts` instead, because Papan
 * mounts `<SheetsEditor>` inside its own React tree and there is otherwise
 * nothing to import (PAPAN-INTEGRATION.md, A1).
 *
 * Two things are deliberately different from the page build.
 *
 * **React is external.** The host owns it -- its own copy, its own root, its
 * own reconciler. Bundling a second one is the hooks error that `dedupe`
 * exists to prevent, arriving from the other direction. Everything else
 * (Univer, the renderer, the workspace packages) is bundled: a host should not
 * have to install this repository's dependency tree to render a spreadsheet.
 *
 * **Asset URLs are relative.** `base: './'` makes the stylesheet reference the
 * font faces as `./Carlito-Regular.ttf`, so the bundle resolves wherever it is
 * served from and whatever the host's bundler does with our CSS. That is the
 * library half of the `base` question in A2; the page build's absolute
 * `/assets/...` is the other half and is unaffected by this file.
 */

/**
 * Keep the bundled font faces as files.
 *
 * Library mode inlines every asset unconditionally -- `assetsInlineLimit` is
 * not consulted, and neither is its callback form -- which turned the four
 * Carlito faces into 11 MB of base64 inside one stylesheet that every host
 * page then downloads whole. `?no-inline` is the one switch Vite checks first,
 * so this appends it to the font URLs in upstream's CSS as they are read.
 *
 * The faces matter: Carlito is metric-compatible with Calibri and the canvas
 * measures text against it. They are still shipped -- emitted next to the
 * stylesheet, and fetched by the browser only when a face is actually used.
 *
 * JavaScript imports of the same files (`?url`) get the same treatment, so the
 * stylesheet and the canvas fallback point at one emitted file each rather than
 * one file and one base64 copy. `npm run check:weight` fails if a font is ever
 * inlined into the editor chunk again.
 */
function fontsAsFiles(): Plugin {
  return {
    name: 'sheets-web:fonts-as-files',
    enforce: 'pre',
    transform(code, id) {
      if (!code.includes('.ttf')) return null
      if (id.endsWith('.css')) {
        return { code: code.replace(/(\.ttf)(['")])/g, '$1?no-inline$2'), map: null }
      }
      // The same faces imported from JavaScript, as upstream's canvas font
      // fallback has done since 2026-10 (`Carlito-Regular.ttf?url`). Library
      // mode inlines those too: 1.7 MB of base64 in the editor chunk,
      // duplicating the files the stylesheet already loads.
      if (/\.[cm]?[jt]sx?$/.test(id.split('?')[0] ?? '')) {
        const next = code.replace(/(\.ttf\?url)(['"`])/g, '$1&no-inline$2')
        return next === code ? null : { code: next, map: null }
      }
      return null
    },
  }
}

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: resolve(here, 'src/embed/index.ts'),
      formats: ['es'],
      fileName: 'sheets-web',
      // Without this the stylesheet is `style.css`, which says nothing about
      // where it came from once it is sitting in a host's asset directory.
      cssFileName: 'sheets-web',
    },
    rollupOptions: {
      // Every React entry point, by pattern rather than by list. The list used
      // to name five and missed `react-dom/server`, which upstream's
      // IconsDialog imports: rolldown inlined its CommonJS build, that build
      // `require`s react and react-dom, those are external, and the editor
      // crashed on mount in a host with "Calling `require` for \"react\"".
      // Found by Papan; `npm run check:host` mounts the editor in a host now.
      external: (id) => /^react(-dom)?(\/.*)?$/.test(id),
      output: {
        // Univer's locales and anything else behind a dynamic import stay
        // separate chunks, so a host can lazy-route the editor (A4).
        chunkFileNames: 'chunks/[name]-[hash].js',
        // Fonts in `fonts/`, unhashed, so the faces have a stable, documented
        // place in the package (and the OFL text beside them). This once also
        // served a runtime-built `new URL('./fonts/…')` in upstream's canvas
        // font fallback; upstream replaced that with a `?url` import in
        // 2026-10, which the bundler resolves. The stylesheet's own `url()`s
        // are rewritten relative to the directory this function reports for
        // the CSS, which is why the CSS branch must stay at the output root.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.ttf'))
            ? 'fonts/[name][extname]'
            : '[name][extname]',
      },
    },
  },
  plugins: [
    fontsAsFiles(),
    react(),
    thirdPartyNotices({
      fileName: 'THIRD-PARTY-NOTICES.txt',
      supplements: resolve(here, 'licenses'),
      fontLicense: {
        source: resolve(repoRoot, 'apps/docs/src/renderer/fonts/LICENSE-OFL.txt'),
        fileName: 'fonts/LICENSE-OFL.txt',
      },
    }),
  ],
  resolve: {
    // Same reason as the page build: one React instance. Workspace packages
    // are symlinks, and without this both the renderer and @genoffice/ui can
    // resolve their own copy.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
})
