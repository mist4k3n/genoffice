#!/usr/bin/env node
/**
 * Phase-05 spike: can we round-trip a password-to-open workbook?
 *
 * The corpus has no ECMA-376 encrypted file (every sample is a plain zip, and
 * the "protected" one carries only a worksheet-protection hash), so this
 * synthesises one with the same library upstream already uses for Docs,
 * then verifies decrypt and re-encrypt.
 *
 * Mirrors the predicates in apps/docs/src/main/docx-encryption.ts so the
 * classification logic is tested, not just the crypto.
 *
 * Run: npm run spike:encryption -- ./fixtures/acme-budget.xlsx
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import JSZip from 'jszip'

const require = createRequire(import.meta.url)
const officeCrypto = require('officecrypto-tool')

// ── Predicates copied from apps/docs/src/main/docx-encryption.ts ────────────
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

const isCfbFile = (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(CFB_MAGIC)
const isEncryptedOoxml = (bytes) => isCfbFile(bytes) && bytes.includes(ENCRYPTED_STREAM_UTF16)

// ── Helpers ─────────────────────────────────────────────────────────────────
const PASSWORD = 'Spike-Phase05!'
const WRONG = 'definitely-not-it'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** Compare the meaningful payload, not the zip framing: recompressing can
 *  change byte length without changing a single cell. */
async function partDigest(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort()
  const parts = []
  for (const name of names) {
    const content = await zip.file(name).async('nodebuffer')
    parts.push(`${name}:${content.length}`)
  }
  return { names, signature: parts.join('|') }
}

const input = resolve(process.argv[2] ?? './fixtures/acme-budget.xlsx')
const plain = readFileSync(input)
const scratch = mkdtempSync(join(tmpdir(), 'sheets-enc-spike-'))

console.log(`Phase-05 encryption spike`)
console.log(`Source: ${input} (${plain.length} bytes)`)
console.log(`Scratch: ${scratch}\n`)

console.log('Source classification')
check('source is a plain zip, not CFB', !isCfbFile(plain))
check('source is not detected as encrypted', !isEncryptedOoxml(plain))

console.log('\nEncrypt')
let encrypted
try {
  encrypted = await officeCrypto.encrypt(plain, { password: PASSWORD })
  if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted)
  writeFileSync(join(scratch, `encrypted-${basename(input)}`), encrypted)
  check('encrypt() produced output', encrypted.length > 0, `${encrypted.length} bytes`)
  check('output is a CFB container', isCfbFile(encrypted))
  check('output carries an EncryptedPackage stream', isEncryptedOoxml(encrypted))
} catch (error) {
  check('encrypt() succeeded', false, String(error?.message ?? error))
}

console.log('\nDecrypt with the correct password')
if (encrypted) {
  try {
    let decrypted = await officeCrypto.decrypt(encrypted, { password: PASSWORD })
    if (!Buffer.isBuffer(decrypted)) decrypted = Buffer.from(decrypted)
    writeFileSync(join(scratch, `decrypted-${basename(input)}`), decrypted)
    check('decrypt() produced output', decrypted.length > 0, `${decrypted.length} bytes`)
    check('output is a plain zip again', !isCfbFile(decrypted))

    const before = await partDigest(plain)
    const after = await partDigest(decrypted)
    check('same part names', before.names.join() === after.names.join(), `${after.names.length} parts`)
    check('same part sizes', before.signature === after.signature)
    check('byte-identical to the original', Buffer.compare(plain, decrypted) === 0)
  } catch (error) {
    check('decrypt() succeeded', false, String(error?.message ?? error))
  }
}

console.log('\nDecrypt with the wrong password')
if (encrypted) {
  try {
    await officeCrypto.decrypt(encrypted, { password: WRONG })
    check('wrong password is rejected', false, 'it was accepted — verifier not checked')
  } catch (error) {
    const message = String(error?.message ?? error)
    const distinguishable = /password is incorrect/i.test(message)
    check('wrong password is rejected', true)
    check(
      'rejection is distinguishable from an unsupported scheme',
      distinguishable,
      distinguishable
        ? "matches upstream's 'password is incorrect' probe"
        : `upstream keys off /password is incorrect/; got: ${message}`,
    )
  }
}

console.log(`\n${failures === 0 ? 'Spike PASSED' : `Spike FAILED (${failures} check(s))`}`)
console.log('Artifacts left in', scratch)
console.log('\nStill unverified here: that real Excel reopens the encrypted output.')
console.log('Open the file above in Excel before trusting phase 05.')
process.exit(failures === 0 ? 0 : 1)
