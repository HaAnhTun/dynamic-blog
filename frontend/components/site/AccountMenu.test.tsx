import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'
import { ACCENTED_PATH } from '@/test/fixtures/vi/account-menu'

/**
 * Runs against the REAL session store (lib/session-client.ts) and a fake `fetch`: exactly the path the account button
 * takes on a real page: ask /api/session after mount, POST /api/auth/logout on sign-out. The store is
 * module state, so every test reloads the module (`vi.resetModules` + dynamic import).
 */
const nav = vi.hoisted(() => ({ pathname: '/posts/bai-viet', replace: vi.fn() }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
}))

const READER: SessionUser = {
  displayName: 'Reader Example',
  githubLogin: 'doc-gia',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}
const AUTHOR: SessionUser = { ...READER, displayName: 'Author Name', githubLogin: null, role: 'AUTHOR', canAccessAdmin: true }
const ADMIN: SessionUser = { ...READER, displayName: 'Site Owner', githubLogin: 'chu-site', role: 'ADMIN', canAccessAdmin: true }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>
/** Reply of /api/auth/logout; defaults to 204 like the real route. */
let logoutAnswer: () => Promise<Response>
/** Reply of /api/notifications/unread-count; defaults to nothing unread. */
let unreadAnswer: () => Promise<Response>

beforeEach(() => {
  nav.pathname = '/posts/bai-viet'
  nav.replace.mockReset()
  logoutAnswer = () => Promise.resolve(new Response(null, { status: 204 }))
  unreadAnswer = () => Promise.resolve(json(200, { data: { count: 0 } }))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

function notificationCalls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/notifications'))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** `user`: the session /api/session returns; `'pending'`: never answers. */
async function mount(user: SessionUser | null | 'pending') {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/session') {
      return user === 'pending' ? new Promise<Response>(() => {}) : Promise.resolve(json(200, { data: user }))
    }
    if (url === '/api/auth/logout') return logoutAnswer()
    if (url === '/api/notifications/unread-count') return unreadAnswer()
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.resetModules()
  const { AccountMenu } = await import('./AccountMenu')
  const tree = () => (
    <>
      <AccountMenu />
      <a href="/ngoai">Link outside header</a>
    </>
  )
  const view = render(tree())
  if (user !== 'pending') {
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await act(async () => {})
    // Signed in: the just-mounted account button starts asking for the unread count; let that reply arrive.
    await act(async () => {})
  }
  /** Like a client-side navigation (including Back/Forward): the path changes, the header does not unmount. */
  const navigate = (pathname: string) => {
    nav.pathname = pathname
    view.rerender(tree())
  }
  return { ...view, navigate }
}

function accountButton(): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${msg('Site.account.accountLabel', { name: '' })}`) })
}

function panelOf(button: HTMLElement): HTMLElement {
  return document.getElementById(button.getAttribute('aria-controls')!)!
}

describe('AccountMenu: asking for the session', () => {
  it('an inert 36px placeholder: no link, no button, nothing to focus or read', async () => {
    const { container } = await mount('pending')

    expect(screen.queryByRole('link', { name: new RegExp(msg('Site.account.signIn')) })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    const placeholder = container.querySelector('[data-account-placeholder]') as HTMLElement
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(placeholder).toHaveClass('invisible', 'h-11', 'w-11', 'md:h-9')
    expect(placeholder.querySelector('a, button, [tabindex]')).toBeNull()
  })
})

describe('AccountMenu: guest', () => {
  it('GitHub sign-in link carries the current page as an encoded returnTo', async () => {
    nav.pathname = '/posts/bai-viet'
    await mount(null)

    const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fposts%2Fbai-viet')
    expect(link).toHaveAttribute('rel', 'nofollow')
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('accented path: the start route reads back the same page after one decode', async () => {
    // safeReturnTo normalizes through URL, so an accented path is already percent-encoded; encodeURIComponent
    // adds another layer for the query. The start route reads `searchParams` (decoded once) and gets back
    // exactly the normalized path, i.e. the same page.
    nav.pathname = ACCENTED_PATH
    await mount(null)

    const href = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') }).getAttribute('href')!
    const returnTo = new URL(href, 'http://localhost').searchParams.get('returnTo')!
    expect(returnTo).toBe('/posts/xin-ch%C3%A0o')
    expect(decodeURIComponent(returnTo)).toBe(ACCENTED_PATH)
  })

  it('icon only below sm (44x44), the sign-in text from sm', async () => {
    await mount(null)

    const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
    expect(link).toHaveClass('h-11', 'w-11', 'md:h-9', 'sm:w-auto')
    // The hit area extends 4px past the cell (ICON_TAP_TARGET), like the icon cells next to it.
    expect(link).toHaveClass('relative', 'after:absolute', 'after:-inset-1')
    const label = within(link).getByText(msg('Site.account.signIn'))
    expect(label).toHaveClass('hidden', 'sm:inline')
  })

  it('on /login it returns to the home page, not to the sign-in page itself', async () => {
    nav.pathname = '/login'
    await mount(null)

    expect(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })).toHaveAttribute(
      'href',
      '/api/auth/github/start?returnTo=%2F',
    )
  })

  describe('query of the page being read', () => {
    afterEach(() => window.history.replaceState(null, '', '/'))

    function returnToOf(link: HTMLElement): string | null {
      return new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('returnTo')
    }

    it('/search?q=…: on press (pointerdown arrives before click) sign-in returns to exactly that search result', async () => {
      nav.pathname = '/search'
      window.history.replaceState(null, '', '/search?q=spring%20boot&page=2')
      await mount(null)
      const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
      // The server HTML and the first render only have the path: do not read `location` while rendering.
      expect(returnToOf(link)).toBe('/search')

      fireEvent.pointerDown(link)

      expect(returnToOf(link)).toBe('/search?q=spring%20boot&page=2')
    })

    it('keyboard use: focus (arrives before Enter) also updates the return target', async () => {
      nav.pathname = '/writing'
      window.history.replaceState(null, '', '/writing?page=3')
      await mount(null)
      const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })

      act(() => link.focus())

      expect(returnToOf(link)).toBe('/writing?page=3')
    })

    it('on another page the old query is dropped; a query that fails safeReturnTo still returns to the exact path', async () => {
      nav.pathname = '/search'
      window.history.replaceState(null, '', '/search?q=spring')
      const { navigate } = await mount(null)
      fireEvent.pointerDown(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') }))

      window.history.replaceState(null, '', '/about')
      navigate('/about')
      expect(returnToOf(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') }))).toBe('/about')

      // `%2F` in the query: safeReturnTo rejects the whole string; the path alone is still valid.
      window.history.replaceState(null, '', '/search?q=a%2Fb')
      navigate('/search')
      const link = screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })
      fireEvent.pointerDown(link)
      expect(returnToOf(link)).toBe('/search')
    })
  })
})

describe('AccountMenu: signed in', () => {
  it('disclosure button: avatar, name in <bdi> shown from sm, accessible name does not contain "menu"', async () => {
    await mount(READER)

    const button = accountButton()
    expect(button).toHaveAccessibleName(msg('Site.account.accountLabel', { name: 'Reader Example' }))
    expect(button.getAttribute('aria-label')).not.toMatch(/menu/i)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveClass('h-11', 'w-11', 'md:h-9', 'sm:w-auto')
    expect(button).toHaveClass('relative', 'after:absolute', 'after:-inset-1')

    const name = button.querySelector('bdi')!
    expect(name).toHaveTextContent('Reader Example')
    expect(name).toHaveClass('hidden', 'sm:block', 'truncate')
    // The person's own GitHub picture, at the fixed 128 px size that Avatar requests everywhere.
    expect(button.querySelector('img')).toHaveAttribute('src', 'https://avatars.githubusercontent.com/u/42?v=4&s=128')

    // aria-controls points to a real element even when closed.
    const panel = panelOf(button)
    expect(panel).not.toBeNull()
    expect(panel).not.toBeVisible()
  })

  it('opened: name, @login, Profile, Saved posts, Sign out; no Admin for USER', async () => {
    await mount(READER)
    const button = accountButton()

    fireEvent.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    const panel = panelOf(button)
    expect(panel).toBeVisible()
    expect(panel.querySelector('bdi')).toHaveTextContent('Reader Example')
    expect(within(panel).getByText('@doc-gia')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: msg('Site.account.profile') })).toHaveAttribute('href', '/profile')
    // Entry to /bookmarks, right after the Profile item.
    expect(within(panel).getByRole('link', { name: msg('Site.account.bookmarks') })).toHaveAttribute('href', '/bookmarks')
    expect(
      within(panel)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([msg('Site.account.notifications'), msg('Site.account.profile'), msg('Site.account.bookmarks')])
    expect(within(panel).getByRole('button', { name: msg('Site.account.signOut') })).toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: msg('Site.account.admin') })).toBeNull()
    // The panel does not overflow at 320px: 14rem wide but never wider than the screen minus two margins.
    expect(panel).toHaveClass('w-56', 'max-w-[calc(100vw-2rem)]', 'right-0')
  })

  it('AUTHOR also sees Admin: since V7a authors go to /admin to write posts', async () => {
    await mount(AUTHOR)
    fireEvent.click(accountButton())

    expect(within(panelOf(accountButton())).getByRole('link', { name: msg('Site.account.admin') })).toHaveAttribute(
      'href',
      '/admin',
    )
  })

  it('ADMIN sees Admin as a plain <a href="/admin">', async () => {
    await mount(ADMIN)
    fireEvent.click(accountButton())

    const admin = within(panelOf(accountButton())).getByRole('link', { name: msg('Site.account.admin') })
    expect(admin).toHaveAttribute('href', '/admin')
  })

  it('null login shows no @ line, never "@null"', async () => {
    await mount(AUTHOR)
    fireEvent.click(accountButton())

    const panel = panelOf(accountButton())
    expect(panel.textContent).not.toContain('@')
    expect(document.body.textContent).not.toContain('null')
  })

  it('Escape closes the panel and returns focus to the button', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    const profile = within(panelOf(button)).getByRole('link', { name: msg('Site.account.profile') })
    profile.focus()

    fireEvent.keyDown(profile, { key: 'Escape' })

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(button)).not.toBeVisible()
    expect(button).toHaveFocus()
  })

  it('Escape with focus on <body> (Safari, Firefox macOS do not focus the button on click) still closes, and focus returns to the button', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    // fireEvent.click does not focus the button, just like those two browsers.
    expect(document.body).toHaveFocus()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(button)).not.toBeVisible()
    expect(button).toHaveFocus()
  })

  it('Escape while focus is elsewhere on the page: closes the panel but does not pull focus away', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    const outside = screen.getByRole('link', { name: 'Link outside header' })
    outside.focus()

    fireEvent.keyDown(outside, { key: 'Escape' })

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(outside).toHaveFocus()
  })

  it('Escape while composing with an IME only cancels the composition, does not close the panel', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)

    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })

    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('with the panel closed Escape does nothing: does not pull focus to the button', async () => {
    await mount(READER)
    const outside = screen.getByRole('link', { name: 'Link outside header' })
    outside.focus()

    fireEvent.keyDown(outside, { key: 'Escape' })

    expect(outside).toHaveFocus()
    expect(accountButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('navigating while the panel is open (browser Back/Forward) closes it for good: returning to the old page does not reopen it', async () => {
    const { navigate } = await mount(READER)
    fireEvent.click(accountButton())
    expect(accountButton()).toHaveAttribute('aria-expanded', 'true')

    // Back: no pointerdown, no focusout anywhere on the page, the header stays mounted.
    navigate('/posts/bai-khac')
    expect(accountButton()).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(accountButton())).not.toBeVisible()

    // Forward to exactly the page where it was opened: nobody clicks anything, so the panel stays closed.
    navigate('/posts/bai-viet')
    expect(accountButton()).toHaveAttribute('aria-expanded', 'false')
    expect(panelOf(accountButton())).not.toBeVisible()

    // And it still opens normally on the new page.
    fireEvent.click(accountButton())
    expect(accountButton()).toHaveAttribute('aria-expanded', 'true')
  })

  it('clicking outside closes it; clicking inside the panel does not', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)

    fireEvent.pointerDown(panelOf(button))
    expect(button).toHaveAttribute('aria-expanded', 'true')

    fireEvent.pointerDown(screen.getByRole('link', { name: 'Link outside header' }))
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('clicking outside while focus is in the panel moves focus to the button, not into <body>', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    within(panelOf(button))
      .getByRole('link', { name: msg('Site.account.profile') })
      .focus()

    fireEvent.pointerDown(document.body)

    expect(button).toHaveFocus()
  })

  it('Tab out of the panel closes it; moving focus inside does not', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    const panel = panelOf(button)
    const profile = within(panel).getByRole('link', { name: msg('Site.account.profile') })
    const logoutButton = within(panel).getByRole('button', { name: msg('Site.account.signOut') })

    fireEvent.blur(profile, { relatedTarget: logoutButton })
    expect(button).toHaveAttribute('aria-expanded', 'true')

    fireEvent.blur(logoutButton, { relatedTarget: screen.getByRole('link', { name: 'Link outside header' }) })
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('clicking Profile closes the panel', async () => {
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    // jsdom cannot navigate, and there is no app router for Link to block the real navigation: block the
    // default behavior first, the link's onClick still runs.
    const stopNavigation = (event: Event) => event.preventDefault()
    document.addEventListener('click', stopNavigation, { capture: true })

    fireEvent.click(within(panelOf(button)).getByRole('link', { name: msg('Site.account.profile') }))
    document.removeEventListener('click', stopNavigation, { capture: true })

    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

/**
 * Unread notification count. Below sm there is no bell (a fourth 36px cell would push the 320px header onto a second
 * row): the avatar carries a dot, and the panel opens with the "Notifications (n)" item. The button's accessible name stays unchanged
 * — E2E (`accountButton()` in e2e/support/github.ts) finds the button by exactly the "Account: <name>" string.
 */
describe('AccountMenu: unread notifications', () => {
  it('3 unread: dot only below sm on the avatar, accessible name unchanged, the number in aria-describedby', async () => {
    unreadAnswer = () => Promise.resolve(json(200, { data: { count: 3 } }))
    await mount(READER)

    const button = accountButton()
    expect(button).toHaveAccessibleName(msg('Site.account.accountLabel', { name: 'Reader Example' }))
    await waitFor(() => expect(button).toHaveAccessibleDescription(msg('Site.account.unreadDescription', { count: '3' })))
    // The description sits outside the button, in ONE sr-only span (Chrome splits the name at each sr-only piece).
    const description = document.getElementById(button.getAttribute('aria-describedby')!)!
    expect(button.contains(description)).toBe(false)
    expect(description).toHaveClass('sr-only')
    const dot = button.querySelector('[data-unread-dot]')!
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).toHaveClass('sm:hidden', 'bg-brand')
  })

  it('nothing unread: no dot, no aria-describedby', async () => {
    await mount(READER)

    const button = accountButton()
    expect(notificationCalls()).toEqual(['/api/notifications/unread-count'])
    expect(button).not.toHaveAttribute('aria-describedby')
    expect(button.querySelector('[data-unread-dot]')).toBeNull()
  })

  it.each([
    [0, msg('Site.account.notifications')],
    [3, msg('Site.account.notificationsWithCount', { count: '3' })],
    [100, msg('Site.account.notificationsWithCount', { count: '99+' })],
  ])('panel starts with the /notifications link: %i unread gives "%s"', async (count, label) => {
    unreadAnswer = () => Promise.resolve(json(200, { data: { count } }))
    await mount(READER)
    fireEvent.click(accountButton())

    const links = within(panelOf(accountButton())).getAllByRole('link')
    expect(links[0]).toHaveAccessibleName(label)
    expect(links[0]).toHaveAttribute('href', '/notifications')
    expect(links[1]).toHaveAccessibleName(msg('Site.account.profile'))
  })

  it('name next to the avatar: shown at sm, hidden from md to lg (nav and bell take the room), shown again from lg', async () => {
    await mount(READER)

    const name = accountButton().querySelector('bdi')!
    expect(name.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'sm:block', 'md:hidden', 'lg:block']))
  })

  it('guest and while asking for the session: no notification request at all', async () => {
    await mount(null)
    expect(notificationCalls()).toEqual([])

    await mount('pending')
    expect(notificationCalls()).toEqual([])
  })

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'USER_SUSPENDED'],
  ])(
    'background poll gets %i %s: the dot disappears but the session does NOT become a guest (nobody clicked anything)',
    async (status, code) => {
      unreadAnswer = () => Promise.resolve(json(status, { error: { code } }))
      await mount(READER)

      expect(notificationCalls()).toEqual(['/api/notifications/unread-count'])
      expect(accountButton()).toBeInTheDocument()
      expect(accountButton()).not.toHaveAttribute('aria-describedby')
      expect(screen.queryByRole('link', { name: msg('Site.account.signInWithGithub') })).toBeNull()
    },
  )
})

describe('AccountMenu: sign-out', () => {
  async function logOut() {
    const button = accountButton()
    fireEvent.click(button)
    const logoutButton = within(panelOf(button)).getByRole('button', { name: msg('Site.account.signOut') })
    logoutButton.focus()
    await act(async () => {
      fireEvent.click(logoutButton)
    })
  }

  it('POST /api/auth/logout, then the sign-in button appears, gets focus, and "Signed out" is announced', async () => {
    await mount(READER)

    await logOut()

    const logoutCall = fetchMock.mock.calls.find(([url]) => url === '/api/auth/logout')
    expect(logoutCall?.[1]).toMatchObject({ method: 'POST' })
    const login = await screen.findByRole('link', { name: msg('Site.account.signInWithGithub') })
    await waitFor(() => expect(login).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.account.signedOut'))
    expect(screen.queryByRole('button', { name: new RegExp(`^${msg('Site.account.accountLabel', { name: '' })}`) })).toBeNull()
    // Not on /profile: stay on the page being read.
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it('on /profile it goes to the home page', async () => {
    nav.pathname = '/profile'
    await mount(READER)

    await logOut()

    await waitFor(() => expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/'))
  })

  it('failed sign-out: still signed in, error shown in the panel, no "Signed out" announced', async () => {
    logoutAnswer = () => Promise.reject(new TypeError('fetch failed'))
    await mount(READER)

    await logOut()

    expect(accountButton()).toBeInTheDocument()
    expect(within(panelOf(accountButton())).getByRole('alert')).toHaveTextContent(msg('Site.account.signOutFailed'))
    expect(screen.getByRole('status')).toHaveTextContent('')
    // Can retry.
    expect(within(panelOf(accountButton())).getByRole('button', { name: msg('Site.account.signOut') })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('two quick clicks send only one request', async () => {
    let finish: (response: Response) => void = () => {}
    logoutAnswer = () => new Promise<Response>((resolve) => (finish = resolve))
    await mount(READER)
    const button = accountButton()
    fireEvent.click(button)
    const logoutButton = within(panelOf(button)).getByRole('button', { name: msg('Site.account.signOut') })

    fireEvent.click(logoutButton)
    fireEvent.click(logoutButton)

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/logout')).toHaveLength(1)
    expect(logoutButton).toHaveAttribute('aria-disabled', 'true')
    await act(async () => finish(new Response(null, { status: 204 })))
  })

  it('an expired session (not a sign-out click) does not pull focus and announces nothing', async () => {
    await mount(READER)
    const outside = screen.getByRole('link', { name: 'Link outside header' })
    outside.focus()

    const { setAnonymous } = await import('@/lib/session-client')
    act(() => setAnonymous())

    expect(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })).toBeInTheDocument()
    expect(outside).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('')
  })
})
