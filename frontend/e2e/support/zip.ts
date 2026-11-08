import { inflateRawSync } from 'node:zlib'

/**
 * The entries of a ZIP file by name, for the E2E checks of a downloaded post package. Read from the central directory, because a
 * writer may put the sizes after the data. Stored and deflated entries only, which is all the exporter writes.
 */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('Not a ZIP file: no end of central directory')

  const entries = new Map<string, Buffer>()
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Not a ZIP file: bad central directory entry')
    const method = zip.readUInt16LE(at + 10)
    const compressedSize = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const localHeader = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28)
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
