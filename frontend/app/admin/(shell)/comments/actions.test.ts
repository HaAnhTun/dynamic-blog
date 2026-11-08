// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Spies via vi.hoisted (same mould as topics/actions.test.ts): the vi.mock factory runs before every const.
const api = vi.hoisted(() => ({
  setCommentStatus: vi.fn(),
  deleteAdminComment: vi.fn(),
}))
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
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
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { deleteComment, hideComment, restoreComment } from './actions'
import { msg } from '@/test/render-intl'

const ID = '11111111-1111-1111-1111-111111111111'
const comment = { id: ID, status: 'HIDDEN', content: 'Spam' }

afterEach(() => vi.clearAllMocks())

describe('comment moderation actions', () => {
  it('hide and show again: sends the exact status to the backend, returns the comment as the backend stored it', async () => {
    api.setCommentStatus.mockResolvedValueOnce(comment)
    api.setCommentStatus.mockResolvedValueOnce({ ...comment, status: 'VISIBLE' })

    expect(await hideComment(ID)).toEqual(comment)
    expect(await restoreComment(ID)).toEqual({ ...comment, status: 'VISIBLE' })
    expect(api.setCommentStatus.mock.calls).toEqual([
      [ID, 'HIDDEN'],
      [ID, 'VISIBLE'],
    ])
  })

  it('delete: null means deleted', async () => {
    api.deleteAdminComment.mockResolvedValue(null)

    expect(await deleteComment(ID)).toBeNull()
    expect(api.deleteAdminComment).toHaveBeenCalledWith(ID)
  })

  it('comment no longer exists (404): the specified message, in place', async () => {
    api.deleteAdminComment.mockRejectedValue(new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found: x'))

    expect(await deleteComment(ID)).toEqual({ error: msg('Errors.interaction.byCode.COMMENT_NOT_FOUND') })
  })

  it('409 on hide/show again: says the comment just changed state elsewhere, not the generic "duplicate name" message', async () => {
    api.setCommentStatus.mockRejectedValue(
      new ApiError(409, 'RESOURCE_CONFLICT', 'A deleted comment cannot be hidden or restored'),
    )

    const result = await hideComment(ID)

    expect(result).toEqual({ error: msg('Errors.admin.commentStatusChanged') })
    expect(JSON.stringify(result)).not.toContain(msg('Errors.admin.codes.RESOURCE_CONFLICT'))
    expect(JSON.stringify(result)).not.toMatch(/deleted comment/)
  })

  it('session expired: redirects to the login page; network down: the "cannot connect" message', async () => {
    api.setCommentStatus.mockRejectedValueOnce(new SessionExpiredError())
    await expect(restoreComment(ID)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.deleteAdminComment.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await deleteComment(ID)).toEqual({ error: msg('Errors.admin.unreachable') })
    log.mockRestore()
  })

  it('refreshes no cache: comments are not in cached public data', () => {
    // Reads the source rather than spying on next/cache: if the file does not import next/cache any spy is "never
    // called", and the test would stay green even if someone added updateTag through another module.
    const source = readFileSync(fileURLToPath(new URL('./actions.ts', import.meta.url)), 'utf8')

    expect(source).not.toMatch(/from 'next\/cache'/)
    expect(source).not.toMatch(/\b(updateTag|revalidateTag|revalidatePath|refresh)\(/)
    expect(source.trimStart().startsWith("'use server'")).toBe(true)
  })
})
