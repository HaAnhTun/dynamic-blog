// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same mould as posts/cover-actions.test.ts: spies via vi.hoisted, SessionExpiredError is a subclass
// of the real ApiError, runAdminAction is NOT mocked (its three error branches are what these actions
// must go through).
const { uploadGalleryPhoto, updateGalleryPhoto, deleteGalleryPhoto, reorderGallery, redirect } = vi.hoisted(() => ({
  uploadGalleryPhoto: vi.fn(),
  updateGalleryPhoto: vi.fn(),
  deleteGalleryPhoto: vi.fn(),
  reorderGallery: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    uploadGalleryPhoto,
    updateGalleryPhoto,
    deleteGalleryPhoto,
    reorderGallery,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { updateTag } from 'next/cache'
import { ApiError } from '@/lib/api'
import { SessionExpiredError } from '@/lib/admin-api'
import { MAX_UPLOAD_BYTES } from '@/lib/prepare-upload'
import type { GalleryPhotoAdmin } from '@/lib/types'
import { removePhoto, saveOrder, savePhoto, uploadPhoto } from './actions'
import { msg } from '@/test/render-intl'

const STALE_LIST_MESSAGE = msg('Errors.admin.staleList')

const photo = (id: string, over: Partial<GalleryPhotoAdmin> = {}): GalleryPhotoAdmin => ({
  id,
  image: {
    id: `m-${id}`,
    fileName: `${id}.jpg`,
    width: 2400,
    height: 1600,
    altText: 'Lake in the morning',
    dominantColor: '#6a7b8c',
  },
  caption: null,
  takenOn: null,
  published: true,
  sortOrder: 0,
  originalFilename: 'IMG_0001.jpg',
  byteSize: 123_456,
  createdAt: '2026-10-06T01:00:00Z',
  updatedAt: '2026-10-06T01:00:00Z',
  ...over,
})

const jpeg = (bytes: number, name = 'IMG_0001.jpg') => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })

function uploadForm(file: unknown, fields: Record<string, string> = { altText: 'Lake in the morning' }): FormData {
  const form = new FormData()
  if (file !== undefined) form.append('file', file as Blob)
  for (const [name, value] of Object.entries(fields)) form.append(name, value)
  return form
}

/**
 * Two tags for every gallery write: 'gallery' (the /gallery page, the photo feed on the home page and About)
 * and 'stats' (stats.galleryPhotos decides whether the photo section shows and whether /gallery is in the
 * sitemap). Without 'stats' the first uploaded photo does not show on the home page for up to 300 seconds.
 */
function expectGalleryAndStatsInvalidated() {
  expect(updateTag).toHaveBeenCalledWith('gallery')
  expect(updateTag).toHaveBeenCalledWith('stats')
  expect(updateTag).toHaveBeenCalledTimes(2)
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('uploadPhoto', () => {
  it('sends the exact file and fields, clears the gallery + stats cache, returns the photo the backend stored', async () => {
    const saved = photo('p1', { caption: 'West Lake', takenOn: '2026-09-14', published: false })
    uploadGalleryPhoto.mockResolvedValue(saved)

    const result = await uploadPhoto(
      uploadForm(jpeg(1200), { altText: 'Lake in the morning', caption: 'West Lake', takenOn: '2026-09-14', published: 'false' }),
    )

    expect(uploadGalleryPhoto).toHaveBeenCalledWith(expect.any(File), {
      altText: 'Lake in the morning',
      caption: 'West Lake',
      takenOn: '2026-09-14',
      published: false,
    })
    expect((uploadGalleryPhoto.mock.calls[0][0] as File).size).toBe(1200)
    expectGalleryAndStatsInvalidated()
    expect(result).toEqual(saved)
  })

  it('empty date and caption fields → null (not sent: the backend takes the taken date from EXIF); visible defaults to on', async () => {
    uploadGalleryPhoto.mockResolvedValue(photo('p1'))

    await uploadPhoto(uploadForm(jpeg(10), { altText: 'Lake', caption: '   ', takenOn: '' }))

    // "Left blank" keeps the meaning "let the backend read EXIF": null, then admin-api does not send that field.
    expect(uploadGalleryPhoto).toHaveBeenCalledWith(expect.any(File), {
      altText: 'Lake',
      caption: null,
      takenOn: null,
      published: true,
    })
  })

  it.each([
    ['missing file part', undefined],
    ['empty file (an empty file input sends a File of size 0)', new File([], '', { type: 'application/octet-stream' })],
    ['a string instead of a File', 'khong-phai-file'],
  ])('%s → {error}, no API call', async (_case, file) => {
    const result = await uploadPhoto(uploadForm(file))

    expect(result).toEqual({ error: msg('Admin.gallery.errors.noFile') })
    expect(uploadGalleryPhoto).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('a file over 4 MB (MAX_UPLOAD_BYTES) → {error}; exactly 4 MB is still sent', async () => {
    // The browser already shrank it to ≤ 4 MB; a larger file reaching here means the client skipped that step.
    const tooBig = await uploadPhoto(uploadForm(jpeg(MAX_UPLOAD_BYTES + 1)))
    expect(tooBig).toEqual({ error: expect.stringMatching(/4 MB/) })
    expect(uploadGalleryPhoto).not.toHaveBeenCalled()

    // The "present" counterpart: the exact limit still passes (the same `<=` comparison as prepare-upload).
    uploadGalleryPhoto.mockResolvedValue(photo('p1'))
    await expect(uploadPhoto(uploadForm(jpeg(MAX_UPLOAD_BYTES)))).resolves.toEqual(photo('p1'))
  })

  it.each([
    ['no description field', {}],
    ['description of whitespace only', { altText: '   ' }],
  ])('%s → {error} asking for a photo description, no API call', async (_case, fields) => {
    // The description is the accessible name of the photo cell on /gallery: required, checked here too because
    // an action is an endpoint anyone can POST to.
    const result = await uploadPhoto(uploadForm(jpeg(10), fields))

    expect(result).toEqual({ error: msg('Admin.gallery.errors.altRequired') })
    expect(uploadGalleryPhoto).not.toHaveBeenCalled()
  })

  it('malformed taken date → {error}, no API call', async () => {
    const result = await uploadPhoto(uploadForm(jpeg(10), { altText: 'Lake', takenOn: '14/09/2026' }))

    expect(result).toEqual({ error: msg('Admin.gallery.errors.badDate') })
    expect(uploadGalleryPhoto).not.toHaveBeenCalled()
  })

  it('API error → a Vietnamese {error} in place, no cache clearing', async () => {
    uploadGalleryPhoto.mockRejectedValue(new ApiError(415, 'MEDIA_UNSUPPORTED_TYPE', 'Unsupported image type'))

    const result = await uploadPhoto(uploadForm(jpeg(10)))

    expect(result).toEqual({ error: msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE') })
    expect(updateTag).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('session expired midway → redirects to the login page, not silent', async () => {
    uploadGalleryPhoto.mockRejectedValue(new SessionExpiredError())

    await expect(uploadPhoto(uploadForm(jpeg(10)))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('savePhoto', () => {
  it('replace everything: empty fields become null, keeps the visibility flag; clears the gallery + stats cache', async () => {
    const saved = photo('p1', { published: false })
    updateGalleryPhoto.mockResolvedValue(saved)

    const result = await savePhoto('p1', { altText: 'Lake', caption: '', takenOn: '', published: false })

    expect(updateGalleryPhoto).toHaveBeenCalledWith('p1', {
      altText: 'Lake',
      caption: null,
      takenOn: null,
      published: false,
    })
    // Hiding/showing a photo changes stats.galleryPhotos: hiding the last photo must make the photo section disappear.
    expectGalleryAndStatsInvalidated()
    expect(result).toEqual(saved)
  })

  it('sends the caption and date when present', async () => {
    updateGalleryPhoto.mockResolvedValue(photo('p1'))

    await savePhoto('p1', { altText: 'Lake', caption: 'West Lake', takenOn: '2026-09-14', published: true })

    expect(updateGalleryPhoto).toHaveBeenCalledWith('p1', {
      altText: 'Lake',
      caption: 'West Lake',
      takenOn: '2026-09-14',
      published: true,
    })
  })

  it('empty description → {error}, no API call', async () => {
    const result = await savePhoto('p1', { altText: ' ', caption: '', takenOn: '', published: true })

    expect(result).toEqual({ error: msg('Admin.gallery.errors.altRequired') })
    expect(updateGalleryPhoto).not.toHaveBeenCalled()
  })

  it('missing visibility flag → {error}: "replace everything" must not guess hidden or visible', async () => {
    const result = await savePhoto('p1', { altText: 'Lake', caption: '', takenOn: '' } as never)

    expect(result).toEqual({ error: expect.any(String) })
    expect(updateGalleryPhoto).not.toHaveBeenCalled()
  })

  it('photo already deleted in another tab (404 GALLERY_PHOTO_NOT_FOUND) → {error}', async () => {
    updateGalleryPhoto.mockRejectedValue(new ApiError(404, 'GALLERY_PHOTO_NOT_FOUND', 'Gallery photo not found'))

    const result = await savePhoto('p1', { altText: 'Lake', caption: '', takenOn: '', published: true })

    expect(result).toEqual({ error: msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → redirects to the login page', async () => {
    updateGalleryPhoto.mockRejectedValue(new SessionExpiredError())

    await expect(savePhoto('p1', { altText: 'x', caption: '', takenOn: '', published: true })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('removePhoto', () => {
  it('after deleting returns null and clears the gallery + stats cache', async () => {
    deleteGalleryPhoto.mockResolvedValue(null)

    const result = await removePhoto('p1')

    expect(deleteGalleryPhoto).toHaveBeenCalledWith('p1')
    expect(result).toBeNull()
    expectGalleryAndStatsInvalidated()
  })

  it('API error → {error}, no cache clearing', async () => {
    deleteGalleryPhoto.mockRejectedValue(new ApiError(404, 'GALLERY_PHOTO_NOT_FOUND', 'Gallery photo not found'))

    await expect(removePhoto('p1')).resolves.toEqual({ error: msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → redirects to the login page', async () => {
    deleteGalleryPhoto.mockRejectedValue(new SessionExpiredError())

    await expect(removePhoto('p1')).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('saveOrder', () => {
  it('sends the id list in order as is, clears the cache, returns the list the backend stored', async () => {
    const saved = [photo('b', { sortOrder: 1 }), photo('a', { sortOrder: 2 })]
    reorderGallery.mockResolvedValue(saved)

    const result = await saveOrder(['b', 'a'])

    expect(reorderGallery).toHaveBeenCalledWith(['b', 'a'])
    expectGalleryAndStatsInvalidated()
    expect(result).toEqual(saved)
  })

  it.each([
    ['not a full permutation (VALIDATION_ERROR)', 'VALIDATION_ERROR', 'photoIds must list every gallery photo exactly once'],
    ['unknown id (GALLERY_PHOTO_NOT_FOUND)', 'GALLERY_PHOTO_NOT_FOUND', 'Gallery photo not found: x'],
  ])('400 %s → tells to reload the page, no cache clearing', async (_case, code, message) => {
    // Stale tab: a photo was just uploaded or deleted elsewhere. The only fix is to reload.
    reorderGallery.mockRejectedValue(new ApiError(400, code, message))

    await expect(saveOrder(['a', 'b'])).resolves.toEqual({ error: STALE_LIST_MESSAGE })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('backend down → a generic {error}, not the "reload the page" message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    reorderGallery.mockRejectedValue(new TypeError('fetch failed'))

    await expect(saveOrder(['a'])).resolves.toEqual({ error: msg('Errors.admin.unreachable') })
  })

  it('session expired → redirects to the login page', async () => {
    reorderGallery.mockRejectedValue(new SessionExpiredError())

    await expect(saveOrder(['a'])).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})
