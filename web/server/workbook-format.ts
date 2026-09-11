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
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ENCRYPTED_PACKAGE = Buffer.from('EncryptedPackage', 'utf16le')

export function classifyWorkbookBytes(bytes: Uint8Array): 'ooxml' | 'encrypted' | 'legacy-xls' | 'unknown' {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.subarray(0, 4).equals(ZIP_MAGIC)) return 'ooxml'
  if (!view.subarray(0, 8).equals(CFB_MAGIC)) return 'unknown'
  // The directory sits well inside the container; scanning a bounded prefix
  // avoids walking a 100MB file to answer a yes/no question.
  return view.subarray(0, 64 * 1024).includes(ENCRYPTED_PACKAGE) ? 'encrypted' : 'legacy-xls'
}
