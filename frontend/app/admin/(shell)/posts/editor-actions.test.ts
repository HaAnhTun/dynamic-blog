// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * Editor actions. Mocks follow the mould of actions.test.ts and cover-actions.test.ts:
 * spies via vi.hoisted, SessionExpiredError is a subclass of the real ApiError so the real runEditorAction recognises it.
 * runEditorAction and redirect() are NOT mocked: the error path and the real redirect target are what is checked.
 */
const api = vi.hoisted(() => ({
  createPost: vi.fn(),
  createPostTranslation: vi.fn(),
  linkPostTranslation: vi.fn(),
  unlinkPostTranslation: vi.fn(),
  deletePostImage: vi.fn(),
  getAdminPost: vi.fn(),
  getPostRevision: vi.fn(),
  restorePostRevision: vi.fn(),
  uploadPostImage: vi.fn(),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    ...api,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { updateTag } from 'next/cache'
import { msg } from '@/test/intl'
import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { MAX_UPLOAD_BYTES } from '@/lib/prepare-upload'
import type { MediaRef, Post } from '@/lib/types'
import {
  createTranslationAction,
  duplicatePost,
  linkTranslationAction,
  loadRevision,
  unlinkTranslationAction,
  removeBodyImage,
  restoreRevision,
  uploadBodyImage,
} from './editor-actions'

const SESSION_EXPIRED = msg('Errors.admin.sessionExpired')

const IMAGE: MediaRef = {
  id: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d',
  fileName: '0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png',
  width: 1200,
  height: 800,
  altText: 'Diagram',
  dominantColor: null,
}

const SOURCE: Post = {
  id: 'p1',
  title: 'From API Gateway to SQS',
  slug: 'from-api-gateway-to-sqs',
  excerpt: 'Why I chose async.',
  status: 'PUBLISHED',
  category: { id: 'c1', name: 'Architecture', slug: 'architecture', description: null },
  tags: [
    { id: 't1', name: 'AWS', slug: 'aws' },
    { id: 't2', name: 'SQS', slug: 'sqs' },
  ],
  featured: true,
  featuredRank: 1,
  readingMinutes: 4,
  publishedAt: '2026-10-01T00:00:00Z',
  content: '## Intro\n\n![Diagram](/media/0b9d6f3a-5c1e-4f7a-9d2b-3e4f5a6b7c8d.png)\n',
  cover: IMAGE,
  series: { id: 's1', slug: 'pipeline', title: 'Pipeline', position: 1, partNumber: 1, partCount: 2 },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
}

function formWith(file: unknown, altText?: string): FormData {
  const form = new FormData()
  if (file !== undefined) form.append('file', file as Blob)
  if (altText !== undefined) form.append('altText', altText)
  return form
}

const png = (bytes: number) => new File([new Uint8Array(bytes)], 'so-do.png', { type: 'image/png' })

/** The target of the real redirect(): `NEXT_REDIRECT;<push|replace>;<url>;<code>;`. */
async function redirectOf(call: Promise<unknown>): Promise<{ kind: string; url: string }> {
  const error = await call.then(
    () => {
      throw new Error('action returned instead of redirecting')
    },
    (caught: unknown) => caught,
  )
  const [marker, kind, url] = ((error as { digest?: string }).digest ?? '').split(';')
  expect(marker).toBe('NEXT_REDIRECT')
  return { kind, url }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('uploadBodyImage', () => {
  it('sends the file and description, returns the image for the editor to insert; clears no cache (no post points to the image yet)', async () => {
    api.uploadPostImage.mockResolvedValue(IMAGE)

    const result = await uploadBodyImage('p1', formWith(png(1200), 'Diagram'))

    expect(api.uploadPostImage).toHaveBeenCalledWith('p1', expect.any(File), 'Diagram')
    expect((api.uploadPostImage.mock.calls[0][1] as File).size).toBe(1200)
    expect(result).toEqual({ image: IMAGE })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it.each([
    ['missing file', undefined],
    ['empty file', new File([], '', { type: 'application/octet-stream' })],
    ['a string instead of a File', 'khong-phai-file'],
  ])('%s → {error}, no API call', async (_case, file) => {
    await expect(uploadBodyImage('p1', formWith(file))).resolves.toEqual({ error: msg('Admin.posts.actions.noFile') })
    expect(api.uploadPostImage).not.toHaveBeenCalled()
  })

  it('over 4 MB (the client did not shrink it) → {error}; exactly 4 MB is still sent', async () => {
    await expect(uploadBodyImage('p1', formWith(png(MAX_UPLOAD_BYTES + 1)))).resolves.toEqual({
      error: expect.stringMatching(/4 MB/),
    })
    expect(api.uploadPostImage).not.toHaveBeenCalled()

    api.uploadPostImage.mockResolvedValue(IMAGE)
    await expect(uploadBodyImage('p1', formWith(png(MAX_UPLOAD_BYTES)))).resolves.toEqual({ image: IMAGE })
  })

  it('quota exceeded → a Vietnamese message in place', async () => {
    api.uploadPostImage.mockRejectedValue(new ApiError(422, 'MEDIA_QUOTA_EXCEEDED', 'Media storage quota exceeded'))

    await expect(uploadBodyImage('p1', formWith(png(10)))).resolves.toEqual({
      error: msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED'),
    })
  })

  it('wrong format, too large on the server → the Vietnamese message of the shared table', async () => {
    api.uploadPostImage.mockRejectedValueOnce(new ApiError(415, 'MEDIA_UNSUPPORTED_TYPE', 'Unsupported'))
    api.uploadPostImage.mockRejectedValueOnce(new ApiError(413, 'MEDIA_TOO_LARGE', 'Too large'))

    await expect(uploadBodyImage('p1', formWith(png(10)))).resolves.toEqual({
      error: msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE'),
    })
    await expect(uploadBodyImage('p1', formWith(png(10)))).resolves.toEqual({ error: msg('Errors.admin.codes.MEDIA_TOO_LARGE') })
  })

  it('session expired: an in-place error with the flag, NO redirect (the post being written is still on screen)', async () => {
    api.uploadPostImage.mockRejectedValue(new SessionExpiredError())

    await expect(uploadBodyImage('p1', formWith(png(10)))).resolves.toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
  })

  it('backend without the endpoint (404 ENDPOINT_NOT_FOUND): says plainly it is an old server, not an English reason', async () => {
    api.uploadPostImage.mockRejectedValue(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist'))

    const result = await uploadBodyImage('p1', formWith(png(10)))

    expect(result).toEqual({ error: msg('Admin.posts.actions.outdatedBackend') })
    expect(result).not.toEqual({ error: expect.stringContaining('endpoint') })
  })
})

describe('removeBodyImage', () => {
  it('deletes and returns the remaining images', async () => {
    api.deletePostImage.mockResolvedValue([])

    await expect(removeBodyImage('p1', IMAGE.id)).resolves.toEqual({ images: [] })
    expect(api.deletePostImage).toHaveBeenCalledWith('p1', IMAGE.id)
  })

  it('image already deleted elsewhere (404 MEDIA_NOT_FOUND) → a Vietnamese message', async () => {
    api.deletePostImage.mockRejectedValue(new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found'))

    await expect(removeBodyImage('p1', IMAGE.id)).resolves.toEqual({ error: msg('Errors.admin.codes.MEDIA_NOT_FOUND') })
  })
})

describe('loadRevision', () => {
  it('returns the revision to view', async () => {
    const revision = { id: 'r1', title: 'Old version', excerpt: null, content: 'old text', createdAt: '2026-10-01T00:00:00Z' }
    api.getPostRevision.mockResolvedValue(revision)

    await expect(loadRevision('p1', 'r1')).resolves.toEqual({ revision })
    expect(api.getPostRevision).toHaveBeenCalledWith('p1', 'r1')
  })

  it('a revision that was cleaned up (REVISION_NOT_FOUND) → a Vietnamese message', async () => {
    api.getPostRevision.mockRejectedValue(new ApiError(404, 'REVISION_NOT_FOUND', 'Revision not found'))

    await expect(loadRevision('p1', 'r9')).resolves.toEqual({ error: msg('Errors.admin.codes.REVISION_NOT_FOUND') })
  })
})

describe('restoreRevision', () => {
  it('after restoring: clears the list, post page (saved slug), search cache; then reopens the editor with a new key', async () => {
    api.restorePostRevision.mockResolvedValue({ ...SOURCE, slug: 'slug-da-luu' })

    const target = await redirectOf(restoreRevision('p1', 'r1'))

    expect(api.restorePostRevision).toHaveBeenCalledWith('p1', 'r1')
    expect(updateTag).toHaveBeenCalledWith('posts')
    expect(updateTag).toHaveBeenCalledWith('post-slug-da-luu')
    expect(updateTag).toHaveBeenCalledWith('search')
    // replace: Back does not reopen the edit page with the pre-restore text.
    expect(target.kind).toBe('replace')
    expect(target.url).toMatch(/^\/admin\/posts\/p1\/edit\?restored=[a-z0-9]+$/)
  })

  it('two restores give two different keys: the editor is always rebuilt', async () => {
    api.restorePostRevision.mockResolvedValue(SOURCE)
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValueOnce(1_000)
    const first = await redirectOf(restoreRevision('p1', 'r1'))
    now.mockReturnValueOnce(2_000)
    const second = await redirectOf(restoreRevision('p1', 'r1'))

    expect(first.url).not.toBe(second.url)
  })

  it('error: returns a message in place, no cache clearing, no redirect', async () => {
    api.restorePostRevision.mockRejectedValue(new ApiError(404, 'REVISION_NOT_FOUND', 'Revision not found'))

    await expect(restoreRevision('p1', 'r9')).resolves.toEqual({ error: msg('Errors.admin.codes.REVISION_NOT_FOUND') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired: an in-place error with the flag', async () => {
    api.restorePostRevision.mockRejectedValue(new SessionExpiredError())

    await expect(restoreRevision('p1', 'r1')).resolves.toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
  })
})

describe('duplicatePost', () => {
  it('reads the post, creates a new draft with the same text, category, tags; the title gets the "(copy)" suffix added, no slug; then opens the new post', async () => {
    api.getAdminPost.mockResolvedValue(SOURCE)
    api.createPost.mockResolvedValue({ ...SOURCE, id: 'p2', slug: 'from-api-gateway-to-sqs-copy', status: 'DRAFT' })

    const target = await redirectOf(duplicatePost('p1'))

    expect(api.getAdminPost).toHaveBeenCalledWith('p1')
    expect(api.createPost).toHaveBeenCalledWith({
      title: `From API Gateway to SQS ${msg('Admin.posts.actions.copySuffix')}`,
      content: SOURCE.content,
      excerpt: SOURCE.excerpt,
      categoryId: 'c1',
      tagIds: ['t1', 't2'],
    })
    // Cover image, series, "Featured posts" entries are not copied: createPost does not accept them, and there is no other call.
    expect(target.url).toBe('/admin/posts/p2/edit')
    // The new draft is in no public cache.
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('a post without category or description: sends undefined, not an empty string', async () => {
    api.getAdminPost.mockResolvedValue({ ...SOURCE, category: null, excerpt: null, tags: [] })
    api.createPost.mockResolvedValue({ ...SOURCE, id: 'p2' })

    await redirectOf(duplicatePost('p1'))

    expect(api.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: undefined, excerpt: undefined, tagIds: [] }),
    )
  })

  it('long title: trims the original part so the whole title (with the suffix) is not over 255 characters, never splitting an emoji in half', async () => {
    // 244 letters + 2 emoji = 248 UTF-16 units; the room left for the original part is 255 - 10 = 245, falling exactly in the middle of the first emoji.
    const long = `${'a'.repeat(244)}😀😀`
    api.getAdminPost.mockResolvedValue({ ...SOURCE, title: long })
    api.createPost.mockResolvedValue({ ...SOURCE, id: 'p2' })

    await redirectOf(duplicatePost('p1'))

    const title = (api.createPost.mock.calls[0][0] as { title: string }).title
    expect(title.length).toBeLessThanOrEqual(255)
    expect(title.endsWith(` ${msg('Admin.posts.actions.copySuffix')}`)).toBe(true)
    // No half surrogate pair left: the string re-encodes without a replacement character.
    expect(title).toBe(Buffer.from(title, 'utf8').toString('utf8'))
    expect(title).toBe(`${'a'.repeat(244)} ${msg('Admin.posts.actions.copySuffix')}`)
  })

  it('post no longer exists (404) → a Vietnamese message, nothing created', async () => {
    api.getAdminPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))

    await expect(duplicatePost('p1')).resolves.toEqual({ error: msg('Errors.admin.codes.POST_NOT_FOUND') })
    expect(api.createPost).not.toHaveBeenCalled()
  })

  it('session expired → an in-place error with the flag, no redirect', async () => {
    api.getAdminPost.mockRejectedValue(new SessionExpiredError())

    await expect(duplicatePost('p1')).resolves.toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
  })
})

describe('translation actions', () => {
  it('createTranslationAction creates the draft in that language and opens it; a blank slug is not sent', async () => {
    api.createPostTranslation.mockResolvedValue({ ...SOURCE, id: 'p2', status: 'DRAFT' })

    const target = await redirectOf(createTranslationAction('p1', 'en', '  '))

    expect(api.createPostTranslation).toHaveBeenCalledWith('p1', { language: 'en' })
    expect(target.url).toBe('/admin/posts/p2/edit')
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('createTranslationAction sends the trimmed slug', async () => {
    api.createPostTranslation.mockResolvedValue({ ...SOURCE, id: 'p2' })

    await redirectOf(createTranslationAction('p1', 'en', ' hello '))

    expect(api.createPostTranslation).toHaveBeenCalledWith('p1', { language: 'en', slug: 'hello' })
  })

  it('createTranslationAction refuses a language that is not an enabled locale without calling the API', async () => {
    await expect(createTranslationAction('p1', 'fr', '')).resolves.toEqual({
      error: msg('Admin.posts.translations.languageRequired'),
    })
    expect(api.createPostTranslation).not.toHaveBeenCalled()
  })

  it('createTranslationAction shows a 409 conflict in place, no redirect', async () => {
    api.createPostTranslation.mockRejectedValue(new ApiError(409, 'TRANSLATION_CONFLICT', 'Already has en'))

    await expect(createTranslationAction('p1', 'en', '')).resolves.toEqual({
      error: msg('Errors.admin.codes.TRANSLATION_CONFLICT'),
    })
  })

  it('createTranslationAction: a taken slug (409 RESOURCE_CONFLICT) is an in-place error', async () => {
    api.createPostTranslation.mockRejectedValue(new ApiError(409, 'RESOURCE_CONFLICT', 'slug taken'))

    await expect(createTranslationAction('p1', 'en', 'taken')).resolves.toEqual({
      error: msg('Errors.admin.codes.RESOURCE_CONFLICT'),
    })
  })

  it('createTranslationAction: session expired → in-place error with the flag', async () => {
    api.createPostTranslation.mockRejectedValue(new SessionExpiredError())

    await expect(createTranslationAction('p1', 'en', '')).resolves.toEqual({ error: SESSION_EXPIRED, sessionExpired: true })
  })

  it('linkTranslationAction links and clears the posts cache', async () => {
    api.linkPostTranslation.mockResolvedValue(SOURCE)

    await expect(linkTranslationAction('p1', 'p9')).resolves.toBeNull()

    expect(api.linkPostTranslation).toHaveBeenCalledWith('p1', 'p9')
    expect(updateTag).toHaveBeenCalledWith('posts')
  })

  it('linkTranslationAction: nothing chosen is an error without a call; a conflict is shown and clears nothing', async () => {
    await expect(linkTranslationAction('p1', '')).resolves.toEqual({ error: msg('Admin.posts.translations.pickPost') })
    expect(api.linkPostTranslation).not.toHaveBeenCalled()

    api.linkPostTranslation.mockRejectedValue(new ApiError(409, 'TRANSLATION_CONFLICT', 'conflict'))
    await expect(linkTranslationAction('p1', 'p9')).resolves.toEqual({ error: msg('Errors.admin.codes.TRANSLATION_CONFLICT') })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('unlinkTranslationAction unlinks and clears the posts cache; a failure is shown', async () => {
    api.unlinkPostTranslation.mockResolvedValue(null)
    await expect(unlinkTranslationAction('p1')).resolves.toBeNull()
    expect(api.unlinkPostTranslation).toHaveBeenCalledWith('p1')
    expect(updateTag).toHaveBeenCalledWith('posts')

    vi.mocked(updateTag).mockClear()
    api.unlinkPostTranslation.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'no'))
    await expect(unlinkTranslationAction('p1')).resolves.toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
    expect(updateTag).not.toHaveBeenCalled()
  })
})
