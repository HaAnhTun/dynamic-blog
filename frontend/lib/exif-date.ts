/*
 * The capture date (EXIF DateTimeOriginal) read in the browser, from the ORIGINAL file, before prepareUpload redraws
 * the photo through a canvas. A redrawn JPEG carries no EXIF, so the backend has nothing left to read: phone photos
 * (almost always > 4 MB or an edge > 2400, i.e. always redrawn) reached the gallery with takenOn = null, contrary
 * to the promise under the capture date field (e2e QA: "capture date lost when downscaling in the browser").
 *
 * The same rules as the backend (ImageProcessor.ExifSummary.takenOn): only the DateTimeOriginal tag (0x9003)
 * in the Exif IFD, taking the date part as the camera recorded it (local time at capture, no time zone
 * conversion), and a date that does not exist — a camera with an unset clock writes "0000:00:00 00:00:00" — counts as none.
 *
 * JPEG only (APP1 segment "Exif\0\0"): that is the format of phone photos. Small PNG/WebP are sent
 * as they are and the backend reads them itself; the EXIF chunk of a WebP is often AFTER the image data, so reading it means
 * reading the whole file.
 *
 * Never throws: every read checks bounds, a broken or truncated file only yields null. No
 * 'use client' and no touching browser globals at module level, like lib/prepare-upload.ts.
 */

/**
 * The head of the file that is read. The APP1 segment is at most 64 KiB and sits near the head of the file (right after SOI, sometimes
 * after an APP0 JFIF or an XMP APP1): this much is plenty, without pulling a whole 8 MB photo into memory.
 */
export const EXIF_SCAN_BYTES = 256 * 1024

const TAG_EXIF_IFD = 0x8769
const TAG_DATE_TIME_ORIGINAL = 0x9003
const TYPE_ASCII = 2
/** "yyyy:MM:dd", or the "yyyy-MM-dd" of some photo editors: the same pattern as EXIF_DATE in the backend. */
const EXIF_DATE = /^(\d{4})[:-](\d{2})[:-](\d{2})/

/** Read out of bounds. Only thrown inside the module; the exported functions catch it and return null. */
class OutOfBounds extends Error {}

/**
 * The capture date `yyyy-MM-dd` in the EXIF DateTimeOriginal of the first bytes of a JPEG file, or null when it is
 * not a JPEG, has no EXIF, has no such tag, the date is invalid, or the data is broken.
 */
export function exifTakenOn(bytes: Uint8Array): string | null {
  try {
    const exif = exifSegment(bytes)
    return exif === null ? null : tiffTakenOn(bytes, exif.start, exif.end)
  } catch {
    return null
  }
}

/** Like `exifTakenOn`, reading straight from a File/Blob (only the first EXIF_SCAN_BYTES). Never rejects. */
export async function readExifTakenOn(file: Blob): Promise<string | null> {
  try {
    return exifTakenOn(new Uint8Array(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer()))
  } catch {
    return null
  }
}

/**
 * Position of the TIFF part (after "Exif\0\0") of the first EXIF APP1 segment. Walks segment by segment by the
 * declared length, stopping at SOS (image data begins, metadata is over) or EOI.
 */
function exifSegment(bytes: Uint8Array): { start: number; end: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // A 0xFF padding byte before the marker is valid.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null
    // A standalone marker, with no length field: TEM and RST0–7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    if (length < 2) return null
    const start = at + 4
    const end = Math.min(at + 2 + length, bytes.length)
    if (marker === 0xe1 && isExifHeader(bytes, start, end)) return { start: start + 6, end }
    at += 2 + length
  }
  return null
}

function isExifHeader(bytes: Uint8Array, start: number, end: number): boolean {
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] // "Exif\0\0"
  return end - start >= header.length && header.every((byte, i) => bytes[start + i] === byte)
}

/** IFD0 → Exif IFD pointer (0x8769) → DateTimeOriginal (0x9003), every offset counted from the start of the TIFF. */
function tiffTakenOn(bytes: Uint8Array, tiff: number, end: number): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const checked = (at: number, size: number) => {
    if (at < tiff || at + size > end) throw new OutOfBounds()
    return at
  }
  const order = String.fromCharCode(bytes[checked(tiff, 2)], bytes[tiff + 1])
  if (order !== 'II' && order !== 'MM') return null
  const little = order === 'II'
  const u16 = (at: number) => view.getUint16(checked(at, 2), little)
  const u32 = (at: number) => view.getUint32(checked(at, 4), little)
  /** Position of the entry (12 bytes) carrying `tag` in the IFD at `ifd`, or null. */
  const entry = (ifd: number, tag: number): number | null => {
    const count = u16(ifd)
    for (let i = 0; i < count; i += 1) {
      const at = ifd + 2 + i * 12
      if (u16(at) === tag) return at
    }
    return null
  }

  if (u16(tiff + 2) !== 42) return null
  const pointer = entry(tiff + u32(tiff + 4), TAG_EXIF_IFD)
  if (pointer === null) return null
  const original = entry(tiff + u32(pointer + 8), TAG_DATE_TIME_ORIGINAL)
  if (original === null || u16(original + 2) !== TYPE_ASCII) return null

  // An ASCII string of ≤ 4 bytes sits right inside the entry; longer ones make the entry hold an offset to it.
  const count = u32(original + 4)
  const value = count <= 4 ? original + 8 : tiff + u32(original + 8)
  // Only "yyyy:MM:dd" is needed; read up to the first NUL (Java `trim()` in the backend also drops that NUL).
  const length = Math.min(count, 32)
  checked(value, length)
  let raw = ''
  for (let i = 0; i < length && bytes[value + i] !== 0; i += 1) raw += String.fromCharCode(bytes[value + i])
  return calendarDate(raw.trim())
}

/** `yyyy-MM-dd` if it is a real date (month 0, or 31/2, is not), otherwise null. */
function calendarDate(raw: string): string | null {
  const match = EXIF_DATE.exec(raw)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(2000, month - 1, day))
  date.setUTCFullYear(year)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}
