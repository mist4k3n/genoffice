#!/usr/bin/env node
/**
 * Phase-05: decrypt a real ECMA-376 encrypted workbook and verify the
 * round-trip, using the same library upstream uses for Docs.
 *
 * Reports the encryption scheme from the EncryptionInfo descriptor, decrypts
 * with the supplied password, checks the payload is a valid OOXML zip, then
 * re-encrypts and decrypts again to prove a save path is viable.
 *
 * Run: npm run decrypt -- ./fixtures/TestLocked.xlsx --password 'secret'
 *      npm run decrypt -- ./fixtures/TestLocked.xlsx --try test,Test123,1234
 *
 * The password is read from argv or SHEETS_TEST_PASSWORD. It is never written
 * to disk and never echoed.
 */
import { readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import JSZip from 'jszip'

const require = createRequire(import.meta.url)
const officeCrypto = require('officecrypto-tool')

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const isCfbFile = (b) => b.length >= 8 && b.subarray(0, 8).equals(CFB_MAGIC)
const isEncrypted = (b) => isCfbFile(b) && b.includes(Buffer.from('EncryptedPackage', 'utf16le'))

const WRONG_PASSWORD = /password is incorrect/i

function describeScheme(bytes) {
  const text = bytes.toString('latin1')
  const agile = text.includes('http://schemas.microsoft.com/office/2006/encryption')
  if (!agile) return { scheme: 'Standard (AES-128/SHA-1)', agile: false }
  const cipher = text.match(/cipherAlgorithm="([^"]+)"/)?.[1]
  const keyBits = text.match(/keyBits="(\d+)"/)?.[1]
  const hash = text.match(/hashAlgorithm="([^"]+)"/)?.[1]
  const spin = text.match(/spinCount="(\d+)"/)?.[1]
  return {
    scheme: `Agile (${cipher ?? '?'}-${keyBits ?? '?'}/${hash ?? '?'}, spinCount ${spin ?? '?'})`,
    agile: true,
  }
}

const args = process.argv.slice(2)
const file = resolve(args.find((a) => !a.startsWith('--')) ?? './fixtures/TestLocked.xlsx')
const passwordArg = args[args.indexOf('--password') + 1]
const tryList = args.includes('--try') ? args[args.indexOf('--try') + 1].split(',') : null
const candidates = tryList ?? [passwordArg ?? process.env.SHEETS_TEST_PASSWORD].filter(Boolean)

const bytes = readFileSync(file)

console.log('Encrypted workbook check')
console.log(`  file:      ${file} (${bytes.length} bytes)`)
console.log(`  container: ${isCfbFile(bytes) ? 'CFB (OLE2)' : 'plain zip'}`)
console.log(`  encrypted: ${isEncrypted(bytes)}`)

if (!isEncrypted(bytes)) {
  console.log('\nNot an ECMA-376 encrypted workbook — nothing to decrypt.')
  process.exit(1)
}

console.log(`  scheme:    ${describeScheme(bytes).scheme}`)

if (candidates.length === 0) {
  console.error('\nNo password supplied. Pass --password <pw>, --try a,b,c, or set SHEETS_TEST_PASSWORD.')
  process.exit(2)
}

let password = null
let plain = null
let rejected = 0

for (const candidate of candidates) {
  try {
    const out = await officeCrypto.decrypt(bytes, { password: candidate })
    plain = Buffer.isBuffer(out) ? out : Buffer.from(out)
    password = candidate
    break
  } catch (error) {
    const message = String(error?.message ?? error)
    if (WRONG_PASSWORD.test(message)) {
      rejected += 1
      continue
    }
    console.error(`\nUnsupported scheme or library failure: ${message}`)
    console.error('This is the reason code upstream maps to "unsupported", not "wrong-password".')
    process.exit(1)
  }
}

if (!plain) {
  console.log(`\n${rejected} candidate(s) rejected as an incorrect password.`)
  console.log('The verifier works — the password simply was not among them.')
  process.exit(3)
}

console.log(`\nDecrypted with ${tryList ? `candidate #${candidates.indexOf(password) + 1}` : 'the supplied password'}`)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

check('payload is a plain zip', !isCfbFile(plain), `${plain.length} bytes`)

const zip = await JSZip.loadAsync(plain)
const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
check('contains xl/workbook.xml', names.includes('xl/workbook.xml'), `${names.length} parts`)
check(
  'contains at least one worksheet',
  names.some((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)),
)

// Round-trip: re-encrypt with the same password and decrypt again. This is the
// save path phase 05 needs, not just the open path.
try {
  let reencrypted = await officeCrypto.encrypt(plain, { password })
  if (!Buffer.isBuffer(reencrypted)) reencrypted = Buffer.from(reencrypted)
  check('re-encrypt produced a CFB container', isCfbFile(reencrypted), `${reencrypted.length} bytes`)

  let again = await officeCrypto.decrypt(reencrypted, { password })
  again = Buffer.isBuffer(again) ? again : Buffer.from(again)
  check('re-decrypt returns the same payload', Buffer.compare(plain, again) === 0)

  const scratch = mkdtempSync(join(tmpdir(), 'sheets-decrypt-'))
  const plainPath = join(scratch, `plain-${basename(file)}`)
  writeFileSync(plainPath, plain)
  writeFileSync(join(scratch, `reencrypted-${basename(file)}`), reencrypted)

  // End-to-end: the sidecar must be able to open the decrypted payload. This is
  // the whole phase-05 flow — sniff, decrypt, then hand plaintext to the engine
  // — and it is the step that proves decryption produced a workbook rather than
  // merely valid-looking bytes.
  const binary = resolve(
    import.meta.dirname,
    '../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar',
  )
  if (statSync(binary, { throwIfNoEntry: false })) {
    const { Sidecar } = await import('./sidecar-client.mjs')
    const sidecar = new Sidecar(binary)
    try {
      const opened = await sidecar.open(plainPath)
      const sheets = opened.sheets ?? []
      check(
        'sidecar opens the decrypted payload',
        sheets.length > 0,
        `${sheets.length} sheet(s): ${sheets.map((s) => s.name).join(', ')}`,
      )
      await sidecar.close(opened.sessionId)
    } catch (error) {
      check('sidecar opens the decrypted payload', false, String(error?.message ?? error))
    } finally {
      await sidecar.dispose()
    }
  } else {
    console.log('  (sidecar binary absent — skipped the end-to-end open check)')
  }

  console.log(`\n  artifacts: ${scratch}`)
  console.log('  Open the re-encrypted file in real Excel with the same password')
  console.log('  before trusting phase 05 — that is the check this tool cannot do.')
} catch (error) {
  check('re-encrypt round-trip', false, String(error?.message ?? error))
}

console.log(`\n${failures === 0 ? 'PASSED' : `FAILED (${failures} check(s))`}`)
process.exit(failures === 0 ? 0 : 1)
