import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { COVERAGE } from '../src/host/coverage'

/**
 * Papan has its own assistant, so the app's own AI surface is switched off when
 * embedded (`ai={false}`, the default here). The risk is not that the flag
 * stops working -- it is that a rebase brings a *new* AI entry point that
 * nobody thought to put behind it, leaving a button in the ribbon that opens a
 * panel which is not mounted, or fires a channel the router answers with 501.
 *
 * So these tests read upstream's source and check that every AI reference in
 * the shell sits inside an `aiEnabled` guard.
 */

const SHELL = new URL('../../apps/sheets/src/renderer/ExcelShell.tsx', import.meta.url)
const shell = readFileSync(SHELL, 'utf8')

/**
 * The byte ranges of `{aiEnabled …}` JSX expressions.
 *
 * Brace-matching over TSX needs to know when a brace is code and when it is
 * text, so this skips strings, template literals and comments. It is a
 * scanner, not a parser: it never has to understand the syntax, only to find
 * the brace that closes a known-open one.
 */
function guardedRanges(source: string): readonly (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = []
  for (
    let start = source.indexOf('{aiEnabled');
    start >= 0;
    start = source.indexOf('{aiEnabled', start + 1)
  ) {
    // A stack, because a template literal can hold `${…}` which is code again,
    // which can hold another template. Braces count only in code.
    const modes: ('code' | 'template')[] = ['code']
    const interpolationAt: number[] = []
    let depth = 0

    for (let index = start; index < source.length; index += 1) {
      const c = source[index]
      const next = source[index + 1]

      if (modes[modes.length - 1] === 'template') {
        if (c === '\\') index += 1
        else if (c === '`') modes.pop()
        else if (c === '$' && next === '{') {
          modes.push('code')
          interpolationAt.push(depth)
          index += 1
        }
        continue
      }

      if (c === '/' && next === '/') {
        const nl = source.indexOf('\n', index)
        if (nl < 0) break
        index = nl
        continue
      }
      if (c === '/' && next === '*') {
        index = source.indexOf('*/', index) + 1
        continue
      }
      if (c === '`') {
        modes.push('template')
        continue
      }
      if (c === "'" || c === '"') {
        for (index += 1; index < source.length; index += 1) {
          if (source[index] === '\\') index += 1
          else if (source[index] === c) break
        }
        continue
      }
      if (c === '{') depth += 1
      else if (c === '}') {
        // Closing an interpolation returns to the template it interrupted; it
        // is not one of the braces this range is balancing.
        if (modes.length > 1 && interpolationAt[interpolationAt.length - 1] === depth) {
          interpolationAt.pop()
          modes.pop()
          continue
        }
        depth -= 1
        if (depth === 0) {
          ranges.push([start, index])
          break
        }
      }
    }
  }
  return ranges
}

/** Every AI entry point the shell can render. A new one here is the point. */
const AI_MARKERS = [
  '<AiChatPanel',
  '<AiSelectionAsk',
  'onAiRun(',
  "t('appGroupAiAssistant')",
  "t('appGroupLanguage')", // Translate is an AI prompt behind a ribbon button.
]

test('every AI entry point in the shell is behind the aiEnabled guard', () => {
  const ranges = guardedRanges(shell)
  assert.ok(ranges.length >= 4, `expected several aiEnabled guards, found ${ranges.length}`)
  const guarded = (at: number): boolean => ranges.some(([from, to]) => at > from && at < to)

  for (const marker of AI_MARKERS) {
    const found: number[] = []
    for (let at = shell.indexOf(marker); at >= 0; at = shell.indexOf(marker, at + 1)) found.push(at)
    assert.ok(found.length > 0, `${marker} is gone from ExcelShell — update AI_MARKERS`)
    for (const at of found) {
      const line = shell.slice(0, at).split('\n').length
      assert.ok(guarded(at), `${marker} at ExcelShell.tsx:${line} is not behind aiEnabled`)
    }
  }
})

test('the commands that open the panel respect the flag too', () => {
  // A keyboard route or a host command must not open a panel that is not
  // mounted: the class would collapse the grid's column for nothing.
  for (const command of ['ai-open-panel', 'ai-toggle-panel']) {
    const at = shell.indexOf(`command === '${command}'`)
    assert.ok(at > 0, `${command} is gone — check whether the flag still covers it`)
    const statement = shell.slice(at, shell.indexOf('\n', at))
    assert.match(statement, /aiEnabled/, `${command} does not consult aiEnabled`)
  }
})

test('the panel would have nothing to talk to, which is why off is the default', () => {
  // The justification in UPSTREAM-CHANGES.md is that these are unserved. If
  // someone implements them, this fails and the default is worth revisiting.
  const unserved = [
    'aiStream',
    'aiStreamCancel',
    'onAiStream',
    'aiChat',
    'setAiSettings',
    'aiGskLogin',
  ] as const
  for (const method of unserved) {
    assert.equal(
      COVERAGE[method].status,
      'todo',
      `${method} is now served — revisit the ai={false} default`,
    )
  }
})

test('off is the default in the browser, on is the default upstream', () => {
  const embed = readFileSync(new URL('../src/embed/SheetsEditor.tsx', import.meta.url), 'utf8')
  assert.match(embed, /ai = false,/, 'the embedded editor must default to no AI panel')

  const app = readFileSync(new URL('../../apps/sheets/src/renderer/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /ai = true/, 'the desktop app must be unchanged by default')
})
