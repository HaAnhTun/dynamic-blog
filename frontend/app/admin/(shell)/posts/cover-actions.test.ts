// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mocks follow the mould of the neighbouring actions.test.ts: spies via vi.hoisted (the vi.mock factory is
// hoisted above every declaration), SessionExpiredError is a subclass of the real ApiError so the
// real runAdminAction recognises it. runAdminAction is NOT mocked: its three error branches are what
// these actions must go through, and a fake only proves the fake.
const { uploadPostCover, updatePostCoverAlt, deletePostCover, redirect } = vi.hoisted(() => ({
  uploadPostCover: vi.fn(),
  updatePostCoverAlt: vi.fn(),
  deletePostCover: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    uploadPostCover,
    updatePostCoverAlt,
    deletePostCover,
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
import type { MediaRef } from '@/lib/types'
import { removeCover, saveCoverAlt, uploadCover } from './cover-actions'
import { msg } from '@/test/render-intl'

const COVER: MediaRef = {
  id: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d',
  fileName: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.jpg',
  width: 2400,
  height: 1600,
  altText: 'Three tier diagram',
  dominantColor: '#4a5a6a',
}

/** The post the backend returns after each cover operation: the SAVED slug, possibly different from the slug at page render time. */
const postWith = (cover: MediaRef | null) => ({ id: 'p1', slug: 'saved-slug', cover, content: 'long post body…' })

function formWith(file: unknown, altText?: string): FormData {
  const form = new FormData()
  if (file !== undefined) form.append('file', file as Blob)
  if (altText !== undefined) form.append('altText', altText)
  return form
}

const jpeg = (bytes: number, name = 'bia.jpg') => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('uploadCover', () => {
  it('sends the exact file and description, clears the list and post page cache, returns the new cover', async () => {
    uploadPostCover.mockResolvedValue(postWith(COVER))
    const file = jpeg(1200)

    const result = await uploadCover('p1', formWith(file, 'Three tier diagram'))

    expect(uploadPostCover).toHaveBeenCalledWith('p1', expect.any(File), 'Three tier diagram')
    expect((uploadPostCover.mock.calls[0][1] as File).size).toBe(1200)
    // The cover shows in the list (thumbnail) and at the top of the post page: missing one of the two tags leaves that
    // place with the old image for up to 300 seconds. The post tag is built from the slug the backend RETURNS, with the very postTag
    // of lib/api.ts, like savePost: the slug at page render time may be stale.
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledWith('post-saved-slug')
    // Only the part the screen needs, not the whole post: the action result travels to the browser, and the post body
    // can be tens of KB.
    expect(result).toEqual({ cover: COVER })
  })

  it('with no description field in the form no description is sent', async () => {
    uploadPostCover.mockResolvedValue(postWith(COVER))

    await uploadCover('p1', formWith(jpeg(10)))

    expect(uploadPostCover).toHaveBeenCalledWith('p1', expect.any(File), undefined)
  })

  it.each([
    ['missing file part', undefined],
    ['empty file (an empty file input sends a File of size 0)', new File([], '', { type: 'application/octet-stream' })],
    ['a string instead of a File', 'khong-phai-file'],
  ])('%s → {error}, no API call', async (_case, file) => {
    const result = await uploadCover('p1', formWith(file))

    expect(result).toEqual({ error: msg('Admin.posts.actions.noFile') })
    expect(uploadPostCover).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('a file over 4 MB (MAX_UPLOAD_BYTES) → {error}; exactly 4 MB is still sent', async () => {
    // The browser already shrank it to ≤ 4 MB (lib/prepare-upload.ts). A larger file reaching here
    // means the client skipped that step; the backend would accept it up to 10 MB, so block it here.
    const tooBig = await uploadCover('p1', formWith(jpeg(MAX_UPLOAD_BYTES + 1)))
    expect(tooBig).toEqual({ error: expect.stringMatching(/4 MB/) })
    expect(uploadPostCover).not.toHaveBeenCalled()

    // The "present" counterpart: the exact limit still passes (the same `<=` comparison as prepare-upload).
    uploadPostCover.mockResolvedValue(postWith(COVER))
    await expect(uploadCover('p1', formWith(jpeg(MAX_UPLOAD_BYTES)))).resolves.toEqual({ cover: COVER })
  })

  it('API error → a Vietnamese {error} in place, no cache clearing', async () => {
    uploadPostCover.mockRejectedValue(new ApiError(415, 'MEDIA_UNSUPPORTED_TYPE', 'Unsupported image type'))

    const result = await uploadCover('p1', formWith(jpeg(10)))

    expect(result).toEqual({ error: msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE') })
    expect(updateTag).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('session expired midway → redirects to the login page, not silent', async () => {
    uploadPostCover.mockRejectedValue(new SessionExpiredError())

    await expect(uploadCover('p1', formWith(jpeg(10)))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('saveCoverAlt', () => {
  it('sends the description verbatim (the backend trims, empty becomes null) and returns the saved cover', async () => {
    updatePostCoverAlt.mockResolvedValue(postWith({ ...COVER, altText: 'New description' }))

    const result = await saveCoverAlt('p1', '  New description  ')

    expect(updatePostCoverAlt).toHaveBeenCalledWith('p1', '  New description  ')
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledWith('post-saved-slug')
    expect(result).toEqual({ cover: { ...COVER, altText: 'New description' } })
  })

  it('the cover was removed in another tab (404 MEDIA_NOT_FOUND) → {error}', async () => {
    updatePostCoverAlt.mockRejectedValue(new ApiError(404, 'MEDIA_NOT_FOUND', 'Post has no cover image'))

    await expect(saveCoverAlt('p1', 'x')).resolves.toEqual({ error: msg('Errors.admin.codes.MEDIA_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → redirects to the login page', async () => {
    updatePostCoverAlt.mockRejectedValue(new SessionExpiredError())

    await expect(saveCoverAlt('p1', 'x')).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('removeCover', () => {
  it('after removing returns cover null and clears exactly three tags: list, post page, search results', async () => {
    deletePostCover.mockResolvedValue(postWith(null))

    const result = await removeCover('p1')

    expect(deletePostCover).toHaveBeenCalledWith('p1')
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledWith('post-saved-slug')
    // Search results show the post's thumbnail: without this tag it points to a just-deleted image.
    expect(updateTag).toHaveBeenCalledWith('search')
    expect(updateTag).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ cover: null })
  })

  it('backend down → a generic {error}, no throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deletePostCover.mockRejectedValue(new TypeError('fetch failed'))

    await expect(removeCover('p1')).resolves.toEqual({ error: msg('Errors.admin.unreachable') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → redirects to the login page', async () => {
    deletePostCover.mockRejectedValue(new SessionExpiredError())

    await expect(removeCover('p1')).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})
