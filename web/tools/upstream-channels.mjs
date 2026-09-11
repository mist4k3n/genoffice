/**
 * Upstream channel names, parsed from source rather than retyped.
 *
 * Shared by check-channels.mjs and mock-server.mjs. Retyping was the bug this
 * exists to prevent: the coverage table and the mock server independently
 * spelled out 32 channels that upstream does not use, and because both were
 * wrong in the same way, the app booted and nothing complained.
 *
 * These are .mjs tools and cannot import the .ts constants, so they read them.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const read = (p) => readFileSync(resolve(repoRoot, p), 'utf8')

/** IPC_CHANNELS constant name -> wire value. */
export function loadChannelConstants() {
  const source = read('apps/sheets/src/shared/ipc-channels.ts')
  const start = source.indexOf('export const IPC_CHANNELS')
  if (start < 0) throw new Error('IPC_CHANNELS not found — shared/ipc-channels.ts changed shape')
  const body = source.slice(start, source.indexOf('} as const', start))
  const map = new Map()
  for (const [, name, value] of body.matchAll(/^\s*(\w+):\s*'([^']+)',/gm)) map.set(name, value)
  if (map.size === 0) throw new Error('IPC_CHANNELS parsed empty')
  return map
}

/** DesktopApi method -> every channel the preload uses inside it. */
export function loadPreloadChannels(constants) {
  const source = read('apps/sheets/src/preload/index.ts')
  const start = source.indexOf('const desktopApi: DesktopApi = {')
  const end = source.indexOf("contextBridge.exposeInMainWorld('desktopApi'", start)
  if (start < 0 || end < 0) throw new Error('desktopApi literal not found — preload changed shape')
  const lines = source.slice(start, end).split('\n')

  // Split into method blocks first, then scan each block whole. Scanning line
  // by line misses the common case where prettier wraps a long invoke and the
  // channel argument lands on the next line.
  const blocks = new Map()
  let current = null
  for (const line of lines) {
    // A method starts at exactly two spaces of indent: `  name(`, `  name:`,
    // `  async name(`. Deeper indentation is that method's body.
    const head = /^ {2}(?:async )?(\w+)[(:]/.exec(line)
    if (head) {
      current = head[1]
      if (!blocks.has(current)) blocks.set(current, [])
    }
    if (current) blocks.get(current).push(line)
  }

  const byMethod = new Map()
  for (const [method, blockLines] of blocks) {
    const channels = new Set()
    for (const [, constName, literal] of blockLines
      .join('\n')
      .matchAll(/ipcRenderer\.(?:invoke|on|send)\(\s*(?:IPC_CHANNELS\.(\w+)|'([^']+)')/g)) {
      const channel = constName ? constants.get(constName) : literal
      if (!channel) {
        throw new Error(`IPC_CHANNELS.${constName} used in ${method} but not defined`)
      }
      channels.add(channel)
    }
    byMethod.set(method, channels)
  }
  return byMethod
}
