// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { putSectionRow, restoreRevisionRow, importDocumentText, uploadAvatarFile, requestSampleContent, redirect } = vi.hoisted(
  () => ({
    putSectionRow: vi.fn(),
    restoreRevisionRow: vi.fn(),
    importDocumentText: vi.fn(),
    uploadAvatarFile: vi.fn(),
    requestSampleContent: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
    }),
  }),
)
vi.mock('@/lib/admin-site-content', () => ({ putSectionRow, restoreRevisionRow, importDocumentText, uploadAvatarFile }))
vi.mock('@/lib/admin-sample-content', () => ({ requestSampleContent }))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
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
import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { importDocument, loadSampleContent, restoreRevision, saveSection, uploadAvatar } from './actions'
import { msg } from '@/test/render-intl'

const SITE = { name: 'A site', tagline: '', positioning: '' }
const saved = { key: 'site', locale: 'en', schemaVersion: 1, updatedAt: '2026-10-11T00:00:00Z', payload: SITE }

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('saveSection', () => {
  it('sends the payload, clears the site-content tag once and returns the saved row', async () => {
    putSectionRow.mockResolvedValue(saved)

    const result = await saveSection('site', 'en', SITE)

    expect(putSectionRow).toHaveBeenCalledWith('site', 'en', SITE)
    expect(updateTag).toHaveBeenCalledTimes(1)
    expect(updateTag).toHaveBeenCalledWith('site-content')
    expect(result).toEqual({ saved: true, payload: SITE, updatedAt: saved.updatedAt })
  })

  it('rejects an unknown key, an unknown locale or a payload that is not an object before calling the backend', async () => {
    const expected = { error: msg('Admin.settings.errors.badArguments') }

    await expect(saveSection('users', 'en', SITE)).resolves.toEqual(expected)
    await expect(saveSection('site', 'fr', SITE)).resolves.toEqual(expected)
    await expect(saveSection('site', 'en', [SITE])).resolves.toEqual(expected)
    await expect(saveSection('site', 'en', null)).resolves.toEqual(expected)
    expect(putSectionRow).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('SITE_CONTENT_INVALID comes back with the parsed problems and clears nothing', async () => {
    putSectionRow.mockRejectedValue(
      new ApiError(400, 'SITE_CONTENT_INVALID', '/social/1/url: must be an https or mailto URL; /blurb: too long'),
    )

    const result = await saveSection('contact', 'en', {})

    expect(result).toEqual({
      error: msg('Admin.settings.errors.invalid'),
      problems: [
        { pointer: '/social/1/url', reason: 'must be an https or mailto URL' },
        { pointer: '/blurb', reason: 'too long' },
      ],
    })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('other errors follow the common table; an expired session goes to login', async () => {
    putSectionRow.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    await expect(saveSection('site', 'en', SITE)).resolves.toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })

    putSectionRow.mockRejectedValueOnce(new SessionExpiredError())
    await expect(saveSection('site', 'en', SITE)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('restoreRevision', () => {
  it('restores, clears the tag and returns the restored payload', async () => {
    restoreRevisionRow.mockResolvedValue(saved)

    await expect(restoreRevision('site', 'en', 7)).resolves.toEqual({ saved: true, payload: SITE, updatedAt: saved.updatedAt })

    expect(restoreRevisionRow).toHaveBeenCalledWith('site', 'en', 7)
    expect(updateTag).toHaveBeenCalledWith('site-content')
  })

  it('refuses a bad id without calling the backend, and a failed restore clears nothing', async () => {
    await expect(restoreRevision('site', 'en', 0)).resolves.toEqual({ error: msg('Admin.settings.errors.badArguments') })
    await expect(restoreRevision('site', 'en', 1.5)).resolves.toEqual({ error: msg('Admin.settings.errors.badArguments') })
    expect(restoreRevisionRow).not.toHaveBeenCalled()

    restoreRevisionRow.mockRejectedValue(new ApiError(404, 'SITE_CONTENT_REVISION_NOT_FOUND', 'gone'))
    await expect(restoreRevision('site', 'en', 3)).resolves.toHaveProperty('error')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('importDocument', () => {
  const formWith = (content: string, name = 'site-content-en.json') => {
    const form = new FormData()
    form.append('file', new File([content], name, { type: 'application/json' }))
    return form
  }

  it('sends the file text as it is and clears the tag on success', async () => {
    const result = { locale: 'en', sections: [{ key: 'site', status: 'created' }] }
    importDocumentText.mockResolvedValue(result)
    const text = JSON.stringify({ format: 'site-content', formatVersion: 1, locale: 'en', sections: {} })

    await expect(importDocument(formWith(text))).resolves.toEqual(result)

    expect(importDocumentText).toHaveBeenCalledWith(text)
    expect(updateTag).toHaveBeenCalledWith('site-content')
  })

  it('refuses a missing file, a file that is not a JSON object or too large, without calling the backend', async () => {
    await expect(importDocument(new FormData())).resolves.toEqual({ error: msg('Admin.settings.errors.noFile') })
    await expect(importDocument(formWith('not json'))).resolves.toEqual({ error: msg('Admin.settings.errors.notJson') })
    await expect(importDocument(formWith('[1]'))).resolves.toEqual({ error: msg('Admin.settings.errors.notJson') })
    await expect(importDocument(formWith(' '.repeat(512 * 1024 + 1)))).resolves.toEqual({
      error: msg('Admin.settings.errors.fileTooLarge'),
    })
    expect(importDocumentText).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('a refused document returns its problems and clears nothing', async () => {
    importDocumentText.mockRejectedValue(
      new ApiError(400, 'SITE_CONTENT_INVALID', '/sections/site/payload/name: must not be blank'),
    )

    const result = await importDocument(formWith('{}'))

    expect(result).toMatchObject({ problems: [{ pointer: '/sections/site/payload/name', reason: 'must not be blank' }] })
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('uploadAvatar', () => {
  it('returns the media URL and clears no cache (the profile is not saved yet)', async () => {
    uploadAvatarFile.mockResolvedValue({ url: '/media/0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.jpg' })
    const form = new FormData()
    form.append('file', new File(['x'], 'me.jpg', { type: 'image/jpeg' }))

    await expect(uploadAvatar(form)).resolves.toEqual({ url: '/media/0b8d6b2e-1d3f-4a52-9a8e-3f7a5b0f2c11.jpg' })

    expect(updateTag).not.toHaveBeenCalled()
  })

  it('refuses a missing file without calling the backend', async () => {
    await expect(uploadAvatar(new FormData())).resolves.toEqual({ error: msg('Admin.settings.errors.noFile') })
    expect(uploadAvatarFile).not.toHaveBeenCalled()
  })
})

describe('loadSampleContent', () => {
  it('clears every tag the posts, series and taxonomy feed on success and returns the counts', async () => {
    const result = { posts: 4, series: 1, categories: 1, tags: 2, skipped: 0 }
    requestSampleContent.mockResolvedValue(result)

    await expect(loadSampleContent()).resolves.toEqual(result)

    const cleared = vi.mocked(updateTag).mock.calls.map(([tag]) => tag)
    expect(cleared).toEqual(['posts', 'series', 'categories', 'tags', 'search'])
  })

  it('a refusal comes back as an error in place and clears nothing', async () => {
    requestSampleContent.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))

    await expect(loadSampleContent()).resolves.toHaveProperty('error')
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('an expired session goes to the login page and clears nothing', async () => {
    requestSampleContent.mockRejectedValue(new SessionExpiredError())

    await expect(loadSampleContent()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})
