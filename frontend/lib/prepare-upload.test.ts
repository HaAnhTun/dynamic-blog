import { describe, expect, it, vi } from 'vitest'
import { translatorFor } from '@/test/intl'
import {
  MAX_UPLOAD_BYTES,
  UploadRejectedError,
  decideUpload,
  prepareUpload,
  uploadRejectedMessage,
  type DecodedImage,
  type ImageCodec,
} from './prepare-upload'
import { msg } from '@/test/render-intl'

const MB = 1_000_000
const t = translatorFor('vi', 'Admin.postImages')

describe('decideUpload', () => {
  it(
    msg('Admin.postImages.size', { width: '8 MB phone photo 4000', height: '3000: downscaled to a 2400 edge, JPEG q0.9' }),
    () => {
      // This is the real case. Sent as is, it exceeds the 5 MiB Server Action limit
      // and the request dies before the action gets to run.
      expect(decideUpload({ size: 8 * MB, type: 'image/jpeg', width: 4000, height: 3000 })).toEqual({
        action: 'reencode',
        maxEdge: 2400,
        type: 'image/jpeg',
        quality: 0.9,
      })
    },
  )

  it(
    msg('Admin.postImages.size', {
      width: '1 MB JPEG 1200',
      height: '800: sent as is, so the server can still read the EXIF capture date',
    }),
    () => {
      expect(decideUpload({ size: 1 * MB, type: 'image/jpeg', width: 1200, height: 800 })).toEqual({
        action: 'send-as-is',
      })
    },
  )

  it(msg('Admin.postImages.size', { width: '3 MB PNG 2000', height: '1500: sent as is, keeping screenshots sharp' }), () => {
    expect(decideUpload({ size: 3 * MB, type: 'image/png', width: 2000, height: 1500 })).toEqual({
      action: 'send-as-is',
    })
  })

  it('small WebP: sent as is, the server converts it', () => {
    expect(decideUpload({ size: 500_000, type: 'image/webp', width: 1600, height: 900 })).toEqual({
      action: 'send-as-is',
    })
  })

  // One case per condition: an image that is both large and heavy would pass even if the code
  // checked only one of the two.
  it('heavy only (over 4 MB, small edge): downscaled', () => {
    expect(decideUpload({ size: MAX_UPLOAD_BYTES + 1, type: 'image/png', width: 1000, height: 1000 }).action).toBe('reencode')
  })

  it('large only (width over 2400, light file): downscaled', () => {
    expect(decideUpload({ size: 300_000, type: 'image/jpeg', width: 2401, height: 100 }).action).toBe('reencode')
  })

  it('large only (height over 2400, light file): downscaled', () => {
    expect(decideUpload({ size: 300_000, type: 'image/jpeg', width: 100, height: 2401 }).action).toBe('reencode')
  })

  it('exactly at the threshold (4 MB, 2400 edge) is still sent as is', () => {
    expect(decideUpload({ size: MAX_UPLOAD_BYTES, type: 'image/jpeg', width: 2400, height: 2400 }).action).toBe('send-as-is')
  })

  it('the byte threshold is 4,000,000, matching the re-check in the Server Action', () => {
    expect(MAX_UPLOAD_BYTES).toBe(4_000_000)
  })

  it.each(['image/heic', 'image/heif', 'image/gif', 'image/svg+xml', 'image/avif', 'application/pdf', ''])(
    '%j: rejected as an unsupported type',
    (type) => {
      const decision = decideUpload({ size: 1 * MB, type, width: 1000, height: 1000 })

      expect(decision).toEqual({ action: 'reject', code: 'unsupported' })
    },
  )
})

/** Fake codec: records the calls, encode returns a blob whose size is taken from `sizes` in turn. */
function fakeCodec(image: { width: number; height: number }, sizes: number[] = [1 * MB]) {
  const close = vi.fn()
  const decoded: DecodedImage = { width: image.width, height: image.height, source: {} as CanvasImageSource, close }
  let call = 0
  const codec: ImageCodec = {
    decode: vi.fn(async () => decoded),
    encode: vi.fn(async () => new Blob([new Uint8Array(sizes[Math.min(call++, sizes.length - 1)])], { type: 'image/jpeg' })),
  }
  return { codec, close, decoded }
}

/** A File whose `size` is exactly as declared without actually allocating that many bytes. */
function fileOf(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('prepareUpload', () => {
  it('sends exactly the same File object when no downscaling is needed, no re-encoding', async () => {
    const { codec } = fakeCodec({ width: 1200, height: 800 })
    const file = fileOf('anh.jpg', 'image/jpeg', 1 * MB)

    await expect(prepareUpload(file, codec)).resolves.toBe(file)
    expect(codec.encode).not.toHaveBeenCalled()
  })

  it(
    msg('Admin.postImages.size', {
      width: 'landscape 4000',
      height: '3000 8 MB image: redrawn at 2400×1800, gives a .jpg File of type image/jpeg',
    }),
    async () => {
      const { codec, decoded } = fakeCodec({ width: 4000, height: 3000 })

      const result = await prepareUpload(fileOf('so-do.v2.png', 'image/png', 8 * MB), codec)

      expect(codec.encode).toHaveBeenCalledWith(decoded, 2400, 1800, 0.9)
      // Only the last extension is replaced: the original name is how the admin recognizes their image.
      expect(result.name).toBe('so-do.v2.jpg')
      expect(result.type).toBe('image/jpeg')
      expect(result.size).toBe(1 * MB)
    },
  )

  it(
    msg('Admin.postImages.size', {
      width: 'portrait image (EXIF orientation 6 already decoded as rotated to 3000',
      height: '4000): gives 1800×2400',
    }),
    async () => {
      // The size comes from the ALREADY rotated image (createImageBitmap with imageOrientation 'from-image'),
      // so a portrait photo stays portrait. Canvas does not write EXIF, so GPS does not travel along either.
      const { codec, decoded } = fakeCodec({ width: 3000, height: 4000 })

      await prepareUpload(fileOf('doc.jpg', 'image/jpeg', 8 * MB), codec)

      expect(codec.encode).toHaveBeenCalledWith(decoded, 1800, 2400, 0.9)
    },
  )

  it('a detailed image still over 4 MB at q0.9: lowers the quality until it fits', async () => {
    const { codec, decoded } = fakeCodec({ width: 4000, height: 3000 }, [4.5 * MB, 3.9 * MB])

    const result = await prepareUpload(fileOf('la-cay.jpg', 'image/jpeg', 9 * MB), codec)

    expect(codec.encode).toHaveBeenNthCalledWith(1, decoded, 2400, 1800, 0.9)
    expect(codec.encode).toHaveBeenNthCalledWith(2, decoded, 2400, 1800, 0.8)
    expect(result.size).toBe(3.9 * MB)
  })

  it('never returns a file over 4 MB: when nothing works it rejects with a message for the user', async () => {
    const { codec } = fakeCodec({ width: 4000, height: 3000 }, [6 * MB])

    const error = await prepareUpload(fileOf('nhieu.jpg', 'image/jpeg', 9 * MB), codec).catch((e) => e)

    expect(error).toBeInstanceOf(UploadRejectedError)
    expect(error.code).toBe('stillTooLarge')
    expect(uploadRejectedMessage(error, t)).toBe(msg('Admin.postImages.uploadRejected.stillTooLarge'))
  })

  it('HEIC is rejected before decoding', async () => {
    const { codec } = fakeCodec({ width: 4000, height: 3000 })

    const error = await prepareUpload(fileOf('IMG.heic', 'image/heic', 2 * MB), codec).catch((e) => e)

    expect(error).toBeInstanceOf(UploadRejectedError)
    expect(error.code).toBe('unsupported')
    expect(uploadRejectedMessage(error, t)).toBe(msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE'))
    expect(codec.decode).not.toHaveBeenCalled()
  })

  it('the browser cannot decode a small file: sent as is, the server decides', async () => {
    const codec: ImageCodec = { decode: vi.fn(async () => Promise.reject(new Error('decode'))), encode: vi.fn() }
    const file = fileOf('la.webp', 'image/webp', 2 * MB)

    await expect(prepareUpload(file, codec)).resolves.toBe(file)
  })

  it('the browser cannot decode a large file: rejected, because sending it as is would exceed the limit', async () => {
    const codec: ImageCodec = { decode: vi.fn(async () => Promise.reject(new Error('decode'))), encode: vi.fn() }

    const error = await prepareUpload(fileOf('to.jpg', 'image/jpeg', 8 * MB), codec).catch((e) => e)

    expect(error).toBeInstanceOf(UploadRejectedError)
    expect(error.code).toBe('undecodable')
    expect(uploadRejectedMessage(error, t)).toBe(msg('Admin.postImages.uploadRejected.undecodable'))
  })

  it('releases the decoded image in every branch', async () => {
    const small = fakeCodec({ width: 1200, height: 800 })
    const big = fakeCodec({ width: 4000, height: 3000 }, [6 * MB])

    await prepareUpload(fileOf('a.jpg', 'image/jpeg', 1 * MB), small.codec)
    await prepareUpload(fileOf('b.jpg', 'image/jpeg', 9 * MB), big.codec).catch(() => {})

    // A 4000×3000 ImageBitmap holds ~48 MB; picking an image a few times without close() runs
    // the phone out of memory.
    expect(small.close).toHaveBeenCalledTimes(1)
    expect(big.close).toHaveBeenCalledTimes(1)
  })
})
