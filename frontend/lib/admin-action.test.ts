// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// `redirect` is replaced by a function that throws like the real one (the real one throws NEXT_REDIRECT), the rest
// of next/navigation stays as is: the real `unstable_rethrow` must recognize Next's control-flow errors,
// and that is exactly what one test below checks.
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
// admin-api reads cookies at call time, not at import time, but mock it to be safe: this test only
// needs the real SessionExpiredError class, and the network must never be called.
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }))

import { msg, translatorFor } from '@/test/intl'
import { ApiError } from './api'
import { SessionExpiredError } from './admin-api'
import { adminErrorMessage, reorderErrorMessage, runAdminAction, runEditorAction } from './admin-action'

const t = translatorFor('vi', 'Errors.admin')

describe('runAdminAction', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('returns the result unchanged on success', async () => {
    await expect(runAdminAction(async () => ({ id: 'p1', slug: 's' }))).resolves.toEqual({ id: 'p1', slug: 's' })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('expired session: redirects to the login page, not swallowed silently', async () => {
    // The old editor bug: `guard` rethrew SessionExpiredError with the promise that "the page will
    // redirect", but the page's catch only runs at render time. In an action, that error reaches the
    // client as a rejected promise nobody handles: no message, no
    // navigation. With redirect() in an action the client-side router navigates by itself.
    const result = runAdminAction(() => Promise.reject(new SessionExpiredError()))

    await expect(result).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('API error: returns a Vietnamese {error} to show in place, no redirect', async () => {
    const result = await runAdminAction(() =>
      Promise.reject(new ApiError(415, 'MEDIA_UNSUPPORTED_TYPE', 'Unsupported image type')),
    )

    expect(result).toEqual({ error: msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE') })
    // Pair of the test above: only an expired session redirects. If a 403 were sent back to login,
    // the author would sign in successfully and be rejected again: a loop.
    expect(redirect).not.toHaveBeenCalled()
  })

  it('403 is never treated as an expired session', async () => {
    const result = await runAdminAction(() =>
      Promise.reject(new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that')),
    )

    expect(result).toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('other error (backend down, fetch failed): reports no connection, and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('fetch failed')

    const result = await runAdminAction(() => Promise.reject(cause))

    expect(result).toEqual({ error: msg('Errors.admin.unreachable') })
    // The user gets a generic message, so the original error must survive somewhere: a programming error
    // in the action also lands in this branch, and without a log nobody would find it.
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('lets Next control-flow errors through: redirect() inside fn still redirects', async () => {
    // Real example: the "create series then go to the edit page" action calls redirect() inside fn. Catching
    // that error as an ordinary error would mean the author reads the "cannot connect to the server" message after creation succeeded.
    const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation')

    const result = runAdminAction(async () => actual.redirect('/admin/series/abc'))

    await expect(result).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;/) })
  })

  it('lets notFound() inside fn through', async () => {
    const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation')

    const result = runAdminAction(async () => actual.notFound())

    await expect(result).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) })
  })
})

describe('runEditorAction (post editor action)', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('returns the result unchanged on success', async () => {
    await expect(runEditorAction(async () => ({ id: 'p1' }))).resolves.toEqual({ id: 'p1' })
  })

  it('expired session: in-place error with the sessionExpired flag, NO redirect (redirecting would lose the post being written)', async () => {
    const result = await runEditorAction(() => Promise.reject(new SessionExpiredError()))

    expect(result).toEqual({ error: msg('Errors.admin.sessionExpired'), sessionExpired: true })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('API error: Vietnamese sentence, via the translator passed in if any', async () => {
    const quota = new ApiError(422, 'MEDIA_QUOTA_EXCEEDED', 'Media storage quota exceeded')

    await expect(runEditorAction(() => Promise.reject(quota))).resolves.toEqual({ error: adminErrorMessage(quota, t) })
    await expect(
      runEditorAction(
        () => Promise.reject(quota),
        () => 'custom sentence',
      ),
    ).resolves.toEqual({ error: 'custom sentence' })
  })

  it('other error: "could not reach the server", with the original error logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new TypeError('fetch failed')

    await expect(runEditorAction(() => Promise.reject(cause))).resolves.toEqual({
      error: msg('Errors.admin.unreachable'),
    })
    expect(log).toHaveBeenCalledWith(expect.any(String), cause)
  })

  it('lets redirect() inside fn through', async () => {
    const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation')

    await expect(runEditorAction(async () => actual.redirect('/admin/posts/p2/edit'))).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT;/),
    })
  })
})

describe('runAdminAction for the save-order action', () => {
  afterEach(() => vi.clearAllMocks())

  it.each([
    ['VALIDATION_ERROR', 'postIds must be a permutation'],
    ['POST_NOT_FOUND', 'Post not found'],
    ['GALLERY_PHOTO_NOT_FOUND', 'Gallery photo not found'],
  ])('400 %s → tells the user to reload the page, because the submitted list is stale', async (code, message) => {
    // Stale tab, or another tab just added/removed: the backend rejects a permutation that is no longer exact with 400.
    const result = await runAdminAction(() => Promise.reject(new ApiError(400, code, message)), reorderErrorMessage)

    expect(result).toEqual({ error: msg('Errors.admin.staleList') })
  })

  it('non-400 errors still follow the shared table', async () => {
    // Pair of the test above: a series deleted in another tab gives 404, and the "reload the page" sentence for it would
    // lead to a 404 page without saying why.
    const result = await runAdminAction(
      () => Promise.reject(new ApiError(404, 'SERIES_NOT_FOUND', 'Series not found')),
      reorderErrorMessage,
    )

    expect(result).toEqual({ error: adminErrorMessage(new ApiError(404, 'SERIES_NOT_FOUND', ''), t) })
  })

  it('without a translator, 400 keeps the generic message, not "reload the page"', async () => {
    const result = await runAdminAction(() => Promise.reject(new ApiError(400, 'VALIDATION_ERROR', 'title must not be blank')))

    expect(result).toEqual({ error: msg('Errors.admin.invalidDetail', { detail: 'title must not be blank' }) })
  })

  it('the translator does not change the expired session path', async () => {
    await expect(runAdminAction(() => Promise.reject(new SessionExpiredError()), reorderErrorMessage)).rejects.toThrow(
      'NEXT_REDIRECT',
    )
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('adminErrorMessage', () => {
  it.each([
    ['MEDIA_TOO_LARGE', 413, msg('Errors.admin.codes.MEDIA_TOO_LARGE')],
    ['MEDIA_UNSUPPORTED_TYPE', 415, msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE')],
    ['MEDIA_UNREADABLE', 422, msg('Errors.admin.codes.MEDIA_UNREADABLE')],
    ['MEDIA_DIMENSIONS_TOO_LARGE', 422, msg('Errors.admin.codes.MEDIA_DIMENSIONS_TOO_LARGE')],
    ['MEDIA_QUOTA_EXCEEDED', 422, msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED')],
    ['MEDIA_BUSY', 503, msg('Errors.admin.codes.MEDIA_BUSY')],
    ['MEDIA_NOT_FOUND', 404, msg('Errors.admin.codes.MEDIA_NOT_FOUND')],
    ['POST_NOT_FOUND', 404, msg('Errors.admin.codes.POST_NOT_FOUND')],
    ['SERIES_NOT_FOUND', 404, msg('Errors.admin.codes.SERIES_NOT_FOUND')],
    ['SERIES_ALREADY_EXISTS', 409, msg('Errors.admin.codes.SERIES_ALREADY_EXISTS')],
    ['GALLERY_PHOTO_NOT_FOUND', 404, msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND')],
    ['FORBIDDEN', 403, msg('Errors.admin.codes.FORBIDDEN')],
    ['POST_NOT_PUBLISHABLE', 422, msg('Errors.admin.codes.POST_NOT_PUBLISHABLE')],
    ['CATEGORY_ALREADY_EXISTS', 409, msg('Errors.admin.codes.CATEGORY_ALREADY_EXISTS')],
    ['TAG_ALREADY_EXISTS', 409, msg('Errors.admin.codes.TAG_ALREADY_EXISTS')],
    ['CATEGORY_NOT_FOUND', 400, msg('Errors.admin.codes.CATEGORY_NOT_FOUND')],
    ['TAG_NOT_FOUND', 400, msg('Errors.admin.codes.TAG_NOT_FOUND')],
    ['RESOURCE_CONFLICT', 409, msg('Errors.admin.codes.RESOURCE_CONFLICT')],
    ['TRANSLATION_CONFLICT', 409, msg('Errors.admin.codes.TRANSLATION_CONFLICT')],
    // Moderation and user management: exactly the sentences of the design.
    ['COMMENT_NOT_FOUND', 404, msg('Errors.admin.codes.COMMENT_NOT_FOUND')],
    ['USER_NOT_FOUND', 404, msg('Errors.admin.codes.USER_NOT_FOUND')],
    ['USER_NOT_SUSPENDABLE', 409, msg('Errors.admin.codes.USER_NOT_SUSPENDABLE')],
    // Role change.
    ['LAST_ADMIN', 409, msg('Errors.admin.codes.LAST_ADMIN')],
    ['SITE_OWNER_PROTECTED', 409, msg('Errors.admin.codes.SITE_OWNER_PROTECTED')],
    ['ROLE_TARGET_SUSPENDED', 409, msg('Errors.admin.codes.ROLE_TARGET_SUSPENDED')],
    ['RATE_LIMITED', 429, msg('Errors.admin.codes.RATE_LIMITED')],
    // Author applications.
    ['AUTHOR_APPLICATION_NOT_FOUND', 404, msg('Errors.admin.codes.AUTHOR_APPLICATION_NOT_FOUND')],
    ['AUTHOR_APPLICATION_PENDING', 409, msg('Errors.admin.codes.AUTHOR_APPLICATION_PENDING')],
    ['AUTHOR_APPLICATION_COOLDOWN', 409, msg('Errors.admin.codes.AUTHOR_APPLICATION_COOLDOWN')],
    ['AUTHOR_APPLICATION_NOT_ALLOWED', 409, msg('Errors.admin.codes.AUTHOR_APPLICATION_NOT_ALLOWED')],
    ['AUTHOR_APPLICATION_DECIDED', 409, msg('Errors.admin.codes.AUTHOR_APPLICATION_DECIDED')],
    // Post history: the backend only keeps 20 versions, older ones are pruned.
    ['REVISION_NOT_FOUND', 404, msg('Errors.admin.codes.REVISION_NOT_FOUND')],
    // Post import: the codes whose backend message holds only counts.
    ['POST_IMPORT_HASH_MISMATCH', 409, msg('Errors.admin.codes.POST_IMPORT_HASH_MISMATCH')],
    ['POST_IMPORT_PREVIEW_OUT_OF_DATE', 409, msg('Errors.admin.codes.POST_IMPORT_PREVIEW_OUT_OF_DATE')],
    ['POST_IMPORT_NOTHING_TO_UNDO', 404, msg('Errors.admin.codes.POST_IMPORT_NOTHING_TO_UNDO')],
    ['POST_IMPORT_UNDO_CONFLICT', 409, msg('Errors.admin.codes.POST_IMPORT_UNDO_CONFLICT')],
    ['POST_IMPORT_MEDIA_QUOTA_EXCEEDED', 422, msg('Errors.admin.codes.POST_IMPORT_MEDIA_QUOTA_EXCEEDED')],
    ['POST_IMPORT_MEDIA_BUSY', 503, msg('Errors.admin.codes.POST_IMPORT_MEDIA_BUSY')],
  ])('%s → Vietnamese message', (code, status, expected) => {
    const message = adminErrorMessage(new ApiError(status, code, 'English message from the backend'), t)

    expect(message).toBe(expected)
    expect(message).not.toContain('English message')
  })

  it('VALIDATION_ERROR: Vietnamese sentence, with the specific backend reason that a generic sentence would lose', () => {
    // The "yes" pair of the "does not contain" asserts above: the reason (e.g. which field is wrong) still reaches the user,
    // but is never the whole English message.
    expect(adminErrorMessage(new ApiError(400, 'VALIDATION_ERROR', 'title must not be blank'), t)).toBe(
      msg('Errors.admin.invalidDetail', { detail: 'title must not be blank' }),
    )
  })

  it.each(['POST_IMPORT_INVALID_FILE', 'POST_IMPORT_INVALID'])(
    '%s keeps the backend reason, which names the file by position and the line',
    (code) => {
      expect(adminErrorMessage(new ApiError(400, code, 'File 3: line 12 has a control character'), t)).toBe(
        msg('Errors.admin.refusedDetail', { detail: 'File 3: line 12 has a control character' }),
      )
    },
  )

  it('unknown code (4xx): generic Vietnamese sentence, with the backend reason', () => {
    expect(adminErrorMessage(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist'), t)).toBe(
      msg('Errors.admin.refusedDetail', { detail: 'The requested endpoint does not exist' }),
    )
    expect(adminErrorMessage(new ApiError(400, undefined, 'Bad thing'), t)).toBe(
      msg('Errors.admin.refusedDetail', { detail: 'Bad thing' }),
    )
  })

  it('reason built by admin-api itself (leaks the API path) or empty: only the Vietnamese sentence remains', () => {
    expect(adminErrorMessage(new ApiError(400, 'VALIDATION_ERROR', 'API responded 400 for /api/v1/admin/posts'), t)).toBe(
      msg('Errors.admin.invalid'),
    )
    expect(adminErrorMessage(new ApiError(409, undefined, 'API responded 409 for /api/v1/admin/series'), t)).toBe(
      msg('Errors.admin.refused'),
    )
    expect(adminErrorMessage(new ApiError(400, 'VALIDATION_ERROR', '   '), t)).toBe(msg('Errors.admin.invalid'))
  })

  it('reason too long is truncated, the message does not become a page of text', () => {
    const message = adminErrorMessage(new ApiError(400, 'VALIDATION_ERROR', 'x'.repeat(5000)), t)

    expect(message.startsWith(msg('Errors.admin.invalidDetail', { detail: '' }))).toBe(true)
    expect(message.length).toBeLessThan(250)
    expect(message.endsWith('…')).toBe(true)
  })

  it('server error without a known code: Vietnamese sentence, does not leak the internal API path', () => {
    const message = adminErrorMessage(new ApiError(502, undefined, 'API responded 502 for /api/v1/admin/gallery'), t)

    expect(message).toBe(msg('Errors.admin.serverError'))
  })
})
