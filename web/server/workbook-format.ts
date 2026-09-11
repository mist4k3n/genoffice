/**
 * Classify bytes that are not a zip before the sidecar sees them.
 *
 * The sidecar reports an encrypted workbook as `Could not find EOCD`, which is
 * exactly what it reports for a truncated or corrupt file -- so the server has
 * to tell them apart itself, or a password-protected workbook looks broken to
 * the user (FINDINGS-00). Both formats are CFB/OLE2 containers; what separates
 * an encrypted OOXML package from a genuine legacy .xls is the
 * "EncryptedPackage" stream name, stored UTF-16LE in the directory.
 */
import { open } from 'node:fs/promises'

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le')

export type WorkbookKind = 'ooxml' | 'encrypted' | 'legacy-xls' | 'unknown'

/** Only the prefix is ever examined, so only the prefix needs reading. */
const SNIFF_BYTES = 64 * 1024

export function classifyWorkbookBytes(bytes: Uint8Array): WorkbookKind {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.subarray(0, 4).equals(ZIP_MAGIC)) return 'ooxml'
  if (!view.subarray(0, 8).equals(CFB_MAGIC)) return 'unknown'
  // The directory sits well inside the container; scanning a bounded prefix
  // avoids walking a 100MB file to answer a yes/no question.
  return view.subarray(0, SNIFF_BYTES).includes(ENCRYPTED_PACKAGE) ? 'encrypted' : 'legacy-xls'
}

/**
 * Same classification, for a file the server never loads into memory.
 *
 * The direct-read fast path hands the engine a path instead of bytes, and the
 * first version of it skipped this check entirely -- so a password-protected
 * workbook went straight back to failing with the EOCD error that is
 * indistinguishable from corruption, which is the exact bug this module
 * exists to prevent. Caught by the corpus harness, not by reasoning.
 */
export async function classifyWorkbookAt(path: string): Promise<WorkbookKind> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    return classifyWorkbookBytes(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
