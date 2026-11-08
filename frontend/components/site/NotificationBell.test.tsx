import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMENT_TARGET_EVENT } from '@/lib/comment-target'
import type { SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const BELL_NAME = new RegExp(`^${escapeRe(msg('Site.notifications.bell.label'))}`)

/**
 * The bell runs with the REAL session store and unread-count store, a fake `fetch`: exactly the path
 * of a real page — ask /api/session, then the unread count, then the list when the panel opens. Both stores are module
 * state, so each test reloads the module (`vi.resetModules` + dynamic import), like AccountMenu.test.tsx.
 */
const nav = vi.hoisted(() => ({ pathname: '/writing' }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: vi.fn() }),
}))

const READER: SessionUser = {
  displayName: 'Alice Reader',
  githubLogin: 'doc-gia',
  avatarUrl: null,
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}

const N1 = '11111111-1111-4111-8111-111111111111'
const N2 = '22222222-2222-4222-8222-222222222222'
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const HEAD = Buffer.from(`1759900000000000:${N1}`).toString('base64url')

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Two unread notifications: a reply (with a target comment), and a post like. */
const ITEMS = [
  {
    id: N1,
    type: 'COMMENT_REPLIED',
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    read: false,
    actor: { displayName: 'Dan Replier', githubLogin: 'dap', avatarUrl: null },
    post: { slug: 'bai-viet', title: msg('Site.about.readNextLinks.writing') },
    commentId: C1,
    excerpt: 'Thank you!',
  },
  {
    id: N2,
    type: 'POST_LIKED',
    createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    read: true,
    actor: { displayName: 'Pat Liker', githubLogin: null, avatarUrl: null },
    post: { slug: 'other-post', title: 'Other post' },
    commentId: null,
    excerpt: null,
  },
]

let fetchMock: ReturnType<typeof vi.fn>
let sessionUser: SessionUser | null | 'pending'
let unreadAnswer: () => Promise<Response>
let listAnswer: () => Promise<Response>
let markAllAnswer: () => Promise<Response>

beforeEach(() => {
  nav.pathname = '/writing'
  sessionUser = READER
  unreadAnswer = () => Promise.resolve(json(200, { data: { count: 1 } }))
  listAnswer = () => Promise.resolve(json(200, { data: { items: ITEMS, nextCursor: null, headCursor: HEAD } }))
  markAllAnswer = () => Promise.resolve(json(200, { data: { count: 0 } }))
  fetchMock = vi.fn((url: string) => {
    if (url === '/api/session') {
      return sessionUser === 'pending' ? new Promise<Response>(() => {}) : Promise.resolve(json(200, { data: sessionUser }))
    }
    if (url === '/api/notifications/unread-count') return unreadAnswer()
    if (url.startsWith('/api/notifications?')) return listAnswer()
    if (url.startsWith('/api/notifications/read-all')) return markAllAnswer()
    if (/^\/api\/notifications\/[^/]+\/read$/.test(url)) return Promise.resolve(json(200, { data: { count: 0 } }))
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function calls(prefix: string): [string, RequestInit | undefined][] {
  return fetchMock.mock.calls
    .map(([url, init]) => [String(url), init as RequestInit | undefined] as [string, RequestInit | undefined])
    .filter(([url]) => url.startsWith(prefix))
}

async function mount() {
  vi.resetModules()
  const { NotificationBell } = await import('./NotificationBell')
  const tree = () => (
    <>
      <NotificationBell />
      <a href="/outside">Link outside header</a>
    </>
  )
  const view = render(tree())
  await act(async () => {})
  await act(async () => {})
  const navigate = (pathname: string) => {
    nav.pathname = pathname
    view.rerender(tree())
  }
  return { ...view, navigate }
}

function bell(): HTMLElement {
  return screen.getByRole('button', { name: BELL_NAME })
}

function panelOf(button: HTMLElement): HTMLElement {
  return document.getElementById(button.getAttribute('aria-controls')!)!
}

async function openPanel(): Promise<HTMLElement> {
  const button = bell()
  await act(async () => {
    fireEvent.click(button)
  })
  await act(async () => {})
  return panelOf(button)
}

/** jsdom cannot navigate: block the link's default behavior, its onClick still runs. */
function withoutNavigation(run: () => void) {
  const stop = (event: Event) => event.preventDefault()
  document.addEventListener('click', stop, { capture: true })
  try {
    run()
  } finally {
    document.removeEventListener('click', stop, { capture: true })
  }
}

describe('NotificationBell: only when signed in', () => {
  it.each([
    ['guest', null],
    ['session loading', 'pending'],
  ] as const)('%s: renders nothing, sends no notification request', async (_label, user) => {
    sessionUser = user
    const { container } = await mount()

    // Only the external link remains: no wrapper, no button.
    expect(container.children).toHaveLength(1)
    expect(screen.queryByRole('button')).toBeNull()
    expect(calls('/api/notifications')).toEqual([])
  })

  it(
    msg('Admin.postImages.size', {
      width: 'its root is hidden below sm (`hidden sm:block`); the 36',
      height: '36 button has aria-expanded and aria-controls',
    }),
    async () => {
      await mount()

      const button = bell()
      expect(button.parentElement).toHaveClass('hidden', 'sm:block')
      expect(button).toHaveClass('h-11', 'w-11', 'md:h-9', 'md:w-9')
      // the hit area extends 4px past the slot (ICON_TAP_TARGET); its `relative` is also the anchor
      // of the count badge.
      expect(button).toHaveClass('relative', 'after:absolute', 'after:-inset-1')
      expect(button).toHaveAttribute('aria-expanded', 'false')
      expect(panelOf(button)).not.toBeVisible()
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    },
  )
})

describe('NotificationBell: badge and name', () => {
  it('3 unread: name "Notifications, 3 unread", badge "3" for the eye only', async () => {
    unreadAnswer = () => Promise.resolve(json(200, { data: { count: 3 } }))
    await mount()

    expect(bell()).toHaveAccessibleName(msg('Site.notifications.bell.labelUnread', { count: '3' }))
    const badge = bell().querySelector('[data-unread-badge]')!
    expect(badge).toHaveTextContent('3')
    expect(badge).toHaveAttribute('aria-hidden', 'true')
  })

  it('100 (the server caps at 100): badge and name say "99+"', async () => {
    unreadAnswer = () => Promise.resolve(json(200, { data: { count: 100 } }))
    await mount()

    expect(bell()).toHaveAccessibleName(msg('Site.notifications.bell.labelUnread', { count: '99+' }))
    expect(bell().querySelector('[data-unread-badge]')).toHaveTextContent('99+')
  })

  it('0, or unknown (the backend returns 403): bare name "Notifications", no badge', async () => {
    unreadAnswer = () => Promise.resolve(json(200, { data: { count: 0 } }))
    await mount()
    expect(bell()).toHaveAccessibleName(msg('Site.account.notifications'))
    expect(bell().querySelector('[data-unread-badge]')).toBeNull()

    unreadAnswer = () => Promise.resolve(json(403, { error: { code: 'FORBIDDEN' } }))
    await mount()
    expect(
      screen
        .getAllByRole('button', { name: msg('Site.account.notifications') })
        .at(-1)!
        .querySelector('[data-unread-badge]'),
    ).toBeNull()
  })
})

describe('NotificationBell: panel', () => {
  it('opening: GET the 6 newest items, ask the unread count again, draw each item as a link', async () => {
    await mount()
    expect(calls('/api/notifications/unread-count')).toHaveLength(1)

    const panel = await openPanel()

    expect(bell()).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toBeVisible()
    expect(calls('/api/notifications?').map(([url]) => url)).toEqual(['/api/notifications?size=6'])
    // Opening the panel is the reader's action: the unread count is asked again at once, bypassing the 15-second brake.
    expect(calls('/api/notifications/unread-count')).toHaveLength(2)
    const links = within(panel).getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', `/posts/bai-viet#binh-luan-${C1}`)
    expect(links[0]).toHaveTextContent(
      `Dan Replier ${msg('Site.notifications.copy.lead.COMMENT_REPLIED')} “${ITEMS[0]!.post.title}”${msg('Site.notifications.copy.tail.COMMENT_REPLIED')}`,
    )
    expect(links[0]).toHaveTextContent('Thank you!')
    expect(links[0]).toHaveTextContent(msg('Site.notifications.item.new'))
    expect(links[1]).toHaveAttribute('href', '/posts/other-post')
    expect(links[1]).not.toHaveTextContent(msg('Site.notifications.item.new'))
    // End of the panel: to the full page.
    expect(within(panel).getByRole('link', { name: msg('Site.notifications.bell.viewAll') })).toHaveAttribute(
      'href',
      '/notifications',
    )
    // The panel does not overflow at narrow widths: 20rem wide but never more than the screen minus two margins.
    expect(panel).toHaveClass('w-80', 'max-w-[calc(100vw-2rem)]', 'right-0', 'top-full')
  })

  it('loading, then empty: "No notifications yet."; no mark-all button', async () => {
    let answer: (response: Response) => void = () => {}
    listAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    unreadAnswer = () => Promise.resolve(json(200, { data: { count: 0 } }))
    await mount()

    const panel = await openPanel()
    expect(within(panel).getByText(msg('Site.bookmarks.loading'))).toBeInTheDocument()

    await act(async () => answer(json(200, { data: { items: [], nextCursor: null, headCursor: null } })))
    expect(within(panel).getByText(msg('Site.notifications.bell.empty'))).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: msg('Site.notifications.markAll') })).toBeNull()
  })

  it('load failure: "Could not load notifications." and "Try again" reloads', async () => {
    listAnswer = () => Promise.resolve(json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } }))
    await mount()
    const panel = await openPanel()

    expect(within(panel).getByText(msg('Site.notifications.loadFailed'))).toBeInTheDocument()

    listAnswer = () => Promise.resolve(json(200, { data: { items: ITEMS, nextCursor: null, headCursor: HEAD } }))
    const retry = within(panel).getByRole('button', { name: msg('Site.profile.author.retry') })
    retry.focus()
    await act(async () => {
      fireEvent.click(retry)
    })
    await act(async () => {})

    expect(within(panel).getAllByRole('link', { name: /Dan Replier/ })).toHaveLength(1)
    // The retry button has made room: focus stays inside the panel (the panel is still open), does not fall to <body>.
    expect(panel).toHaveFocus()
    expect(bell()).toHaveAttribute('aria-expanded', 'true')
  })

  it('401 on open (a reader action): the session becomes guest, the bell disappears', async () => {
    listAnswer = () => Promise.resolve(json(401, { error: { code: 'UNAUTHENTICATED' } }))
    await mount()

    await openPanel()

    expect(screen.queryByRole('button', { name: BELL_NAME })).toBeNull()
  })

  it('Escape closes the panel and returns focus to the button', async () => {
    await mount()
    const panel = await openPanel()
    const first = within(panel).getAllByRole('link')[0]!
    first.focus()

    fireEvent.keyDown(first, { key: 'Escape' })

    expect(bell()).toHaveAttribute('aria-expanded', 'false')
    expect(panel).not.toBeVisible()
    expect(bell()).toHaveFocus()
  })

  it('clicking outside while focus is in the panel: closes, focus to the button; clicking inside the panel does not close', async () => {
    await mount()
    const panel = await openPanel()

    fireEvent.pointerDown(panel)
    expect(bell()).toHaveAttribute('aria-expanded', 'true')

    within(panel).getAllByRole('link')[0]!.focus()
    fireEvent.pointerDown(screen.getByRole('link', { name: 'Link outside header' }))
    expect(bell()).toHaveAttribute('aria-expanded', 'false')
    expect(bell()).toHaveFocus()
  })

  it('Tab out of the panel closes it; moving focus inside does not', async () => {
    await mount()
    const panel = await openPanel()
    const [first, second] = within(panel).getAllByRole('link')

    fireEvent.blur(first!, { relatedTarget: second })
    expect(bell()).toHaveAttribute('aria-expanded', 'true')

    fireEvent.blur(second!, { relatedTarget: screen.getByRole('link', { name: 'Link outside header' }) })
    expect(bell()).toHaveAttribute('aria-expanded', 'false')
  })

  it('changing page while the panel is open closes it fully', async () => {
    const { navigate } = await mount()
    await openPanel()

    navigate('/about')

    expect(bell()).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('NotificationBell: mark all as read', () => {
  it('sends before=headCursor of the open list, then applies the count, draws every item as read, announces to screen readers', async () => {
    await mount()
    const panel = await openPanel()
    const markAll = within(panel).getByRole('button', { name: msg('Site.notifications.markAll') })
    markAll.focus()

    await act(async () => {
      fireEvent.click(markAll)
    })
    await act(async () => {})

    const [[url, init]] = calls('/api/notifications/read-all')
    expect(url).toBe(`/api/notifications/read-all?before=${HEAD}`)
    expect(init).toMatchObject({ method: 'POST' })
    expect(within(panel).queryByText(msg('Site.notifications.item.new'))).toBeNull()
    expect(bell()).toHaveAccessibleName(msg('Site.account.notifications'))
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.notifications.markedAll'))
    // The button just clicked disappears (nothing unread is left): focus stays inside the panel.
    expect(within(panel).queryByRole('button', { name: msg('Site.notifications.markAll') })).toBeNull()
    expect(panel).toHaveFocus()
  })

  it('failure: an error message in the panel, items stay unread, retry works', async () => {
    markAllAnswer = () => Promise.reject(new TypeError('fetch failed'))
    await mount()
    const panel = await openPanel()

    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: msg('Site.notifications.markAll') }))
    })
    await act(async () => {})

    expect(within(panel).getByRole('alert')).toHaveTextContent(msg('Site.profile.author.errors.network'))
    expect(within(panel).getByText(msg('Site.notifications.item.new'))).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: msg('Site.notifications.markAll') })).not.toHaveAttribute('aria-disabled')
  })

  it('new notifications arrived after opening (the server still counts 2): reload the list, focus stays inside the panel', async () => {
    markAllAnswer = () => Promise.resolve(json(200, { data: { count: 2 } }))
    await mount()
    const panel = await openPanel()
    // A consistent server: two new notifications arrived after opening, and the count request of the reload also sees 2.
    unreadAnswer = () => Promise.resolve(json(200, { data: { count: 2 } }))
    const markAll = within(panel).getByRole('button', { name: msg('Site.notifications.markAll') })
    markAll.focus()

    await act(async () => {
      fireEvent.click(markAll)
    })
    await act(async () => {})

    expect(calls('/api/notifications?')).toHaveLength(2)
    expect(panel).toHaveFocus()
    expect(bell()).toHaveAccessibleName(msg('Site.notifications.bell.labelUnread', { count: '2' }))
  })

  it('two clicks in a row: one request', async () => {
    let answer: (response: Response) => void = () => {}
    markAllAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    await mount()
    const panel = await openPanel()
    const markAll = within(panel).getByRole('button', { name: msg('Site.notifications.markAll') })

    fireEvent.click(markAll)
    fireEvent.click(markAll)

    expect(calls('/api/notifications/read-all')).toHaveLength(1)
    expect(markAll).toHaveAttribute('aria-disabled', 'true')
    await act(async () => answer(json(200, { data: { count: 0 } })))
  })
})

describe('NotificationBell: opening a notification', () => {
  it('click: marks it read (POST keepalive), closes the panel', async () => {
    await mount()
    const panel = await openPanel()
    const first = within(panel).getAllByRole('link')[0]!

    await act(async () => {
      withoutNavigation(() => fireEvent.click(first))
    })

    const [[url, init]] = calls(`/api/notifications/${N1}/read`)
    expect(url).toBe(`/api/notifications/${N1}/read`)
    expect(init).toMatchObject({ method: 'POST', keepalive: true })
    expect(bell()).toHaveAttribute('aria-expanded', 'false')
  })

  it('an already read notification: not sent again', async () => {
    await mount()
    const panel = await openPanel()

    await act(async () => {
      withoutNavigation(() => fireEvent.click(within(panel).getAllByRole('link')[1]!))
    })

    expect(calls(`/api/notifications/${N2}/read`)).toEqual([])
  })

  it('already on that very post: asks the comments section to find the target comment (no hashchange at all)', async () => {
    nav.pathname = '/posts/bai-viet'
    const targets: string[] = []
    const listen = (event: Event) => targets.push((event as CustomEvent<{ id: string }>).detail.id)
    window.addEventListener(COMMENT_TARGET_EVENT, listen)
    try {
      await mount()
      const panel = await openPanel()
      await act(async () => {
        withoutNavigation(() => fireEvent.click(within(panel).getAllByRole('link')[0]!))
      })
    } finally {
      window.removeEventListener(COMMENT_TARGET_EVENT, listen)
    }

    expect(targets).toEqual([C1])
  })

  it('Ctrl-click (open in another tab) right on that post: still marks it read, the panel stays open, fires no event', async () => {
    nav.pathname = '/posts/bai-viet'
    const targets: string[] = []
    const listen = (event: Event) => targets.push((event as CustomEvent<{ id: string }>).detail.id)
    window.addEventListener(COMMENT_TARGET_EVENT, listen)
    try {
      await mount()
      const panel = await openPanel()
      const first = within(panel).getAllByRole('link')[0]!

      await act(async () => {
        withoutNavigation(() => fireEvent.click(first, { ctrlKey: true }))
      })

      expect(calls(`/api/notifications/${N1}/read`)).toHaveLength(1)
      expect(bell()).toHaveAttribute('aria-expanded', 'true')
      expect(panel).toBeVisible()
      // Already opened (in the other tab): the item becomes read right in the still-open panel.
      expect(first).not.toHaveTextContent(msg('Site.notifications.item.new'))
    } finally {
      window.removeEventListener(COMMENT_TARGET_EVENT, listen)
    }

    expect(targets).toEqual([])
  })

  it("on another page: fires no event (the target post's comments section reads the anchor itself at mount)", async () => {
    const targets: string[] = []
    const listen = (event: Event) => targets.push((event as CustomEvent<{ id: string }>).detail.id)
    window.addEventListener(COMMENT_TARGET_EVENT, listen)
    try {
      await mount()
      const panel = await openPanel()
      await act(async () => {
        withoutNavigation(() => fireEvent.click(within(panel).getAllByRole('link')[0]!))
      })
    } finally {
      window.removeEventListener(COMMENT_TARGET_EVENT, listen)
    }

    expect(targets).toEqual([])
  })
})

describe('NotificationBell: keyboard', () => {
  it('the button is a real <button type="button"> (Enter, Space open); the items are links reached by Tab, no role="menu"', async () => {
    await mount()
    expect(bell().tagName).toBe('BUTTON')
    expect(bell()).toHaveAttribute('type', 'button')

    const panel = await openPanel()

    expect(panel.querySelector('[role="menu"], [role="menuitem"]')).toBeNull()
    await waitFor(() => expect(within(panel).getAllByRole('link')).toHaveLength(3))
    expect(
      within(panel)
        .getAllByRole('link')
        .every((link) => link.tabIndex === 0),
    ).toBe(true)
    // The panel can be focused by mouse (keeps focus when the text is clicked), not by Tab.
    expect(panel).toHaveAttribute('tabindex', '-1')
  })
})
