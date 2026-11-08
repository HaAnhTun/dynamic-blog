import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const set = vi.fn()
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }))
const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT ${path}`)
})
vi.mock('next/navigation', () => ({ redirect: (path: string) => redirect(path) }))

import { setAdminLocale } from './language-action'

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

async function submit(fields: Record<string, string>): Promise<string> {
  await expect(setAdminLocale(form(fields))).rejects.toThrow(/NEXT_REDIRECT/)
  return redirect.mock.calls.at(-1)![0]
}

beforeEach(() => {
  set.mockReset()
  redirect.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('setAdminLocale', () => {
  it('stores a known language in the admin_locale cookie for a year and returns to the page', async () => {
    const target = await submit({ locale: 'en', returnTo: '/admin/series' })

    expect(set).toHaveBeenCalledWith(
      'admin_locale',
      'en',
      expect.objectContaining({ path: '/', sameSite: 'lax', maxAge: 31_536_000 }),
    )
    expect(target).toBe('/admin/series')
  })

  it('marks the cookie secure only in production, like the session cookies', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await submit({ locale: 'vi', returnTo: '/admin' })
    expect(set.mock.calls[0]![2]).toMatchObject({ secure: true })

    vi.stubEnv('NODE_ENV', 'development')
    await submit({ locale: 'vi', returnTo: '/admin' })
    expect(set.mock.calls[1]![2]).toMatchObject({ secure: false })
  })

  it('rejects an unknown language: no cookie, still goes back', async () => {
    for (const locale of ['fr', '', 'EN', '../en']) {
      const target = await submit({ locale, returnTo: '/admin/series' })
      expect(target).toBe('/admin/series')
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('a missing language changes nothing', async () => {
    expect(await submit({ returnTo: '/admin' })).toBe('/admin')
    expect(set).not.toHaveBeenCalled()
  })

  it.each([
    ['https://evil.example/admin'],
    ['//evil.example'],
    ['/admin//evil.example'],
    ['/administrator'],
    ['/admin/../api/x'],
    ['/admin/%2e%2e/x'],
    ['/admin' + String.fromCharCode(92) + 'evil'],
    ['/posts/x'],
    [''],
    ['/admin/' + 'a'.repeat(600)],
  ])('an off-site or non-admin returnTo %j goes to /admin', async (returnTo) => {
    expect(await submit({ locale: 'en', returnTo })).toBe('/admin')
  })

  it('keeps the login page and a query string inside the admin', async () => {
    expect(await submit({ locale: 'en', returnTo: '/admin/login' })).toBe('/admin/login')
    expect(await submit({ locale: 'en', returnTo: '/admin?page=2' })).toBe('/admin?page=2')
  })
})
