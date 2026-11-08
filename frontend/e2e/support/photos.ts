import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { PHONE_PHOTO } from './env'

/**
 * Photos to upload in the admin flow. Generated with `sharp` — the module Next already pulls in to optimize images (and
 * `backend/src/test/resources/media/generate-fixtures.cjs` also uses it) — so as not to commit
 * a multi-MB JPEG file into the repo.
 */

/** The capture date written in the EXIF of the generated photo. */
const GENERATED_TAKEN = '2026:09:14 17:30:00'

/** A portrait scene: sky on top, mountains below, a red square in the top-left corner. An image shown the right way up has the red square on top. */
function portraitScene(width: number, height: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#87b6e8"/>
    <circle cx="${width * 0.7}" cy="${height * 0.22}" r="${width * 0.1}" fill="#ffd27a"/>
    <path d="M0 ${height * 0.7} L${width * 0.3} ${height * 0.5} L${width * 0.55} ${height * 0.64} L${width} ${height * 0.46} L${width} ${height} L0 ${height} Z" fill="#3d5a40"/>
    <rect x="${width * 0.05}" y="${height * 0.04}" width="${width * 0.15}" height="${width * 0.15}" fill="#d93025"/>
  </svg>`)
}

/**
 * A portrait photo taken by a phone, exactly the kind of photo that breaks the image pipeline: pixels stored LANDSCAPE 4032×3024
 * with EXIF Orientation 6 (displayed portrait 3024×4032), with DateTimeOriginal and GPS, larger than 4 MB (so the
 * browser has to downsize it before sending). The scene is drawn portrait and then rotated back 90° to be stored: only when the
 * orientation is applied does the image stand upright.
 *
 * `E2E_PHONE_PHOTO` replaces it with a real photo from a real phone. Generated once, kept in the operating system's temp
 * folder (write a temp file then rename, so two processes do not read a half-written file).
 */
export async function phonePhoto(): Promise<string> {
  if (PHONE_PHOTO) return PHONE_PHOTO

  const dir = join(tmpdir(), 'blog-e2e')
  const file = join(dir, 'phone-o6.jpg')
  if (existsSync(file)) return file
  mkdirSync(dir, { recursive: true })

  const width = 3024
  const height = 4032
  // Noise so the JPEG has the size of a real photo: a flat-color image compresses to a few hundred KB and does not hit
  // the "> 4 MB then downsize" branch of lib/prepare-upload.ts.
  const noise = await sharp({
    // `background` only satisfies sharp's typing; with `noise` sharp ignores it.
    create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 30 } },
  })
    .png()
    .toBuffer()
  const upright = await sharp(portraitScene(width, height))
    .composite([{ input: noise, blend: 'overlay' }])
    .png()
    .toBuffer()
  const stored = await sharp(upright)
    .rotate(270)
    .jpeg({ quality: 92 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: 'E2E', Model: 'Phone' },
      IFD2: { DateTimeOriginal: GENERATED_TAKEN },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '21/1 1/1 30/1', GPSLongitudeRef: 'E', GPSLongitude: '105/1 51/1 0/1' },
    })
    .toBuffer()

  const partial = `${file}.${process.pid}.tmp`
  writeFileSync(partial, stored)
  renameSync(partial, file)
  return file
}

/**
 * The capture date (yyyy-MM-dd) in the EXIF DateTimeOriginal of a JPEG file, null when absent. Read
 * straight from the TIFF structure (IFD0 → the Exif IFD pointer 0x8769 → tag 0x9003): a test needs to know which day the photo SAYS it
 * was taken, even when it is a real photo passed through `E2E_PHONE_PHOTO`.
 */
export async function exifTakenOn(file: string): Promise<string | null> {
  const { exif } = await sharp(readFileSync(file)).metadata()
  if (!exif) return null

  const base = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0
  const little = exif.subarray(base, base + 2).toString('latin1') === 'II'
  const u16 = (at: number) => (little ? exif.readUInt16LE(base + at) : exif.readUInt16BE(base + at))
  const u32 = (at: number) => (little ? exif.readUInt32LE(base + at) : exif.readUInt32BE(base + at))
  const entry = (ifd: number, tag: number): number | null => {
    const count = u16(ifd)
    for (let i = 0; i < count; i += 1) {
      const at = ifd + 2 + i * 12
      if (u16(at) === tag) return at
    }
    return null
  }

  const pointer = entry(u32(4), 0x8769)
  if (pointer === null) return null
  const original = entry(u32(pointer + 8), 0x9003)
  if (original === null) return null
  const length = u32(original + 4)
  const offset = u32(original + 8)
  const value = exif.subarray(base + offset, base + offset + length).toString('latin1')
  const match = /^(\d{4}):(\d{2}):(\d{2})/.exec(value)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

/** The uploaded photo is the generated one (with a red square marking the orientation), not a real photo through `E2E_PHONE_PHOTO`. */
export const usesGeneratedPhoto = PHONE_PHOTO === null

/**
 * Whether the stored photo is the CORRECT way up, not just "portrait": the red square of the generated scene must be in the top-left corner.
 * A wrong rotation (counter-clockwise instead of clockwise) still gives a portrait image, but the red square would be in the bottom-right corner.
 * Measures the average color of a small region in the middle of the red square; the overlay-style noise keeps the red hue.
 */
export async function markerAtTopLeft(image: Buffer): Promise<boolean> {
  // All coordinates are relative to the WIDTH: the red square is square, its side 15% of the width, so the measured region does not depend on the image ratio.
  const { width = 0 } = await sharp(image).metadata()
  const side = Math.round(width * 0.06)
  const box = { left: Math.round(width * 0.09), top: Math.round(width * 0.08), width: side, height: side }
  // Crop to a separate buffer and then measure: sharp's `stats()` reads the INPUT image, ignoring `extract()` in
  // the same pipeline — measuring directly gives the average color of the whole image.
  const region = await sharp(image).extract(box).toBuffer()
  const [red, green, blue] = (await sharp(region).stats()).channels.map((channel) => channel.mean)
  return red > 150 && green < 120 && blue < 120
}

/** A small flat-color JPEG, to fill the gallery of a fresh stack that has no photos yet. */
export async function smallPhoto(color: string, width = 1200, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 85 })
    .toBuffer()
}
