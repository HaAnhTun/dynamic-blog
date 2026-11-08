import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'

const { getMfaStatus, adminRole, redirect, router } = vi.hoisted(() => ({
  getMfaStatus: vi.fn(),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  router: { refresh: vi.fn(), replace: vi.fn() },
}))
vi.mock('@/lib/admin-api', () => ({
  getMfaStatus,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect, useRouter: () => router, usePathname: () => '/admin/security' }))

import { SessionExpiredError } from '@/lib/admin-api'
import SecurityPage, { generateMetadata } from './page'

const t = (key: string, values?: Record<string, string | number>) => msg(`Admin.security.${key}`, values)

const STATUS = {
  enrolled: true,
  required: true,
  recoveryCodesRemaining: 10,
  hasPassword: true,
  passwordManagedByEnvironment: false,
}

beforeEach(() => {
  getMfaStatus.mockReset()
  adminRole.mockReset()
  adminRole.mockResolvedValue('ADMIN')
  redirect.mockClear()
})

describe('Admin Security page', () => {
  it('titles the page', async () => {
    await expect(generateMetadata()).resolves.toEqual({ title: t('title') })
  })

  it('shows the heading, the lead and the three cards from the status of the backend', async () => {
    getMfaStatus.mockResolvedValue(STATUS)

    renderWithIntl(await SecurityPage())

    expect(screen.getByRole('heading', { level: 1, name: t('title') })).toBeInTheDocument()
    expect(screen.getByText(t('lead'))).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: t('mfaTitle') })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: t('password.title') })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: t('signOutEverywhere') })).toBeInTheDocument()
    expect(screen.getByText(t('recoveryLeft', { count: 10 }))).toBeInTheDocument()
  })

  it('draws an author with the author controls: Turn off is there', async () => {
    adminRole.mockResolvedValue('AUTHOR')
    getMfaStatus.mockResolvedValue({ ...STATUS, hasPassword: false })

    renderWithIntl(await SecurityPage())

    expect(screen.getByRole('button', { name: t('turnOff') })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: t('password.title') })).toBeNull()
  })

  it('draws an administrator without Turn off', async () => {
    getMfaStatus.mockResolvedValue(STATUS)

    renderWithIntl(await SecurityPage())

    expect(screen.queryByRole('button', { name: t('turnOff') })).toBeNull()
  })

  it('a dead session goes to the sign-in, like every admin page', async () => {
    getMfaStatus.mockRejectedValue(new SessionExpiredError())

    await expect(SecurityPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('any other failure is the shell error page: it is rethrown, not swallowed', async () => {
    getMfaStatus.mockRejectedValue(new TypeError('fetch failed'))

    await expect(SecurityPage()).rejects.toThrow('fetch failed')
    expect(redirect).not.toHaveBeenCalled()
  })
})
