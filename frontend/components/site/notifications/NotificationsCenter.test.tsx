import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'

/**
 * The client side of the /notifications page, with the REAL session store and unread-count store and a fake `fetch`,
 * like AccountMenu.test.tsx: each test reloads the module.
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/notifications',
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

const HEADING_ID = 'thong-bao-heading'

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

const COMMENT = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const HEAD = Buffer.from(`1759900000000000:${uuid(1)}`).toString('base64url')
const NEXT = Buffer.from(`1759800000000000:${uuid(3)}`).toString('base64url')

function item(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(n),
    type: 'COMMENT_LIKED',
    // 14:30 on 8 October 2026 UTC+7 (the test suite's TZ).
    createdAt: '2026-10-08T07:30:00Z',
    read: false,
    actor: { displayName: `User ${n}`, githubLogin: null, avatarUrl: null },
    post: { slug: 'bai-viet', title: msg('Site.about.readNextLinks.writing') },
    commentId: COMMENT,
    excerpt: msg('Site.comments.rootForm.label'),
    ...overrides,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function page(items: unknown[], nextCursor: string | null = null, headCursor: string | null = HEAD): Response {
  return json(200, { data: { items, nextCursor, headCursor } })
}

type Answer = (url: string, init?: RequestInit) => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn>
let sessionUser: SessionUser | null | 'pending'
let listAnswer: Answer
let deleteAnswer: Answer
let markAllAnswer: Answer
let unreadCount: number

beforeEach(() => {
  sessionUser = READER
  unreadCount = 3
  listAnswer = async () => page([item(1), item(2, { read: true }), item(3)])
  deleteAnswer = async () => json(200, { data: { count: 1 } })
  markAllAnswer = async () => json(200, { data: { count: 0 } })
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/session') {
      return sessionUser === 'pending' ? new Promise<Response>(() => {}) : Promise.resolve(json(200, { data: sessionUser }))
    }
    if (url === '/api/notifications/unread-count') return Promise.resolve(json(200, { data: { count: unreadCount } }))
    if (url.startsWith('/api/notifications?')) return listAnswer(url, init)
    if (url.startsWith('/api/notifications/read-all')) return markAllAnswer(url, init)
    if (/^\/api\/notifications\/[^/]+\/read$/.test(url)) return Promise.resolve(json(200, { data: { count: 0 } }))
    if (url.startsWith('/api/notifications/') && init?.method === 'DELETE') return deleteAnswer(url, init)
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function urls(prefix: string): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(prefix))
}

async function settle() {
  await act(async () => {})
  await act(async () => {})
}

async function mount() {
  vi.resetModules()
  const { NotificationsCenter } = await import('./NotificationsCenter')
  const view = render(
    <>
      <h1 id={HEADING_ID} tabIndex={-1}>
        {msg('Site.account.notifications')}
      </h1>
      <NotificationsCenter headingId={HEADING_ID} />
      <a href="/ngoai">Outside link</a>
    </>,
  )
  await settle()
  return view
}

function list(): HTMLElement {
  return screen.getByRole('list')
}

function itemLink(name: RegExp | string): HTMLElement {
  return within(list()).getByRole('link', { name: typeof name === 'string' ? new RegExp(name) : name })
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
  await settle()
}

describe('NotificationsCenter: before the list arrives', () => {
  it('asking the session: an aria-busy placeholder, no text, no notification request', async () => {
    sessionUser = 'pending'
    const { container } = await mount()

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(urls('/api/notifications')).toEqual([])
  })

  it('guest: a sign-in invitation returning to /notifications, no notification request', async () => {
    sessionUser = null
    await mount()

    expect(screen.getByText(msg('Site.notifications.center.signInPrompt'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })).toHaveAttribute(
      'href',
      '/api/auth/github/start?returnTo=%2Fnotifications',
    )
    expect(urls('/api/notifications')).toEqual([])
  })

  it('load failure: "Could not load notifications.", "Try again" reloads, focus goes to the heading instead of falling to <body>', async () => {
    listAnswer = async () => json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } })
    await mount()
    expect(screen.getByText(msg('Site.notifications.loadFailed'))).toBeInTheDocument()

    listAnswer = async () => page([item(1)])
    const retry = screen.getByRole('button', { name: msg('Site.profile.author.retry') })
    retry.focus()
    await click(retry)

    expect(itemLink('User 1')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.account.notifications') })).toHaveFocus()
  })

  it('401 on load (the reader just opened the page): the session becomes guest, the sign-in invitation appears', async () => {
    listAnswer = async () => json(401, { error: { code: 'UNAUTHENTICATED' } })
    await mount()

    expect(screen.getByText(msg('Site.notifications.center.signInPrompt'))).toBeInTheDocument()
  })
})

describe('NotificationsCenter: the list', () => {
  it('first page: 20 items, "All"; each item one link, the full time visible, the delete button has a name', async () => {
    await mount()

    expect(urls('/api/notifications?')).toEqual(['/api/notifications?size=20&unread=false'])
    const first = itemLink('User 1')
    expect(first).toHaveAttribute('href', `/posts/bai-viet#binh-luan-${COMMENT}`)
    expect(first).toHaveTextContent(
      `User 1 ${msg('Site.notifications.copy.lead.COMMENT_LIKED')} “${msg('Site.about.readNextLinks.writing')}”${msg('Site.notifications.copy.tail.COMMENT_LIKED')}`,
    )
    // The full time is visible secondary text on the page (not only in the title).
    expect(first).toHaveTextContent('14:30, 08/10/2026')
    expect(first.querySelector('time')).toHaveAttribute('dateTime', '2026-10-08T07:30:00Z')
    expect(first).toHaveTextContent(msg('Site.notifications.item.new'))
    expect(itemLink('User 2')).not.toHaveTextContent(msg('Site.notifications.item.new'))
    expect(
      within(list()).getAllByRole('button', {
        name: new RegExp(`^${msg('Site.notifications.center.deleteLabel', { name: '' })}`),
      }),
    ).toHaveLength(3)
    expect(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }),
    ).toHaveClass('h-10', 'w-10', 'shrink-0')
  })

  it('empty: "You have no notifications yet."', async () => {
    listAnswer = async () => page([], null, null)
    await mount()

    expect(screen.getByText(msg('Site.notifications.center.emptyAll'))).toBeInTheDocument()
  })

  it('filter: the "Filter notifications" group with two aria-pressed buttons; "Unread" reloads the first page with unread=true', async () => {
    await mount()
    const group = screen.getByRole('group', { name: msg('Site.notifications.center.filterLabel') })
    const all = within(group).getByRole('button', { name: msg('Site.notifications.center.filterAll') })
    const unread = within(group).getByRole('button', { name: msg('Site.notifications.center.filterUnread') })
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(unread).toHaveAttribute('aria-pressed', 'false')

    listAnswer = async () => page([], null, null)
    await click(unread)

    expect(urls('/api/notifications?').at(-1)).toBe('/api/notifications?size=20&unread=true')
    expect(unread).toHaveAttribute('aria-pressed', 'true')
    expect(all).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(msg('Site.notifications.center.emptyUnread'))).toBeInTheDocument()

    // Clicking the already selected filter: nothing more is loaded.
    const before = urls('/api/notifications?').length
    await click(unread)
    expect(urls('/api/notifications?')).toHaveLength(before)
  })

  it('"Load more": sends after=nextCursor, drops duplicate ids, focus goes to the first new item', async () => {
    listAnswer = async (url) =>
      url.includes('after=') ? page([item(3), item(4), item(5)], null, null) : page([item(1), item(2), item(3)], NEXT)
    await mount()

    await click(screen.getByRole('button', { name: msg('Site.notifications.center.loadMore') }))

    expect(urls('/api/notifications?').at(-1)).toBe(`/api/notifications?size=20&unread=false&after=${NEXT}`)
    const names = within(list())
      .getAllByRole('link')
      .map((link) => link.textContent?.match(/User \d/)?.[0])
    expect(names).toEqual(['User 1', 'User 2', 'User 3', 'User 4', 'User 5'])
    expect(itemLink('User 4')).toHaveFocus()
    // End of the pages: no more button.
    expect(screen.queryByRole('button', { name: msg('Site.notifications.center.loadMore') })).toBeNull()
  })

  it('"Load more" fails: an error message, the button stays to retry', async () => {
    listAnswer = async (url) =>
      url.includes('after=') ? json(500, { error: { code: 'INTERNAL_ERROR' } }) : page([item(1)], NEXT)
    await mount()

    await click(screen.getByRole('button', { name: msg('Site.notifications.center.loadMore') }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.notifications.loadFailed'))
    expect(screen.getByRole('button', { name: msg('Site.notifications.center.loadMore') })).not.toHaveAttribute('aria-disabled')
  })

  it('opening an unread notification: POST …/read (keepalive), the item becomes read at once', async () => {
    await mount()
    const link = itemLink('User 1')
    const stop = (event: Event) => event.preventDefault()
    document.addEventListener('click', stop, { capture: true })
    try {
      await click(link)
    } finally {
      document.removeEventListener('click', stop, { capture: true })
    }

    expect(urls(`/api/notifications/${uuid(1)}/read`)).toHaveLength(1)
    expect(itemLink('User 1')).not.toHaveTextContent(msg('Site.notifications.item.new'))
  })
})

describe('NotificationsCenter: delete', () => {
  it('delete: DELETE, the item disappears, announces "Notification deleted", focus moves to the next item\'s link', async () => {
    await mount()
    const remove = within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) })
    remove.focus()

    await click(remove)

    const call = fetchMock.mock.calls.find(([url]) => url === `/api/notifications/${uuid(1)}`)!
    expect(call[1]).toMatchObject({ method: 'DELETE' })
    expect(within(list()).queryByRole('link', { name: /User 1/ })).toBeNull()
    expect(itemLink('User 2')).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.notifications.center.deleted'))
  })

  it('last item: focus moves to the previous item; the only item: focus returns to the page heading', async () => {
    listAnswer = async () => page([item(1), item(2)])
    await mount()

    const last = within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 2' }) })
    last.focus()
    await click(last)
    expect(itemLink('User 1')).toHaveFocus()

    const only = within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) })
    only.focus()
    await click(only)
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.account.notifications') })).toHaveFocus()
    expect(screen.getByText(msg('Site.notifications.center.emptyAll'))).toBeInTheDocument()
    // No later page: truly empty, nothing reloaded.
    expect(urls('/api/notifications?')).toHaveLength(1)
  })

  it('deleting the rest of the loaded items while the server still has a later page: reloads the first page, does not say "no notifications yet"', async () => {
    listAnswer = async () => page([item(1), item(2)], NEXT)
    await mount()

    const first = within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) })
    first.focus()
    await click(first)
    expect(urls('/api/notifications?')).toHaveLength(1)

    // On the server the first two items are gone: the first page is now the remaining notifications.
    listAnswer = async () => page([item(3)])
    const second = within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 2' }) })
    second.focus()
    await click(second)
    await settle()

    expect(urls('/api/notifications?')).toEqual([
      '/api/notifications?size=20&unread=false',
      '/api/notifications?size=20&unread=false',
    ])
    expect(itemLink('User 3')).toBeInTheDocument()
    expect(screen.queryByText(msg('Site.notifications.center.emptyAll'))).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.account.notifications') })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.notifications.center.deleted'))
  })

  it('"Unread", two deletes settling in the same tick empty the page: reloads the first page exactly once, still unread=true', async () => {
    listAnswer = async () => page([item(1), item(2)], NEXT)
    await mount()
    await click(screen.getByRole('button', { name: msg('Site.notifications.center.filterUnread') }))
    const answers: ((response: Response) => void)[] = []
    deleteAnswer = () => new Promise<Response>((resolve) => answers.push(resolve))
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }),
    )
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 2' }) }),
    )
    await act(async () => {})
    expect(answers).toHaveLength(2)

    listAnswer = async () => page([item(3)])
    await act(async () => {
      answers[0]!(json(200, { data: { count: 1 } }))
      answers[1]!(json(200, { data: { count: 1 } }))
    })
    await settle()

    expect(urls('/api/notifications?')).toEqual([
      '/api/notifications?size=20&unread=false',
      '/api/notifications?size=20&unread=true',
      '/api/notifications?size=20&unread=true',
    ])
    expect(itemLink('User 3')).toBeInTheDocument()
    expect(screen.queryByText(msg('Site.notifications.center.emptyUnread'))).toBeNull()
  })

  it('another item is still waiting to be deleted: not reloaded yet; if that delete fails the item stays, nothing reloaded', async () => {
    listAnswer = async () => page([item(1), item(2)], NEXT)
    const answers: ((response: Response) => void)[] = []
    deleteAnswer = () => new Promise<Response>((resolve) => answers.push(resolve))
    await mount()
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }),
    )
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 2' }) }),
    )
    await act(async () => {})

    await act(async () => answers[0]!(json(200, { data: { count: 1 } })))
    await settle()
    await act(async () => answers[1]!(json(500, { error: { code: 'INTERNAL_ERROR' } })))
    await settle()

    expect(urls('/api/notifications?')).toHaveLength(1)
    expect(itemLink('User 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: msg('Site.notifications.center.loadMore') })).toBeInTheDocument()
  })

  it('focus moved elsewhere while waiting: leave it alone', async () => {
    let answer: (response: Response) => void = () => {}
    deleteAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    await mount()
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }),
    )
    const outside = screen.getByRole('link', { name: 'Outside link' })
    outside.focus()

    await act(async () => answer(json(200, { data: { count: 1 } })))
    await settle()

    expect(outside).toHaveFocus()
    expect(within(list()).queryByRole('link', { name: /User 1/ })).toBeNull()
  })

  it('two deletes settling in the same tick: both items disappear, none comes back to life', async () => {
    const answers: ((response: Response) => void)[] = []
    deleteAnswer = () => new Promise<Response>((resolve) => answers.push(resolve))
    await mount()
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }),
    )
    fireEvent.click(
      within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 2' }) }),
    )
    await act(async () => {})
    expect(answers).toHaveLength(2)

    await act(async () => {
      answers[0]!(json(200, { data: { count: 1 } }))
      answers[1]!(json(200, { data: { count: 1 } }))
    })
    await settle()

    expect(within(list()).queryByRole('link', { name: /User 1/ })).toBeNull()
    expect(within(list()).queryByRole('link', { name: /User 2/ })).toBeNull()
    expect(itemLink('User 3')).toBeInTheDocument()
  })

  it('404 (already deleted in another tab): the item disappears too', async () => {
    deleteAnswer = async () => json(404, { error: { code: 'NOTIFICATION_NOT_FOUND' } })
    await mount()

    await click(within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 3' }) }))

    expect(within(list()).queryByRole('link', { name: /User 3/ })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('failure (500): an error message right under that item, the item stays intact', async () => {
    deleteAnswer = async () => json(500, { error: { code: 'INTERNAL_ERROR' } })
    await mount()

    await click(within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }))

    const row = itemLink('User 1').closest('li')!
    expect(within(row).getByRole('alert')).toHaveTextContent(msg('Site.profile.author.errors.network'))
  })

  it('an unexpected 403: "Could not do that. Please try again."', async () => {
    deleteAnswer = async () => json(403, { error: { code: 'USER_SUSPENDED' } })
    await mount()

    await click(within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.notifications.errors.generic'))
  })

  it('clicking delete twice in a row: one request', async () => {
    let answer: (response: Response) => void = () => {}
    deleteAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    await mount()
    const remove = within(list()).getByRole('button', { name: msg('Site.notifications.center.deleteLabel', { name: 'User 1' }) })

    fireEvent.click(remove)
    fireEvent.click(remove)

    expect(urls(`/api/notifications/${uuid(1)}`).filter((url) => !url.endsWith('/read'))).toHaveLength(1)
    await act(async () => {})
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    await act(async () => answer(json(200, { data: { count: 1 } })))
  })
})

describe('NotificationsCenter: mark all as read', () => {
  it('sends before=headCursor, every item becomes read, announces to screen readers', async () => {
    await mount()
    const markAll = screen.getByRole('button', { name: msg('Site.notifications.markAll') })

    await click(markAll)

    expect(urls('/api/notifications/read-all')).toEqual([`/api/notifications/read-all?before=${HEAD}`])
    expect(list()).not.toHaveTextContent(msg('Site.notifications.item.new'))
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.notifications.markedAll'))
    // Nothing unread is left: the button is read out as unavailable, but can still hold focus.
    expect(screen.getByRole('button', { name: msg('Site.notifications.markAll') })).toHaveAttribute('aria-disabled', 'true')
  })

  it('under "Unread": the list is entirely empty afterwards', async () => {
    await mount()
    await click(screen.getByRole('button', { name: msg('Site.notifications.center.filterUnread') }))

    await click(screen.getByRole('button', { name: msg('Site.notifications.markAll') }))

    expect(screen.getByText(msg('Site.notifications.center.emptyUnread'))).toBeInTheDocument()
  })

  it('nothing unread: aria-disabled, clicking sends nothing', async () => {
    unreadCount = 0
    listAnswer = async () => page([item(1, { read: true })])
    await mount()
    const markAll = screen.getByRole('button', { name: msg('Site.notifications.markAll') })

    expect(markAll).toHaveAttribute('aria-disabled', 'true')
    await click(markAll)

    expect(urls('/api/notifications/read-all')).toEqual([])
  })

  it('list failed to load: aria-disabled even though the server counts 3, clicking sends nothing (no headCursor to bound it)', async () => {
    listAnswer = async () => json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } })
    await mount()
    // The unread count has arrived (3): only the list not having arrived disables the button.
    expect(urls('/api/notifications/unread-count')).toHaveLength(1)
    const markAll = screen.getByRole('button', { name: msg('Site.notifications.markAll') })

    expect(markAll).toHaveAttribute('aria-disabled', 'true')
    await click(markAll)

    expect(urls('/api/notifications/read-all')).toEqual([])
  })

  it('reloading after a filter change: aria-disabled, clicking sends nothing; once the list arrives it is usable again', async () => {
    await mount()
    let answer: (response: Response) => void = () => {}
    listAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    await click(screen.getByRole('button', { name: msg('Site.notifications.center.filterUnread') }))
    expect(screen.getByText(msg('Site.bookmarks.loading'))).toBeInTheDocument()
    const markAll = screen.getByRole('button', { name: msg('Site.notifications.markAll') })

    expect(markAll).toHaveAttribute('aria-disabled', 'true')
    await click(markAll)
    expect(urls('/api/notifications/read-all')).toEqual([])

    await act(async () => answer(page([item(1)])))
    await settle()
    expect(screen.getByRole('button', { name: msg('Site.notifications.markAll') })).not.toHaveAttribute('aria-disabled')
  })

  it('new notifications arrived after loading (the server still counts 1): reloads the first page so they show', async () => {
    markAllAnswer = async () => json(200, { data: { count: 1 } })
    await mount()

    await click(screen.getByRole('button', { name: msg('Site.notifications.markAll') }))

    expect(urls('/api/notifications?')).toHaveLength(2)
  })

  it('failure: an error message under the toolbar, the items stay unread', async () => {
    markAllAnswer = async () => json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } })
    await mount()

    await click(screen.getByRole('button', { name: msg('Site.notifications.markAll') }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.profile.author.errors.network'))
    expect(itemLink('User 1')).toHaveTextContent(msg('Site.notifications.item.new'))
  })
})
