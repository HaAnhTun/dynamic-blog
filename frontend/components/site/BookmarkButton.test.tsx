import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IntlWrapper } from '@/test/intl'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookmarkState, SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'
import { ACCENTED_SLUG } from '@/test/fixtures/vi/bookmark-button'

/**
 * Like LikeButton.test.tsx: the REAL session store (lib/session-client.ts) and a fake `fetch` — /api/session after mount,
 * then GET the saved state, then PUT/DELETE on press. The store is module state, so every test reloads the module.
 */

const READER: SessionUser = {
  displayName: 'Reader Example',
  githubLogin: 'doc-gia',
  avatarUrl: null,
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}

const SESSION_EXPIRED = msg('Errors.interaction.sessionExpired')
const NETWORK = msg('Site.profile.author.errors.network')

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function state(value: BookmarkState): Promise<Response> {
  return Promise.resolve(json(200, { data: value }))
}

type Answer = () => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn>
let sessionAnswer: Answer
let getAnswer: Answer
/** PUT / DELETE. */
let toggleAnswer: (method: string) => Promise<Response>

function bookmarkCalls(method: 'GET' | 'WRITE') {
  return fetchMock.mock.calls.filter(([url, init]) => {
    if (!String(url).startsWith('/api/me/bookmarks/')) return false
    const verb = (init as RequestInit | undefined)?.method ?? 'GET'
    return method === 'GET' ? verb === 'GET' : verb !== 'GET'
  })
}

beforeEach(() => {
  toggleAnswer = () => Promise.reject(new Error('nobody pressed'))
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/session') return sessionAnswer()
    if (url.startsWith('/api/me/bookmarks/')) return method === 'GET' ? getAnswer() : toggleAnswer(method)
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** `user`: the session /api/session returns; `'pending'`: never answers. */
async function mount(
  user: SessionUser | null | 'pending',
  get: BookmarkState | Answer = { bookmarked: false },
  slug = 'bai-viet',
  language?: 'vi' | 'en',
) {
  sessionAnswer = user === 'pending' ? () => new Promise<Response>(() => {}) : () => Promise.resolve(json(200, { data: user }))
  getAnswer = typeof get === 'function' ? get : () => state(get)
  vi.resetModules()
  const { BookmarkButton } = await import('./BookmarkButton')
  return render(
    <>
      <BookmarkButton slug={slug} language={language} />
      <a href="/khac">Other link</a>
    </>,
  )
}

function deferToggle() {
  let answer: (response: Response) => void = () => {}
  toggleAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
  return (response: Response) => act(async () => answer(response))
}

describe('BookmarkButton: before the session is known', () => {
  it('server render: an inert placeholder, no link, no button, no state, calls nothing; not printed', async () => {
    vi.resetModules()
    const { BookmarkButton } = await import('./BookmarkButton')

    const html = renderToString(
      <IntlWrapper>
        <BookmarkButton slug="bai-viet" />
      </IntlWrapper>,
    )

    expect(html).toContain('data-bookmark-placeholder')
    expect(html).toContain('id="luu-bai"')
    expect(html).toContain('print:hidden')
    expect(html).not.toMatch(
      new RegExp(`<a |<button|aria-pressed|fill="currentColor"|${msg('Site.account.signIn').toLowerCase()}`),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('waits for /api/session to answer before asking for the saved state', async () => {
    const { container } = await mount('pending')

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.anything()))
    expect(bookmarkCalls('GET')).toHaveLength(0)
    expect(container.querySelector('[data-bookmark-placeholder]')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link', { name: new RegExp(msg('Site.bookmarkButton.label')) })).toBeNull()
  })
})

describe('BookmarkButton: guest', () => {
  it('sign-in link back to the exact spot of the button; the name starts with the visible text; no saved-state request at all', async () => {
    await mount(null)

    const link = await screen.findByRole('link', { name: msg('Site.bookmarkButton.guestName') })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fposts%2Fbai-viet%23luu-bai')
    expect(link).toHaveAttribute('rel', 'nofollow')
    const visible = within(link).getByText(msg('Site.bookmarkButton.label'))
    expect(link.getAttribute('aria-label')!.startsWith(visible.textContent!)).toBe(true)
    expect(document.getElementById('luu-bai')).toContainElement(link)
    // The saved state is private: a guest has nothing to ask.
    expect(bookmarkCalls('GET')).toHaveLength(0)
  })

  it('accented slug: returnTo and the route URL are both encoded', async () => {
    await mount(READER, { bookmarked: false }, ACCENTED_SLUG)

    await screen.findByRole('button', { name: msg('Site.bookmarkButton.label') })
    expect(bookmarkCalls('GET')[0]![0]).toBe('/api/me/bookmarks/xin-ch%C3%A0o')
    const { setAnonymous } = await import('@/lib/session-client')
    act(() => setAnonymous())
    const link = screen.getByRole('link', { name: new RegExp(`^${msg('Site.bookmarkButton.label')}`) })
    expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('returnTo')).toBe(
      '/posts/xin-ch%C3%A0o#luu-bai',
    )
  })
})

describe('BookmarkButton: signed in', () => {
  it('not saved: toggle button aria-pressed=false, outline icon; no sign-in invitation', async () => {
    await mount(READER)

    const button = await screen.findByRole('button', { name: msg('Site.bookmarkButton.label'), pressed: false })
    expect(button).toHaveAttribute('type', 'button')
    expect(button.querySelector('svg path')).not.toHaveAttribute('fill')
    expect(screen.queryByRole('link', { name: new RegExp(msg('Site.account.signIn').toLowerCase()) })).toBeNull()
  })

  it('saved: aria-pressed=true, filled icon', async () => {
    await mount(READER, { bookmarked: true })

    const button = await screen.findByRole('button', { name: msg('Site.bookmarkButton.label'), pressed: true })
    expect(button.querySelector('svg path')).toHaveAttribute('fill', 'currentColor')
  })

  it('press to save: PUT, wait for the server (not optimistic), then press again: DELETE', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: msg('Site.bookmarkButton.label') })
    const answer = deferToggle()

    fireEvent.click(button)
    fireEvent.click(button)

    // Double press while waiting: exactly one request, the screen changes nothing except the busy notice.
    expect(bookmarkCalls('WRITE')).toHaveLength(1)
    const [url, init] = bookmarkCalls('WRITE')[0]!
    expect(url).toBe('/api/me/bookmarks/bai-viet')
    expect(init).toMatchObject({ method: 'PUT', credentials: 'same-origin', cache: 'no-store' })
    expect(new Headers((init as RequestInit).headers).get('content-type')).toBe('application/json')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-pressed', 'false')

    await answer(json(200, { data: { bookmarked: true } }))
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.bookmarkButton.saved'))

    toggleAnswer = () => state({ bookmarked: false })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(bookmarkCalls('WRITE')[1]![1]).toMatchObject({ method: 'DELETE' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.bookmarks.unsaved'))
  })

  it.each([
    [
      '429 RATE_LIMITED',
      () => Promise.resolve(json(429, { error: { code: 'RATE_LIMITED' } })),
      msg('Errors.interaction.byCode.RATE_LIMITED'),
    ],
    [
      '403 USER_SUSPENDED',
      () => Promise.resolve(json(403, { error: { code: 'USER_SUSPENDED' } })),
      msg('Errors.interaction.userSuspended.bookmark'),
    ],
    [
      '404 POST_NOT_FOUND',
      () => Promise.resolve(json(404, { error: { code: 'POST_NOT_FOUND' } })),
      msg('Errors.interaction.postNotFound.bookmark'),
    ],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch')), NETWORK],
    ['200 off contract', () => Promise.resolve(json(200, { data: { bookmarked: 'yes' } })), NETWORK],
  ])('%s: state unchanged, error sentence in role="status", focus kept, can retry', async (_label, answer, message) => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: msg('Site.bookmarkButton.label') })
    button.focus()
    toggleAnswer = answer

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button).toHaveFocus()

    toggleAnswer = () => state({ bookmarked: true })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).not.toHaveTextContent(message)
  })

  it('401 on press (session expired): becomes a sign-in link, announces the expired session, focus moves to the link', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: msg('Site.bookmarkButton.label') })
    button.focus()
    toggleAnswer = () => Promise.resolve(json(401, { error: { code: 'UNAUTHENTICATED' } }))

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.queryByRole('button', { name: msg('Site.bookmarkButton.label') })).toBeNull()
    const link = screen.getByRole('link', { name: msg('Site.bookmarkButton.guestName') })
    await waitFor(() => expect(link).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent(SESSION_EXPIRED)
  })

  it('GET 401 (cookie dead): back to the guest UI, does not steal focus from anyone', async () => {
    const { container } = await mount(READER, () => Promise.resolve(json(401, { error: { code: 'UNAUTHENTICATED' } })))
    const elsewhere = screen.getByRole('link', { name: 'Other link' })
    elsewhere.focus()

    expect(await screen.findByRole('link', { name: msg('Site.bookmarkButton.guestName') })).toBeInTheDocument()
    expect(elsewhere).toHaveFocus()
    expect(container.querySelector('[data-bookmark-placeholder]')).toBeNull()
  })

  it.each<[string, Answer]>([
    ['backend error (502)', () => Promise.resolve(json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } }))],
    ['post taken down (404)', () => Promise.resolve(json(404, { error: { code: 'POST_NOT_FOUND' } }))],
    ['payload off contract', () => Promise.resolve(json(200, { data: { bookmarked: null } }))],
  ])('failed GET (%s): stays an inert placeholder, no error sentence', async (_label, answer) => {
    const { container } = await mount(READER, answer)

    await waitFor(() => expect(bookmarkCalls('GET')).toHaveLength(1))
    await act(async () => {})
    expect(container.querySelector('[data-bookmark-placeholder]')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link', { name: new RegExp(msg('Site.bookmarkButton.label')) })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('')
  })
})
