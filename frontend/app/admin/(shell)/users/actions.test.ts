// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ setUserStatus: vi.fn(), setUserRole: vi.fn(), resetAuthorMfa: vi.fn() }))
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
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))

import { updateTag } from 'next/cache'
import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { changeUserRole, resetUserMfa, suspendUser, unsuspendUser } from './actions'
import { msg } from '@/test/render-intl'

const ID = '22222222-2222-2222-2222-222222222222'
const user = { id: ID, displayName: 'Octo Cat', githubLogin: 'octocat', role: 'USER', status: 'SUSPENDED' }

afterEach(() => vi.clearAllMocks())

describe('suspend / unsuspend / change role actions', () => {
  it('sends the exact status to the backend, returns the account as the backend stored it', async () => {
    api.setUserStatus.mockResolvedValueOnce(user)
    api.setUserStatus.mockResolvedValueOnce({ ...user, status: 'ACTIVE' })

    expect(await suspendUser(ID)).toEqual(user)
    expect(await unsuspendUser(ID)).toEqual({ ...user, status: 'ACTIVE' })
    expect(api.setUserStatus.mock.calls).toEqual([
      [ID, 'SUSPENDED'],
      [ID, 'ACTIVE'],
    ])
  })

  it('account is not a reader (409) or no longer exists (404): the specified message', async () => {
    api.setUserStatus.mockRejectedValueOnce(new ApiError(409, 'USER_NOT_SUSPENDABLE', 'Only reader accounts'))
    api.setUserStatus.mockRejectedValueOnce(new ApiError(404, 'USER_NOT_FOUND', 'User not found: x'))

    expect(await suspendUser(ID)).toEqual({ error: msg('Errors.admin.codes.USER_NOT_SUSPENDABLE') })
    expect(await unsuspendUser(ID)).toEqual({ error: msg('Errors.admin.codes.USER_NOT_FOUND') })
  })

  it('change role: sends the exact id and role to the backend; LAST_ADMIN becomes a Vietnamese message, not a thrown error', async () => {
    api.setUserRole.mockResolvedValueOnce({ ...user, role: 'AUTHOR' })
    api.setUserRole.mockRejectedValueOnce(new ApiError(409, 'LAST_ADMIN', 'The site must keep at least one active administrator'))

    expect(await changeUserRole(ID, 'AUTHOR', '123456')).toEqual({ ...user, role: 'AUTHOR' })
    expect(await changeUserRole(ID, 'USER')).toEqual({
      error: msg('Errors.admin.codes.LAST_ADMIN'),
    })
    // The administrator's own code travels with the role when the screen asked for one (audit 111), and only then.
    expect(api.setUserRole.mock.calls).toEqual([
      [ID, 'AUTHOR', '123456'],
      [ID, 'USER', undefined],
    ])
  })

  it('change role: a wrong code, an old sign-in, a frozen second step and a delay come back as their sentences', async () => {
    for (const [status, code] of [
      [401, 'MFA_CODE_INVALID'],
      [401, 'REAUTHENTICATION_REQUIRED'],
      [429, 'MFA_RATE_LIMITED'],
      [403, 'MFA_FROZEN'],
    ] as const) {
      api.setUserRole.mockRejectedValueOnce(new ApiError(status, code, 'x'))
      expect(await changeUserRole(ID, 'ADMIN', '000000'), code).toEqual({ error: msg(`Errors.admin.codes.${code}`) })
    }
  })

  it('session expired: redirects to the login page', async () => {
    api.setUserStatus.mockRejectedValue(new SessionExpiredError())

    await expect(suspendUser(ID)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('a successful suspend and unsuspend refresh the users tag (public profiles); a failure or a role change does not', async () => {
    api.setUserStatus.mockResolvedValueOnce(user)
    await suspendUser(ID)
    expect(updateTag).toHaveBeenCalledExactlyOnceWith('users')

    vi.mocked(updateTag).mockClear()
    api.setUserStatus.mockResolvedValueOnce({ ...user, status: 'ACTIVE' })
    await unsuspendUser(ID)
    expect(updateTag).toHaveBeenCalledExactlyOnceWith('users')

    vi.mocked(updateTag).mockClear()
    api.setUserStatus.mockRejectedValueOnce(new ApiError(409, 'USER_NOT_SUSPENDABLE', 'not a reader'))
    await suspendUser(ID)
    api.setUserRole.mockResolvedValueOnce({ ...user, role: 'AUTHOR' })
    await changeUserRole(ID, 'AUTHOR')
    expect(updateTag).not.toHaveBeenCalled()

    const source = readFileSync(fileURLToPath(new URL('./actions.ts', import.meta.url)), 'utf8')
    expect(source.trimStart().startsWith("'use server'")).toBe(true)
  })
})

describe('resetUserMfa', () => {
  it("sends the author id and the administrator's code and answers done", async () => {
    api.resetAuthorMfa.mockResolvedValueOnce(null)

    expect(await resetUserMfa(ID, '123456')).toEqual({ done: true })
    expect(api.resetAuthorMfa).toHaveBeenCalledWith(ID, '123456')
  })

  it.each([
    ['a wrong code', 401, 'MFA_CODE_INVALID'],
    ['a sign-in that is too old', 401, 'REAUTHENTICATION_REQUIRED'],
    ['a delay', 429, 'MFA_RATE_LIMITED'],
    ['a frozen second step', 403, 'MFA_FROZEN'],
  ])('%s comes back as its own sentence, never the backend text', async (_name, status, code) => {
    api.resetAuthorMfa.mockRejectedValueOnce(new ApiError(status, code, 'English text that must not be shown'))

    const outcome = await resetUserMfa(ID, '000000')

    expect(outcome).toEqual({ error: msg(`Errors.admin.codes.${code}`) })
  })

  it('a dead session goes to the sign-in, like every other action of the page', async () => {
    api.resetAuthorMfa.mockRejectedValueOnce(new SessionExpiredError())

    await expect(resetUserMfa(ID, '123456')).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('does not refresh the cached public data: nothing a reader sees changes', async () => {
    api.resetAuthorMfa.mockResolvedValueOnce(null)

    await resetUserMfa(ID, '123456')

    expect(updateTag).not.toHaveBeenCalled()
  })
})
