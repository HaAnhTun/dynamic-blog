/*
 * Downscales an image in the browser before sending it to the Server Action.
 *
 * Why in the browser: the Server Action limits the body to 5 MiB (next.config.ts), and that limit
 * is deliberately small because Next reads EVERY multipart POST to every page up to that size before checking the action id.
 * An 8 MB phone photo sent as is dies there, before the action gets to run and report an error.
 *
 * No 'use client' and no server imports: this file is just functions, usable both in a
 * client component (prepareUpload) and in a Server Action (MAX_UPLOAD_BYTES for the re-check).
 * Browser globals are only touched inside functions, not at module level.
 */
import type { Translator } from '@/i18n/translator'

/** The three formats the backend can read. Matches the `accept` of the file picker. */
export const ACCEPTED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Above this threshold, downscale. A decimal number, not 4 MiB: the Server Action re-checks
 *  exactly `size <= 4_000_000`, and both sides must be the same number. */
export const MAX_UPLOAD_BYTES = 4_000_000

/** Maximum long edge, equal to the backend's `app.media.max-edge`: shrinking further here loses
 *  detail that the server keeps anyway. */
export const MAX_UPLOAD_EDGE = 2400

/** Why an upload was refused; `uploadRejectedMessage` turns it into text for the user. */
export type UploadRejectCode = 'unsupported' | 'undecodable' | 'stillTooLarge'

export type UploadDecision =
  | { action: 'send-as-is' }
  | { action: 'reencode'; maxEdge: 2400; type: 'image/jpeg'; quality: 0.9 }
  | { action: 'reject'; code: UploadRejectCode }

function isAccepted(type: string): boolean {
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(type)
}

/**
 * A pure decision, does not touch the browser: testable without a canvas.
 *
 * A small file (≤ 4 MB and edge ≤ 2400) is sent AS IS, even a JPEG with EXIF: the server reads the capture date from
 * the EXIF before rotating the image and removing metadata. Re-encoding here would lose that date.
 * A small PNG is also sent as is, so screenshots and diagrams do not get their text blurred by JPEG.
 */
export function decideUpload(meta: { size: number; type: string; width: number; height: number }): UploadDecision {
  // HEIC, GIF, SVG, AVIF and an empty type (the browser does not recognize the file extension) all stop here.
  if (!isAccepted(meta.type)) return { action: 'reject', code: 'unsupported' }
  if (meta.size > MAX_UPLOAD_BYTES || Math.max(meta.width, meta.height) > MAX_UPLOAD_EDGE) {
    return { action: 'reencode', maxEdge: MAX_UPLOAD_EDGE, type: 'image/jpeg', quality: 0.9 }
  }
  return { action: 'send-as-is' }
}

/**
 * A refused upload. `message` is developer text; with a `code` the user sees `uploadRejectedMessage(error, t)`, without one
 * (an error built by a caller) the message itself.
 */
export class UploadRejectedError extends Error {
  readonly code: UploadRejectCode | undefined

  constructor(message: string, code?: UploadRejectCode) {
    super(message)
    this.name = 'UploadRejectedError'
    this.code = code
  }
}

/** The sentence for the user. `t` is the `Admin.postImages` translator. */
export function uploadRejectedMessage(error: UploadRejectedError, t: Translator): string {
  switch (error.code) {
    case 'unsupported':
      return t('uploadRejected.unsupported')
    case 'undecodable':
      return t('uploadRejected.undecodable')
    case 'stillTooLarge':
      return t('uploadRejected.stillTooLarge')
    default:
      return error.message
  }
}

/** A decoded image, with the EXIF orientation ALREADY applied: `width`/`height` are the display dimensions. */
export type DecodedImage = {
  width: number
  height: number
  source: CanvasImageSource
  close(): void
}

/** The part that touches the browser, split out so `prepareUpload` can be tested with a fake. */
export type ImageCodec = {
  decode(file: File): Promise<DecodedImage>
  /** Draws the image on a `width`×`height` canvas and returns a JPEG at `quality`. */
  encode(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob>
}

const browserCodec: ImageCodec = {
  async decode(file) {
    // createImageBitmap with 'from-image' applies the EXIF orientation: a portrait photo stays portrait, and the redrawn
    // canvas carries no EXIF so GPS does not travel along either.
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
      } catch {
        // An old browser lacks the 'from-image' value (TypeError) or cannot decode
        // this way: try through <img>, which also applies orientation from the CSS default
        // `image-orientation: from-image`.
      }
    }
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  },

  async encode(image, width, height, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('Canvas 2D is not available')
    // White background first: JPEG has no alpha channel, and the transparent pixels of a large PNG would
    // turn BLACK if drawn directly.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(image.source, 0, 0, width, height)
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob === null ? reject(new Error('Canvas could not export a JPEG')) : resolve(blob)),
        'image/jpeg',
        quality,
      ),
    )
  },
}

/** q0.9 first; a detailed image such as foliage may still exceed 4 MB at 2400px, so lower it
 *  step by step instead of sending a file the Server Action would reject. */
const FALLBACK_QUALITIES = [0.8, 0.7] as const

function asJpegName(name: string): string {
  const base = name.replace(/\.[^.]*$/, '')
  return `${base === '' ? 'anh' : base}.jpg`
}

/**
 * Returns a file ready to send: `file` itself when no downscaling is needed, or a new JPEG ≤ 4 MB with
 * long edge ≤ 2400. Throws `UploadRejectedError` (with a `code`) when it cannot.
 *
 * `codec` is only there so tests can replace the browser part; components always call with one argument.
 */
export async function prepareUpload(file: File, codec: ImageCodec = browserCodec): Promise<File> {
  // Type first, before any decode step: a 10 MB HEIC file is not worth the memory only to be rejected.
  if (!isAccepted(file.type)) throw new UploadRejectedError('Unsupported image type', 'unsupported')

  let image: DecodedImage
  try {
    image = await codec.decode(file)
  } catch {
    // The browser cannot read it but the file is small enough: send as is, the server (TwelveMonkeys can
    // read CMYK JPEG too) has the final say.
    if (file.size <= MAX_UPLOAD_BYTES) return file
    throw new UploadRejectedError('The browser cannot decode this image to shrink it', 'undecodable')
  }

  try {
    const decision = decideUpload({ size: file.size, type: file.type, width: image.width, height: image.height })
    if (decision.action === 'send-as-is') return file
    if (decision.action === 'reject') throw new UploadRejectedError('Unsupported image type', decision.code)

    const scale = Math.min(1, decision.maxEdge / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    for (const quality of [decision.quality, ...FALLBACK_QUALITIES]) {
      const blob = await codec.encode(image, width, height, quality)
      if (blob.size <= MAX_UPLOAD_BYTES) {
        return new File([blob], asJpegName(file.name), { type: decision.type, lastModified: file.lastModified })
      }
    }
    throw new UploadRejectedError('Image still too large after shrinking', 'stillTooLarge')
  } finally {
    image.close()
  }
}
