// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  releaseNewsletterIssue: vi.fn(),
  discardNewsletterIssue: vi.fn(),
}))
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
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
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('next/cache', () => ({ revalidatePath }))

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { discardHeldIssue, releaseHeldIssue } from './actions'
import { msg } from '@/test/render-intl'

const ID = '11111111-1111-1111-1111-111111111111'
const VERSION = 'a1b2c3'

afterEach(() => vi.clearAllMocks())

describe('newsletter approval actions', () => {
  it('release: sends the post id and the version that was read, revalidates the page, returns null', async () => {
    api.releaseNewsletterIssue.mockResolvedValue(null)

    expect(await releaseHeldIssue(ID, VERSION)).toBeNull()

    expect(api.releaseNewsletterIssue).toHaveBeenCalledWith(ID, VERSION)
    expect(revalidatePath).toHaveBeenCalledWith('/admin/newsletter')
  })

  it('discard: sends the post id to the backend, revalidates the page, returns null', async () => {
    api.discardNewsletterIssue.mockResolvedValue(null)

    expect(await discardHeldIssue(ID)).toBeNull()

    expect(api.discardNewsletterIssue).toHaveBeenCalledWith(ID)
    expect(revalidatePath).toHaveBeenCalledWith('/admin/newsletter')
  })

  it('a newsletter that is not waiting any more: the catalog sentence, and the page is refreshed to show what is left', async () => {
    api.releaseNewsletterIssue.mockRejectedValue(new ApiError(404, 'NEWSLETTER_ISSUE_NOT_FOUND', 'No held newsletter'))

    expect(await releaseHeldIssue(ID, VERSION)).toEqual({ error: msg('Errors.admin.codes.NEWSLETTER_ISSUE_NOT_FOUND') })
    expect(revalidatePath).toHaveBeenCalledWith('/admin/newsletter')
  })

  it('a post that changed since the list was loaded: the catalog sentence, and the page is refreshed to show the new text', async () => {
    api.releaseNewsletterIssue.mockRejectedValue(new ApiError(409, 'NEWSLETTER_ISSUE_CHANGED', 'The post changed'))

    expect(await releaseHeldIssue(ID, VERSION)).toEqual({ error: msg('Errors.admin.codes.NEWSLETTER_ISSUE_CHANGED') })
    expect(revalidatePath).toHaveBeenCalledWith('/admin/newsletter')
  })

  it('403 (an AUTHOR, or a stale token): the sentence in place, no redirect, nothing revalidated', async () => {
    api.discardNewsletterIssue.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    expect(await discardHeldIssue(ID)).toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
    expect(redirect).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('an expired session goes to the login page', async () => {
    api.releaseNewsletterIssue.mockRejectedValue(new SessionExpiredError())

    await expect(releaseHeldIssue(ID, VERSION)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})
