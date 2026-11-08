import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostSummary, SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'

/** Client side of /bookmarks: the REAL session store and a fake `fetch`, like NotificationsCenter.test.tsx. */

const READER: SessionUser = {
  displayName: 'Reader Display',
  githubLogin: 'doc-gia',
  avatarUrl: null,
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}

const HEADING_ID = 'bai-da-luu-heading'

function post(n: number): PostSummary {
  return {
    id: `p${n}`,
    title: `Post number ${n}`,
    slug: `bai-so-${n}`,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 5,
    publishedAt: '2026-10-03T08:00:00Z',
  }
}

function range(from: number, to: number): PostSummary[] {
  return Array.from({ length: to - from + 1 }, (_, i) => post(from + i))
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A real `PagedResponse` envelope; callBff only reads `data`. */
function page(posts: PostSummary[]): Response {
  return json(200, { data: posts, pagination: { page: 0, size: 20, totalElements: posts.length, totalPages: 1 } })
}

let fetchMock: ReturnType<typeof vi.fn>
let sessionUser: SessionUser | null | 'pending'
let listAnswer: (url: string) => Promise<Response>
let deleteAnswer: (url: string) => Promise<Response>

beforeEach(() => {
  sessionUser = READER
  listAnswer = async () => page(range(1, 3))
  deleteAnswer = async () => json(200, { data: { bookmarked: false } })
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/session') {
      return sessionUser === 'pending' ? new Promise<Response>(() => {}) : Promise.resolve(json(200, { data: sessionUser }))
    }
    if (url.startsWith('/api/me/bookmarks?')) return listAnswer(url)
    if (url.startsWith('/api/me/bookmarks/') && init?.method === 'DELETE') return deleteAnswer(url)
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function calls(prefix: string): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(prefix))
}

async function settle() {
  await act(async () => {})
  await act(async () => {})
}

async function mount() {
  vi.resetModules()
  const { BookmarkList } = await import('./BookmarkList')
  const view = render(
    <>
      <h1 id={HEADING_ID} tabIndex={-1}>
        {msg('Site.account.bookmarks')}
      </h1>
      <BookmarkList headingId={HEADING_ID} />
    </>,
  )
  await settle()
  return view
}

function unsave(n: number): HTMLElement {
  return screen.getByRole('button', { name: msg('Site.bookmarks.unsaveLabel', { title: `Post number ${n}` }) })
}

function titleLink(n: number): HTMLElement {
  return screen.getByRole('link', { name: `Post number ${n}` })
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
  await settle()
}

describe('BookmarkList: session', () => {
  it('while the session is being fetched: aria-busy placeholder, nothing to click, no saved-posts request', async () => {
    sessionUser = 'pending'
    const { container } = await mount()

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(calls('/api/me/bookmarks')).toEqual([])
  })

  it('guest: sign-in invitation returning to /bookmarks, no saved-posts request', async () => {
    sessionUser = null
    await mount()

    expect(screen.getByText(msg('Site.bookmarks.signInPrompt'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })).toHaveAttribute(
      'href',
      '/api/auth/github/start?returnTo=%2Fbookmarks',
    )
    expect(calls('/api/me/bookmarks')).toEqual([])
  })

  it('signed in: first page, one h2 row per post with an "Unsave" button named after the post; a short page has no "Load more"', async () => {
    await mount()

    expect(calls('/api/me/bookmarks')).toEqual(['/api/me/bookmarks?page=0&size=20'])
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Post number 1',
      'Post number 2',
      'Post number 3',
    ])
    expect(titleLink(1)).toHaveAttribute('href', '/posts/bai-so-1')
    expect(unsave(1)).toHaveTextContent(msg('Site.bookmarks.unsave'))
    expect(screen.queryByRole('button', { name: msg('Site.bookmarks.loadMore') })).toBeNull()
  })

  it('GET 401 (dead cookie): back to the sign-in invitation', async () => {
    listAnswer = async () => json(401, { error: { code: 'UNAUTHENTICATED' } })
    await mount()

    expect(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('BookmarkList: list states', () => {
  it('no saved posts: empty sentence and a hint', async () => {
    listAnswer = async () => page([])
    await mount()

    expect(screen.getByText(msg('Site.bookmarks.empty'))).toBeInTheDocument()
    expect(screen.getByText(msg('Site.bookmarks.emptyHint'))).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('failing GET or payload off contract: "Could not load…"; "Try again" reloads and moves focus to the heading', async () => {
    listAnswer = async () => json(200, { data: [{ id: 'p1', title: 'Missing slug' }] })
    await mount()
    expect(screen.getByText(msg('Site.bookmarks.loadFailed'))).toBeInTheDocument()

    listAnswer = async () => page(range(1, 2))
    await click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))

    expect(titleLink(2)).toBeInTheDocument()
    expect(document.getElementById(HEADING_ID)).toHaveFocus()
  })
})

describe('BookmarkList: unbookmark', () => {
  it('server confirms: the row stays while waiting; when done it disappears, announces "Post removed from saved posts", focus moves to the next post', async () => {
    let answer: (response: Response) => void = () => {}
    deleteAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    await mount()
    const button = unsave(2)
    button.focus()

    await click(button)
    await click(button)

    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toEqual([
      ['/api/me/bookmarks/bai-so-2', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' })],
    ])
    expect(titleLink(2)).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-disabled', 'true')

    await act(async () => answer(json(200, { data: { bookmarked: false } })))
    await settle()

    expect(screen.queryByRole('link', { name: 'Post number 2' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.bookmarks.unsaved'))
    expect(titleLink(3)).toHaveFocus()
  })

  it('unbookmarking the last post: empty state, focus returns to the page heading', async () => {
    listAnswer = async () => page([post(1)])
    await mount()
    unsave(1).focus()

    await click(unsave(1))

    expect(screen.getByText(msg('Site.bookmarks.empty'))).toBeInTheDocument()
    expect(document.getElementById(HEADING_ID)).toHaveFocus()
  })

  it('429: the row stays, error sentence right below the row, can be clicked again', async () => {
    deleteAnswer = async () => json(429, { error: { code: 'RATE_LIMITED' } })
    await mount()

    await click(unsave(1))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.interaction.byCode.RATE_LIMITED'))
    expect(unsave(1)).not.toHaveAttribute('aria-disabled')
    expect(titleLink(1).closest('li')).toContainElement(screen.getByRole('alert'))
  })

  it('404 POST_NOT_FOUND (post was removed): the row disappears, announces the post is no longer public', async () => {
    deleteAnswer = async () => json(404, { error: { code: 'POST_NOT_FOUND' } })
    await mount()

    await click(unsave(1))

    expect(screen.queryByRole('link', { name: 'Post number 1' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Errors.interaction.postNotFound.bookmark'))
  })

  it('401 (session expired): back to the sign-in invitation', async () => {
    deleteAnswer = async () => json(401, { error: { code: 'UNAUTHENTICATED' } })
    await mount()

    await click(unsave(1))

    expect(screen.getByRole('link', { name: msg('Site.account.signInWithGithub') })).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('BookmarkList: load more', () => {
  it('next page is computed from the number of posts shown (after unbookmarking), duplicates dropped, focus on the new post; a short page ends the button', async () => {
    listAnswer = async () => page(range(1, 20))
    await mount()
    await click(unsave(1))

    // 19 posts shown: the next position is on page 0, where the server has pulled post 21 up.
    listAnswer = async () => page(range(2, 21))
    await click(screen.getByRole('button', { name: msg('Site.bookmarks.loadMore') }))

    expect(calls('/api/me/bookmarks?').at(-1)).toBe('/api/me/bookmarks?page=0&size=20')
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(20)
    expect(titleLink(21)).toHaveFocus()

    listAnswer = async () => page(range(22, 23))
    await click(screen.getByRole('button', { name: msg('Site.bookmarks.loadMore') }))

    expect(calls('/api/me/bookmarks?').at(-1)).toBe('/api/me/bookmarks?page=1&size=20')
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(22)
    expect(titleLink(22)).toHaveFocus()
    expect(screen.queryByRole('button', { name: msg('Site.bookmarks.loadMore') })).toBeNull()
  })

  it('unbookmarking every shown post while the server still has a next page: reloads the first page, never says "no saved posts yet"', async () => {
    listAnswer = async () => page(range(1, 20))
    await mount()

    listAnswer = async () => page(range(21, 22))
    for (let n = 1; n <= 20; n += 1) await click(unsave(n))

    expect(screen.queryByText(msg('Site.bookmarks.empty'))).toBeNull()
    expect(calls('/api/me/bookmarks?')).toEqual(['/api/me/bookmarks?page=0&size=20', '/api/me/bookmarks?page=0&size=20'])
    expect(titleLink(21)).toBeInTheDocument()
  })
})
