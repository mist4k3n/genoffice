import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import type { Plugin } from 'vite'

/**
 * Third-party notices for what a build actually bundles.
 *
 * The minifier keeps no license comments -- every bundle this package ships had
 * zero `@license` or `/*!` blocks left in it -- so the notices the bundled
 * libraries' licenses require have to travel as a file instead. MIT, BSD and
 * ISC all require the copyright and permission notice in "all copies or
 * substantial portions"; Apache-2.0 requires the license and any NOTICE.
 *
 * The set is taken from the module graph of the build itself, in
 * `generateBundle`, rather than from `dependencies`: this package bundles
 * upstream's renderer, whose dependencies are declared in another workspace's
 * package.json, and the only list that is guaranteed to be complete is the one
 * the bundler just used.
 *
 * Two things fail the build rather than produce a notice:
 *
 * - a bundled package with no license text on disk, because a notice file
 *   that silently omits one is worse than none -- it reads as complete;
 * - anything from `@univerjs-pro`, which is not open source (PLAN.md,
 *   "Collaboration"). It must never be bundled, and this is where that would
 *   first become visible.
 *
 * Workspace packages (`packages/*`) and upstream's apps are GenOffice code, and
 * are covered by this package's own LICENSE and NOTICE.
 */
export function thirdPartyNotices(options: {
  /** Where the notices land, relative to the build's output directory. */
  readonly fileName: string
  /**
   * The bundled fonts' license, emitted beside them. OFL 1.1 requires the
   * license to accompany the font files themselves.
   */
  readonly fontLicense?: { readonly source: string; readonly fileName: string } | undefined
  /**
   * Checked-in license texts for bundled packages whose npm tarball ships
   * none (`web/licenses/`, one file per package, `@scope/name` written as
   * `scope__name.txt`). Each file names where its text came from. A
   * supplement for a package that *does* ship its own text is an error: it
   * would be stale the moment upstream changed its license.
   */
  readonly supplements?: string | undefined
}): Plugin {
  return {
    name: 'sheets-web:third-party-notices',
    apply: 'build',
    generateBundle(_, bundle) {
      const packages = new Map<string, BundledPackage>()
      let bundlesFonts = false

      for (const output of Object.values(bundle)) {
        if (output.type === 'asset') {
          if (output.fileName.endsWith('.ttf')) bundlesFonts = true
          continue
        }
        for (const id of output.moduleIds) {
          const root = packageRoot(id)
          if (root === null) continue
          const found = readPackage(root)
          if (found === null) continue
          packages.set(`${found.name}@${found.version}`, found)
        }
      }

      const pro = [...packages.values()].filter((p) => p.name.startsWith('@univerjs-pro/'))
      if (pro.length > 0) {
        this.error(
          `bundled ${pro.map((p) => p.name).join(', ')} -- @univerjs-pro is not open source ` +
            'and must not ship (PLAN.md, "Collaboration")',
        )
      }

      const supplementFor = (name: string): string | null => {
        if (!options.supplements) return null
        const file = join(options.supplements, `${name.replace(/^@/, '').replace('/', '__')}.txt`)
        return existsSync(file) ? readFileSync(file, 'utf8') : null
      }
      for (const [key, found] of packages) {
        const supplement = supplementFor(found.name)
        if (supplement !== null && found.licenseText !== null) {
          this.error(
            `${found.name} ships its own license text now; delete its supplement in web/licenses/`,
          )
        }
        if (supplement !== null) packages.set(key, { ...found, licenseText: supplement })
      }

      const unlicensed = [...packages.values()].filter((p) => p.licenseText === null)
      if (unlicensed.length > 0) {
        this.error(
          'no license text on disk for: ' +
            unlicensed.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ') +
            ' -- a notice file that omits a bundled package reads as complete when it is not.' +
            ' Find the text in the package\u2019s repository and add it to web/licenses/.',
        )
      }

      const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
      const body = [
        'Third-party software bundled in this package',
        '='.repeat(44),
        '',
        `${sorted.length} packages, taken from the module graph of the build that produced`,
        'the files beside this one. GenOffice code itself is covered by LICENSE and',
        'NOTICE at the package root.',
        '',
        ...sorted.flatMap((p) => [
          '-'.repeat(78),
          `${p.name}@${p.version} -- ${p.license}`,
          '-'.repeat(78),
          '',
          (p.licenseText ?? '').trim(),
          ...(p.noticeText === null ? [] : ['', p.noticeText.trim()]),
          '',
        ]),
      ].join('\n')

      this.emitFile({ type: 'asset', fileName: options.fileName, source: body })

      if (bundlesFonts && options.fontLicense) {
        this.emitFile({
          type: 'asset',
          fileName: options.fontLicense.fileName,
          source: readFileSync(options.fontLicense.source, 'utf8'),
        })
      }
    },
  }
}

interface BundledPackage {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly licenseText: string | null
  readonly noticeText: string | null
}

/**
 * The package directory a bundled module lives in, or null for a module that
 * is not from node_modules. The *last* `node_modules` segment wins, so a
 * nested copy is attributed to itself rather than to its parent.
 */
function packageRoot(id: string): string | null {
  const clean = id.replace(/^\0/, '').split('?')[0] ?? ''
  const marker = `${sep}node_modules${sep}`
  const at = clean.lastIndexOf(marker)
  if (at === -1) return null
  const rest = clean.slice(at + marker.length).split(sep)
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  if (rest.length <= depth) return null
  return clean.slice(0, at + marker.length) + rest.slice(0, depth).join(sep)
}

const cache = new Map<string, BundledPackage | null>()

function readPackage(root: string): BundledPackage | null {
  if (cache.has(root)) return cache.get(root) ?? null
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) {
    cache.set(root, null)
    return null
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string
    version?: string
    license?: string | { type?: string }
  }
  const files = readdirSync(root)
  const textOf = (pattern: RegExp): string | null => {
    const match = files.find((file) => pattern.test(file))
    return match === undefined ? null : readFileSync(join(root, match), 'utf8')
  }
  const found: BundledPackage = {
    name: manifest.name ?? root,
    version: manifest.version ?? '0.0.0',
    license:
      typeof manifest.license === 'string'
        ? manifest.license
        : (manifest.license?.type ?? 'UNKNOWN'),
    licenseText: textOf(/^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i),
    noticeText: textOf(/^notice(\.(md|txt))?$/i),
  }
  cache.set(root, found)
  return found
}
