/**
 * Minimal Node client for the Rust xlsx-sidecar, speaking its newline-delimited
 * JSON stdio protocol directly.
 *
 * This is deliberately a fresh implementation rather than an import of
 * apps/sheets/src/main/xlsx-sidecar-client.ts: that module is Electron-shaped
 * (it reports through dialogs and app paths). The wire protocol is the stable
 * part, and it is versioned — PROTOCOL_VERSION is asserted on every request, so
 * an upstream bump fails loudly here.
 *
 * Phase 02 grows this into the pooled server-side client.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export const PROTOCOL_VERSION = 1

export class SidecarError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'SidecarError'
    this.code = code
  }
}

export class Sidecar {
  #child
  #pending = new Map()
  #seq = 0
  #exited = null

  constructor(binaryPath) {
    this.#child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => {
      if (process.env.SIDECAR_DEBUG) process.stderr.write(`[sidecar] ${chunk}`)
    })

    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        process.stderr.write(`[sidecar] unparseable line: ${line.slice(0, 200)}\n`)
        return
      }
      const entry = this.#pending.get(message.requestId)
      if (!entry) return
      this.#pending.delete(message.requestId)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new SidecarError(message.error?.code ?? 'unknown', message.error?.message ?? ''))
    })

    this.#exited = new Promise((resolve) => {
      this.#child.on('exit', (code, signal) => {
        for (const [, entry] of this.#pending) {
          entry.reject(new SidecarError('exited', `sidecar exited (code ${code}, signal ${signal})`))
        }
        this.#pending.clear()
        resolve({ code, signal })
      })
    })
  }

  send(command, payload = {}) {
    const requestId = `r${this.#seq++}`
    const request = { version: PROTOCOL_VERSION, requestId, command, ...payload }
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
      this.#child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  open(path, locale = 'en') {
    return this.send('open', { path, locale })
  }

  readRange(sessionId, sheetId, range) {
    return this.send('read_range', { sessionId, sheetId, range })
  }

  readFormulaCells(sessionId, sheetId) {
    return this.send('read_formula_cells', { sessionId, sheetId })
  }

  recalcCells(path, edits, reads) {
    return this.send('recalc_cells', { path, edits, reads })
  }

  close(sessionId) {
    return this.send('close', { sessionId })
  }

  async dispose() {
    this.#child.stdin.end()
    this.#child.kill()
    return this.#exited
  }
}
