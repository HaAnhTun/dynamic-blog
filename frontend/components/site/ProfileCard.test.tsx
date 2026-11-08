import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'
import { currentTestLocale, translatorFor } from '@/test/intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'

const rawMsg = (key: string) => (translatorFor(currentTestLocale()) as unknown as { raw(key: string): string }).raw(key)
const withDate = (key: string, date: string) => rawMsg(key).replace('<time>{date}</time>', date)
const JOINED_WORD = rawMsg('Site.profileCard.joined').split(' <')[0]!

/**
 * Like AccountMenu.test.tsx: real session store, fake `fetch`, module reloaded for each test.
 */
const nav = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/profile',
  useRouter: () => ({ replace: nav.replace }),
}))

const READER: SessionUser = {
  displayName: 'Alice Reader',
  githubLogin: 'doc-gia',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
  role: 'USER',
  // 20:00 UTC on the 1st is 03:00 on the 2nd in UTC+7 (the TZ of the test suite): the printed date must be the 1st.
  joinedAt: '2026-10-01T20:00:00Z',
  canAccessAdmin: false,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>
let logoutAnswer: () => Promise<Response>

beforeEach(() => {
  nav.replace.mockReset()
  logoutAnswer = () => Promise.resolve(new Response(null, { status: 204 }))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mount(user: SessionUser | null | 'pending') {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/session') {
      return user === 'pending' ? new Promise<Response>(() => {}) : Promise.resolve(json(200, { data: user }))
    }
    if (url === '/api/auth/logout') return logoutAnswer()
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.resetModules()
  const { ProfileCard } = await import('./ProfileCard')
  const view = render(<ProfileCard />)
  if (user !== 'pending') {
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await act(async () => {})
  }
  return view
}

describe('ProfileCard', () => {
  it('while asking the session: an empty aria-busy frame, no user data at all', async () => {
    const { container } = await mount('pending')

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('guest: "You are not signed in." and a GitHub link returning to /profile', async () => {
    await mount(null)

    expect(screen.getByText(msg('Site.profileCard.anonymous'))).toBeInTheDocument()
    const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fprofile')
    expect(link).toHaveAttribute('rel', 'nofollow')
    expect(screen.queryByRole('button', { name: msg('Site.account.signOut') })).toBeNull()
  })

  it('signed in: 64px avatar, name in <bdi>, @login to GitHub, join date in UTC', async () => {
    const { container } = await mount(READER)

    const img = container.querySelector('img')!
    // The person\'s own GitHub image, at the fixed 128 px size that Avatar asks for everywhere.
    expect(img).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/42?v=4&s=128')
    expect(img).toHaveAttribute('width', '64')

    const heading = screen.getByRole('heading', { level: 2, name: 'Alice Reader' })
    expect(heading.querySelector('bdi')).toHaveTextContent('Alice Reader')

    const github = screen.getByRole('link', { name: '@doc-gia' })
    expect(github).toHaveAttribute('href', 'https://github.com/doc-gia')
    expect(github.getAttribute('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer'])

    const time = container.querySelector('time')!
    expect(time).toHaveAttribute('dateTime', READER.joinedAt)
    expect(time.parentElement).toHaveTextContent(withDate('Site.profileCard.joined', LONG_DATE_VI(1, 10, 2026)))

    expect(screen.getByRole('button', { name: msg('Site.account.signOut') })).toBeInTheDocument()
  })

  it('the login in the GitHub URL is always encoded', async () => {
    await mount({ ...READER, githubLogin: 'a b/c?d' })

    expect(screen.getByRole('link', { name: '@a b/c?d' })).toHaveAttribute('href', 'https://github.com/a%20b%2Fc%3Fd')
  })

  it('login null: no GitHub link, no "@", no "null"', async () => {
    const { container } = await mount({ ...READER, githubLogin: null })

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).not.toContain('@')
    expect(container.textContent).not.toContain('null')
  })

  it('an unreadable join date drops the whole line, not printing "Invalid Date"', async () => {
    const { container } = await mount({ ...READER, joinedAt: 'not a date' })

    expect(container.textContent).not.toContain(JOINED_WORD)
    expect(container.textContent).not.toContain('Invalid')
  })

  it('sign out: POST /api/auth/logout then back to the home page', async () => {
    await mount(READER)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.account.signOut') }))
    })

    expect(fetchMock.mock.calls.find(([url]) => url === '/api/auth/logout')?.[1]).toMatchObject({ method: 'POST' })
    await waitFor(() => expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/'))
  })

  it('sign-out fails: reports the error, stays on the profile, does not navigate', async () => {
    logoutAnswer = () => Promise.resolve(json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } }))
    await mount(READER)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.account.signOut') }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.account.signOutFailed'))
    expect(screen.getByRole('heading', { level: 2, name: 'Alice Reader' })).toBeInTheDocument()
    expect(nav.replace).not.toHaveBeenCalled()
    expect(
      within(screen.getByRole('button', { name: msg('Site.account.signOut') }).parentElement!).getByRole('alert'),
    ).toBeInTheDocument()
  })
})
