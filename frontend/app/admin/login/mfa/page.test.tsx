import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { msg, renderWithIntl } from '@/test/render-intl'

const { redirect, cookieStore } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  cookieStore: { get: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/login/mfa',
}))
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import MfaPage from './page'

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/admin/login/mfa'> {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) }
}

const mfa = (key: string) => msg(`Admin.login.mfa.${key}`)

beforeEach(() => {
  redirect.mockClear()
  cookieStore.get.mockReset()
})

describe('Admin sign-in code page', () => {
  it('without a challenge cookie there is no sign-in in progress: it goes back to the sign-in, keeping the destination', async () => {
    cookieStore.get.mockReturnValue(undefined)

    await expect(MfaPage(props())).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    redirect.mockClear()
    await expect(MfaPage(props({ next: '/admin/security' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login?next=/admin/security')
  })

  it('an empty cookie counts as none', async () => {
    cookieStore.get.mockReturnValue({ value: '' })

    await expect(MfaPage(props())).rejects.toThrow('NEXT_REDIRECT')
  })

  it('reads the challenge cookie by name', async () => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    await MfaPage(props())

    expect(cookieStore.get).toHaveBeenCalledWith('mfa_challenge')
  })

  it('with a challenge it shows the site name, the heading, the code field and the way back, in the light admin frame', async () => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    const { container } = renderWithIntl(await MfaPage(props()))

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveClass('min-h-screen', 'bg-slate-50', 'text-slate-900', '[color-scheme:light]')
    expect(wrapper).toHaveAttribute('data-admin')
    const main = screen.getByRole('main')
    expect(within(main).getByText(defaultSiteContent(DEFAULT_LOCALE).site.name)).toBeInTheDocument()
    expect(within(main).getByRole('heading', { level: 1, name: mfa('title') })).toBeInTheDocument()
    expect(within(main).getByLabelText(mfa('code'))).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: mfa('back') })).toHaveAttribute('href', '/admin/login')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('keeps an admin destination for the way back and ignores any other', async () => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    renderWithIntl(await MfaPage(props({ next: '/admin/security' })))
    expect(screen.getByRole('link', { name: mfa('back') })).toHaveAttribute('href', '/admin/login?next=/admin/security')
  })

  it('a foreign destination is not followed', async () => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    renderWithIntl(await MfaPage(props({ next: '//evil.example' })))

    expect(screen.getByRole('link', { name: mfa('back') })).toHaveAttribute('href', '/admin/login')
  })
})
