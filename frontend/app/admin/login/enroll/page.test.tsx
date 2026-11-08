import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  usePathname: () => '/admin/login/enroll',
}))
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import EnrollPage from './page'

function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/admin/login/enroll'> {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) }
}

const enroll = (key: string) => msg(`Admin.login.enroll.${key}`)

beforeEach(() => {
  redirect.mockClear()
  cookieStore.get.mockReset()
})

describe('Admin sign-in enrollment page', () => {
  it('without a challenge cookie it goes back to the sign-in', async () => {
    cookieStore.get.mockReturnValue(undefined)

    await expect(EnrollPage(props())).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('shows the heading, the lead and the button that starts the enrollment', async () => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    renderWithIntl(await EnrollPage(props()))

    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1, name: enroll('title') })).toBeInTheDocument()
    expect(within(main).getByText(enroll('lead'))).toBeInTheDocument()
    expect(within(main).getByRole('button', { name: enroll('start') })).toBeInTheDocument()
    // The enrollment code is asked only when the sign-in said so.
    expect(screen.queryByLabelText(enroll('enrollmentCode'))).toBeNull()
  })

  it('?code=1 asks for the enrollment code first, with the hint where it is found', async () => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    renderWithIntl(await EnrollPage(props({ code: '1' })))

    expect(screen.getByLabelText(enroll('enrollmentCode'))).toBeInTheDocument()
    expect(screen.getByText(enroll('enrollmentCodeHint'))).toBeInTheDocument()
  })

  it.each([['0'], ['yes'], ['']])('?code=%j is not the hint', async (code) => {
    cookieStore.get.mockReturnValue({ value: 'challenge' })

    renderWithIntl(await EnrollPage(props({ code })))

    expect(screen.queryByLabelText(enroll('enrollmentCode'))).toBeNull()
  })
})
