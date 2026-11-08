import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))

import { ApiError } from './api'
import { SessionExpiredError } from './admin-api'
import { adminRole, isAdminRole, verifiedAdminRole } from './admin-role'

function token(role: string | null): string {
  const payload = Buffer.from(JSON.stringify(role === null ? {} : { role })).toString('base64url')
  return `e30.${payload}.sig`
}

describe('admin-role', () => {
  afterEach(() => cookieStore.get.mockReset())

  it('only ADMIN and AUTHOR are roles of /admin', () => {
    expect(isAdminRole('ADMIN')).toBe(true)
    expect(isAdminRole('AUTHOR')).toBe(true)
    for (const role of ['USER', 'admin', 'SUPERUSER', null]) expect(isAdminRole(role)).toBe(false)
  })

  it.each([
    ['ADMIN', 'ADMIN'],
    ['AUTHOR', 'AUTHOR'],
    ['USER', null],
    [null, null],
  ])('claim %s cho %s', async (role, expected) => {
    cookieStore.get.mockReturnValue({ value: token(role) })
    expect(await adminRole()).toBe(expected)
  })

  it('null when there is no cookie', async () => {
    cookieStore.get.mockReturnValue(undefined)
    expect(await adminRole()).toBeNull()
  })
})

describe('verifiedAdminRole (the role the BACKEND holds, not the claim of the cookie)', () => {
  afterEach(() => {
    cookieStore.get.mockReset()
    vi.restoreAllMocks()
  })

  function me(status: number, body: unknown) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      )
  }

  it.each([
    ['ADMIN', 'ADMIN'],
    ['AUTHOR', 'AUTHOR'],
    ['USER', null],
  ])('asks GET /auth/me with the caller token and answers %s as %s', async (role, expected) => {
    cookieStore.get.mockReturnValue({ value: 'the.access.token' })
    const fetchSpy = me(200, { data: { role } })

    expect(await verifiedAdminRole()).toBe(expected)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/v1/auth/me')
    expect(init.method ?? 'GET').toBe('GET')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer the.access.token')
    expect(init.cache).toBe('no-store')
  })

  it('a role claim the backend does not confirm gives nothing: an unsigned token that says ADMIN is a 401 there', async () => {
    cookieStore.get.mockReturnValue({ value: token('ADMIN') })
    me(401, { error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } })

    await expect(verifiedAdminRole()).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('no cookie: no session, and the backend is not called', async () => {
    cookieStore.get.mockReturnValue(undefined)
    const fetchSpy = me(200, { data: { role: 'ADMIN' } })

    await expect(verifiedAdminRole()).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a suspended account (403) has no admin role; any other failure is passed on', async () => {
    cookieStore.get.mockReturnValue({ value: token('ADMIN') })
    me(403, { error: { code: 'USER_SUSPENDED', message: 'Suspended' } })
    expect(await verifiedAdminRole()).toBeNull()

    me(503, { error: { code: 'UNAVAILABLE', message: 'Down' } })
    await expect(verifiedAdminRole()).rejects.toMatchObject({ status: 503 })
    await expect(verifiedAdminRole()).rejects.toBeInstanceOf(ApiError)
  })

  it('a reply without a role is no role', async () => {
    cookieStore.get.mockReturnValue({ value: token('ADMIN') })
    me(200, { data: {} })

    expect(await verifiedAdminRole()).toBeNull()
  })
})
