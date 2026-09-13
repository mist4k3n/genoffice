import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveTheme, type HostTheme } from '../src/embed/theme'
import { createHostSettingsBus, HOST_SOURCED_PUSH } from '../src/host/settings'
import { COVERAGE } from '../src/host/coverage'
import { htmlLang, normalizeLang } from '../../packages/i18n/src/index'
import { DEFAULT_PREFERENCES } from '../server/ports'

/**
 * Two things a host page decides and a server cannot: what it looks like and
 * what language it speaks. Both arrive as props, and both used to stop at the
 * chrome -- the renderer kept whatever it booted with.
 */

test('every theme a host can send resolves to something paintable', () => {
  const cases: [HostTheme, boolean, 'light' | 'dark'][] = [
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    // Papan's third option. No upstream palette, so it is dark rather than a
    // set of colours invented here.
    ['dim', false, 'dark'],
    ['dim', true, 'dark'],
    // The one that cannot be expressed as a scoped attribute at all.
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ]
  for (const [theme, prefersDark, expected] of cases) {
    assert.equal(resolveTheme(theme, prefersDark), expected, `${theme} @ prefersDark=${prefersDark}`)
  }
})

test("Papan's four locales all map onto a real dictionary", () => {
  // The claim in FINDINGS-EMBED.md was that upstream had eleven languages with
  // different codes and the mapping was unwritten. Upstream has twenty, and
  // wrote the mapping. All four land without inventing anything.
  assert.equal(normalizeLang('en'), 'en')
  assert.equal(normalizeLang('zh-CN'), 'zh')
  assert.equal(normalizeLang('zh-TW'), 'zh-TW')
  assert.equal(normalizeLang('ms'), 'ms')
  // And the shapes a browser actually sends.
  assert.equal(normalizeLang('en-GB'), 'en')
  assert.equal(normalizeLang('ms-MY'), 'ms')
  assert.equal(normalizeLang('zh-Hant-HK'), 'zh-TW')
  // An unknown tag renders English, not raw dictionary keys.
  assert.equal(normalizeLang('kl-GL'), 'en')
  assert.equal(normalizeLang(undefined), 'en')
})

test('the default preference is a language upstream can actually serve', () => {
  assert.equal(normalizeLang(DEFAULT_PREFERENCES.language), DEFAULT_PREFERENCES.language)
  assert.equal(htmlLang(DEFAULT_PREFERENCES.language), 'en-US')
})

test('the settings bus notifies on change and only on change', () => {
  const bus = createHostSettingsBus({ theme: 'light', language: 'en' })
  const themes: string[] = []
  const languages: string[] = []
  const off = bus.subscribe('theme', (value) => void themes.push(value))
  bus.subscribe('language', (value) => void languages.push(value))

  // A host re-render passes the same props again. Retranslating and
  // repainting the canvas on every render is the bug this guards.
  bus.publish({ theme: 'light', language: 'en' })
  assert.deepEqual(themes, [])
  assert.deepEqual(languages, [])

  bus.publish({ theme: 'dark' })
  assert.deepEqual(themes, ['dark'])
  assert.deepEqual(languages, [], 'a theme change is not a language change')
  assert.equal(bus.current('theme'), 'dark')

  bus.publish({ theme: 'dark', language: 'ms' })
  assert.deepEqual(themes, ['dark'])
  assert.deepEqual(languages, ['ms'])

  off()
  bus.publish({ theme: 'light' })
  assert.deepEqual(themes, ['dark'], 'unsubscribed')
  assert.equal(bus.current('theme'), 'light', 'still current, just unheard')
})

test('the host-sourced channels are real subscriptions on the bridge', () => {
  // The bus only reaches the renderer if these names still exist and are still
  // push subscriptions. Renamed upstream, this fails here rather than going
  // quiet in the browser.
  for (const [method, key] of Object.entries(HOST_SOURCED_PUSH)) {
    const entry = COVERAGE[method as keyof typeof COVERAGE]
    assert.ok(entry, `${method} is not a DesktopApi method`)
    assert.equal(entry.status, 'push', `${method} must stay a subscription`)
    assert.ok(key === 'theme' || key === 'language')
  }
  assert.deepEqual(Object.keys(HOST_SOURCED_PUSH), ['onThemeChanged', 'onLanguageChanged'])
})
