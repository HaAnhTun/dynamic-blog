// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  markContactMessageRead: vi.fn(),
  deleteContactMessage: vi.fn(),
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
import { markContactRead, removeContactMessage } from './actions'
import { msg } from '@/test/render-intl'

const ID = '11111111-1111-1111-1111-111111111111'

afterEach(() => vi.clearAllMocks())

describe('contact inbox actions', () => {
  it('mark as read: sends the id to the backend, revalidates the inbox, returns null', async () => {
    api.markContactMessageRead.mockResolvedValue(null)

    expect(await markContactRead(ID)).toBeNull()

    expect(api.markContactMessageRead).toHaveBeenCalledWith(ID)
    expect(revalidatePath).toHaveBeenCalledWith('/admin/contact')
  })

  it('delete: sends the id to the backend, revalidates the inbox, returns null', async () => {
    api.deleteContactMessage.mockResolvedValue(null)

    expect(await removeContactMessage(ID)).toBeNull()

    expect(api.deleteContactMessage).toHaveBeenCalledWith(ID)
    expect(revalidatePath).toHaveBeenCalledWith('/admin/contact')
  })

  it('a message that is already gone (404 CONTACT_MESSAGE_NOT_FOUND) counts as done for both actions', async () => {
    const gone = new ApiError(404, 'CONTACT_MESSAGE_NOT_FOUND', 'Contact message not found')
    api.markContactMessageRead.mockRejectedValueOnce(gone)
    api.deleteContactMessage.mockRejectedValueOnce(gone)

    expect(await markContactRead(ID)).toBeNull()
    expect(await removeContactMessage(ID)).toBeNull()
    expect(revalidatePath).toHaveBeenCalledTimes(2)
  })

  it('any other 404 (not the "no such message" answer) stays an error and revalidates nothing', async () => {
    api.deleteContactMessage.mockRejectedValue(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist'))

    expect(await removeContactMessage(ID)).toEqual({
      error: msg('Errors.admin.refusedDetail', { detail: 'The requested endpoint does not exist' }),
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('403 (an AUTHOR, or a stale token): the sentence in place, no redirect, nothing revalidated', async () => {
    api.markContactMessageRead.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    expect(await markContactRead(ID)).toEqual({ error: msg('Errors.admin.codes.FORBIDDEN') })
    expect(redirect).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('session expired: redirects to the login page; network down: the "cannot connect" message', async () => {
    api.markContactMessageRead.mockRejectedValueOnce(new SessionExpiredError())
    await expect(markContactRead(ID)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.deleteContactMessage.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await removeContactMessage(ID)).toEqual({ error: msg('Errors.admin.unreachable') })
    log.mockRestore()
  })

  it('is a use-server file', () => {
    const source = readFileSync(fileURLToPath(new URL('./actions.ts', import.meta.url)), 'utf8')

    expect(source.trimStart().startsWith("'use server'")).toBe(true)
  })
})
