// @vitest-environment node
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { EXIF_SCAN_BYTES, exifTakenOn, readExifTakenOn } from './exif-date'

/*
 * Real JPEG bytes, generated with sharp like the e2e phone photos (e2e/support/photos.ts): sharp writes
 * EXIF in little-endian byte order ("II") right after SOI. Big-endian ("MM") order — used by many Canon,
 * Nikon cameras — and the broken cases are built by hand below, on the same segment structure.
 */

async function jpeg(exif?: Record<string, Record<string, string>>): Promise<Uint8Array<ArrayBuffer>> {
  const image = sharp({ create: { width: 64, height: 48, channels: 3, background: '#87b6e8' } }).jpeg({ quality: 80 })
  return new Uint8Array(
    await (exif === undefined ? image : image.withMetadata({ orientation: 6 }).withExifMerge(exif)).toBuffer(),
  )
}

/** Inserts a segment (marker + data) right after SOI, like the APP0 JFIF or APP1 XMP of a real photo. */
function withSegmentFirst(bytes: Uint8Array, marker: number, data: Uint8Array): Uint8Array {
  const length = data.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, marker, length >> 8, length & 0xff, ...data, ...bytes.subarray(2)])
}

/**
 * Minimal JPEG (SOI, APP1 EXIF, EOI) with big-endian TIFF: IFD0 has one entry pointing to the Exif IFD, the Exif IFD
 * has one DateTimeOriginal entry of ASCII type, 20 bytes, stored outside the entry.
 */
function bigEndianJpeg(date: string): Uint8Array {
  const tiff = [
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], // "MM", 42, IFD0 at offset 8
    ...[0x00, 0x01, 0x87, 0x69, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a], // 0x8769 → 26
    ...[0x00, 0x00, 0x00, 0x00], // no next IFD
    ...[0x00, 0x01, 0x90, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x2c], // 0x9003 → 44
    ...[0x00, 0x00, 0x00, 0x00],
    ...Array.from(date.padEnd(19, ' ').slice(0, 19), (c) => c.charCodeAt(0)),
    0x00,
  ]
  const data = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff] // "Exif\0\0"
  const length = data.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...data, 0xff, 0xd9])
}

describe('exifTakenOn', () => {
  it('a real JPEG with DateTimeOriginal: returns the date part yyyy-MM-dd', async () => {
    const bytes = await jpeg({ IFD0: { Make: 'E2E', Model: 'Phone' }, IFD2: { DateTimeOriginal: '2026:09:14 17:30:00' } })

    expect(exifTakenOn(bytes)).toBe('2026-09-14')
  })

  it('takes the date the camera recorded as is, no time zone conversion: 23:59 is still that day', async () => {
    // Like the backend: building a Date in an assumed time zone could push a late-night photo to the next day.
    const bytes = await jpeg({ IFD2: { DateTimeOriginal: '2025:12:31 23:59:59' } })

    expect(exifTakenOn(bytes)).toBe('2025-12-31')
  })

  it('big-endian TIFF ("MM") can also be read', () => {
    expect(exifTakenOn(bigEndianJpeg('2024:02:29 08:00:00'))).toBe('2024-02-29')
  })

  it('skips APP0 JFIF and APP1 XMP that come before the EXIF segment', async () => {
    const exif = await jpeg({ IFD2: { DateTimeOriginal: '2026:09:14 17:30:00' } })
    const jfif = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
    const xmp = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')

    expect(exifTakenOn(withSegmentFirst(withSegmentFirst(exif, 0xe1, xmp), 0xe0, jfif))).toBe('2026-09-14')
  })

  it('a photo without EXIF, or EXIF without DateTimeOriginal: null', async () => {
    expect(exifTakenOn(await jpeg())).toBeNull()
    expect(exifTakenOn(await jpeg({ IFD0: { Make: 'E2E', Model: 'Phone' } }))).toBeNull()
  })

  it.each([
    ['camera clock not set', '0000:00:00 00:00:00'],
    ['date that does not exist', '2026:02:31 10:00:00'],
    ['not a leap year', '2023:02:29 10:00:00'],
    ['month 13', '2026:13:01 10:00:00'],
    ['not a date', 'unknown            '],
  ])('invalid date (%s): null, so the backend does not return 400 for the whole upload', (_, date) => {
    expect(exifTakenOn(bigEndianJpeg(date))).toBeNull()
  })

  it('PNG, WebP or junk bytes: null', async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    )
    const webp = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
        .webp()
        .toBuffer(),
    )

    expect(exifTakenOn(png)).toBeNull()
    expect(exifTakenOn(webp)).toBeNull()
    expect(exifTakenOn(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull()
    expect(exifTakenOn(new Uint8Array())).toBeNull()
  })

  it('never throws on a file truncated at any byte', async () => {
    const bytes = await jpeg({ IFD0: { Make: 'E2E' }, IFD2: { DateTimeOriginal: '2026:09:14 17:30:00' } })
    const results = new Set<string | null>()

    // Every cut point from the middle of SOI to the end of the EXIF segment: each read must check bounds.
    for (let cut = 0; cut <= 300; cut += 1) results.add(exifTakenOn(bytes.subarray(0, cut)))

    expect([...results].every((value) => value === null || value === '2026-09-14')).toBe(true)
    expect(results.has(null)).toBe(true)
  })

  it('an offset pointing outside the segment (broken EXIF): null, does not throw', () => {
    const bytes = bigEndianJpeg('2026:09:14 17:30:00')
    // Change the offset of the Exif IFD (the last byte of entry 0x8769) to 0xFF.
    const broken = bytes.slice()
    broken.set([0x7f, 0xff, 0xff, 0xff], 2 + 4 + 6 + 8 + 2 + 8)

    expect(exifTakenOn(broken)).toBeNull()
  })
})

describe('readExifTakenOn', () => {
  it('reads from a File when only the head of the file is needed', async () => {
    const bytes = await jpeg({ IFD2: { DateTimeOriginal: '2026:09:14 17:30:00' } })
    // A tail longer than EXIF_SCAN_BYTES: the date is at the head so it can still be read.
    const file = new File([bytes, new Uint8Array(EXIF_SCAN_BYTES)], 'IMG_0001.jpg', { type: 'image/jpeg' })

    await expect(readExifTakenOn(file)).resolves.toBe('2026-09-14')
  })

  it('does not reject when reading a bad file', async () => {
    const failing = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) } as unknown as Blob

    await expect(readExifTakenOn(failing)).resolves.toBeNull()
  })
})
