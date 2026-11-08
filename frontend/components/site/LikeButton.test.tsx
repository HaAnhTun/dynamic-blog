import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IntlWrapper } from '@/test/intl'
import type { LikeState, SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'
import { DIACRITIC_SLUG } from '@/test/fixtures/vi/like-button'

/**
 * Runs with the REAL session store (lib/session-client.ts) and a fake `fetch`: exactly the path the like button takes on a
 * real page — /api/session after mount, then the GET of the likes, then PUT/DELETE on click. The store is module
 * state, so each test reloads the module (`vi.resetModules` + dynamic import).
 */

const READER: SessionUser = {
  displayName: 'Alice Reader',
  githubLogin: 'doc-gia',
  avatarUrl: null,
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}

const SESSION_EXPIRED = msg('Errors.interaction.sessionExpired')

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The accessible-name prefix of the member button and of the guest link, taken from the catalog. */
const LIKE_PREFIX = msg('Site.like.ariaLabel', { n: 0, count: '0' }).replace(/ \(.*$/, '')
const GUEST_PREFIX = msg('Site.like.guestAriaLabel', { n: 0, count: '0' }).replace(/ \(.*$/, '')
const LIKE_NAME = new RegExp(`^${escapeRe(LIKE_PREFIX)}`)
const LIKE_NAME_ANY = new RegExp(escapeRe(LIKE_PREFIX))
const GUEST_NAME = new RegExp(`^${escapeRe(GUEST_PREFIX)}`)
const GUEST_LABEL_RE = new RegExp(escapeRe(msg('Site.like.guestLabel')))

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function liked(state: LikeState): Promise<Response> {
  return Promise.resolve(json(200, { data: state }))
}

type Answer = () => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn>
let sessionAnswer: Answer
/** GET of the likes, by slug. */
let likeAnswer: (slug: string) => Promise<Response>
/** PUT / DELETE. */
let toggleAnswer: (method: string) => Promise<Response>

/** Every PUT/DELETE call to the like route. */
function toggleCalls() {
  return fetchMock.mock.calls.filter(([, init]) => ['PUT', 'DELETE'].includes((init as RequestInit | undefined)?.method ?? 'GET'))
}

function likeGets() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith('/like') && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  )
}

beforeEach(() => {
  toggleAnswer = () => Promise.reject(new Error('nobody clicked'))
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/session') return sessionAnswer()
    const match = /^\/api\/posts\/([^/]+)\/like$/.exec(url)
    if (match) return method === 'GET' ? likeAnswer(decodeURIComponent(match[1]!)) : toggleAnswer(method)
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
  like: LikeState | Answer = { liked: false, count: 12 },
  language?: 'vi' | 'en',
) {
  sessionAnswer = user === 'pending' ? () => new Promise<Response>(() => {}) : () => Promise.resolve(json(200, { data: user }))
  likeAnswer = typeof like === 'function' ? like : () => liked(like)
  vi.resetModules()
  const { LikeButton } = await import('./LikeButton')
  const view = render(
    <>
      <LikeButton slug="bai-viet" language={language} />
      <a href="/elsewhere">Other link</a>
    </>,
  )
  return { view, LikeButton }
}

function likeButton(): HTMLElement {
  return screen.getByRole('button', { name: LIKE_NAME })
}

/** The PUT/DELETE reply, whose arrival time the test decides. */
function deferToggle() {
  let answer: (response: Response) => void = () => {}
  toggleAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
  return (response: Response) => act(async () => answer(response))
}

describe('LikeButton: before the count is known', () => {
  it('server render: outline heart and "–", fully inert, calls nothing', async () => {
    vi.resetModules()
    const { LikeButton } = await import('./LikeButton')

    const html = renderToString(
      <IntlWrapper locale="vi">
        <LikeButton slug="bai-viet" />
      </IntlWrapper>,
    )

    expect(html).toContain('–')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toMatch(/<a |<button/)
    expect(html).not.toContain('fill="currentColor"')
    // The anchor for returnTo is in the HTML right away: the browser scrolls to it when coming back after sign-in.
    expect(html).toContain('id="luot-thich"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not print: the whole block, in every state — it cannot be clicked on paper, and the like count is not the post', async () => {
    await mount({ ...READER })
    await waitFor(() => expect(screen.getByRole('button', { name: LIKE_NAME_ANY })).toBeInTheDocument())

    const root = document.getElementById('luot-thich')!
    expect(root).toHaveClass('print:hidden')
    // The root stays the same across states (placeholder → button), and the status region is inside it too.
    expect(root).toContainElement(screen.getByRole('button', { name: LIKE_NAME_ANY }))
    expect(root).toContainElement(screen.getByRole('status'))
  })

  it('waits for /api/session to answer before asking for the likes: no race over token rotation with it', async () => {
    const { view } = await mount('pending')

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.anything()))
    expect(likeGets()).toHaveLength(0)
    const placeholder = view.container.querySelector('[data-like-placeholder]')!
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(placeholder).toHaveTextContent('–')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link', { name: GUEST_LABEL_RE })).toBeNull()
  })

  it.each<[string, SessionUser | null, Answer]>([
    ['backend error (502), signed in', READER, () => Promise.resolve(json(502, { error: { code: 'UPSTREAM_UNAVAILABLE' } }))],
    [
      'post taken down (404 POST_NOT_FOUND), signed in',
      READER,
      () => Promise.resolve(json(404, { error: { code: 'POST_NOT_FOUND' } })),
    ],
    [
      'post taken down (404 POST_NOT_FOUND), guest',
      null,
      () => Promise.resolve(json(404, { error: { code: 'POST_NOT_FOUND' } })),
    ],
    ['network error, signed in', READER, () => Promise.reject(new TypeError('Failed to fetch'))],
    ['network error, guest', null, () => Promise.reject(new TypeError('Failed to fetch'))],
  ])(
    'failed GET (%s): stays an inert placeholder, no button or link that does nothing when pressed',
    async (_label, user, answer) => {
      const { view } = await mount(user, answer)

      await waitFor(() => expect(likeGets()).toHaveLength(1))
      await act(async () => {})
      const placeholder = view.container.querySelector('[data-like-placeholder]')
      expect(placeholder).toHaveAttribute('aria-hidden', 'true')
      expect(placeholder).toHaveTextContent('–')
      expect(screen.queryByRole('button', { name: LIKE_NAME_ANY })).toBeNull()
      expect(screen.queryByRole('link', { name: GUEST_LABEL_RE })).toBeNull()
      // No error message: nobody clicked anything yet, and a removed post has nothing to like.
      expect(screen.getByRole('status')).toHaveTextContent('')
    },
  )

  it('a payload that breaks the contract is also a placeholder, with no invented count shown', async () => {
    const { view } = await mount(null, () => Promise.resolve(json(200, { data: { liked: 'yes', count: -1 } })))

    await waitFor(() => expect(likeGets()).toHaveLength(1))
    await act(async () => {})
    expect(view.container.querySelector('[data-like-placeholder]')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: GUEST_LABEL_RE })).toBeNull()
  })
})

describe('LikeButton: guest', () => {
  it('GitHub sign-in link: the name reads out the like count, returns to the exact place of the like button', async () => {
    await mount(null)

    const link = await screen.findByRole('link', { name: msg('Site.like.guestAriaLabel', { n: 12, count: '12' }) })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fposts%2Fbai-viet%23luot-thich')
    expect(link).toHaveAttribute('rel', 'nofollow')
    expect(link).toHaveTextContent('12')
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(document.getElementById('luot-thich')).toContainElement(link)
  })

  it('a post of the other language returns to its own language URL, whatever the page language', async () => {
    await mount(null, undefined, 'en')

    const link = await screen.findByRole('link', { name: GUEST_NAME })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fen%2Fposts%2Fbai-viet%23luot-thich')
  })

  it('screen-viewing users can read that this is a GitHub sign-in, not just a heart and a number', async () => {
    await mount(null)

    const link = await screen.findByRole('link', { name: GUEST_NAME })
    // Real text in the link, not sr-only, not aria-hidden: visible on screen.
    const label = within(link).getByText(msg('Site.like.guestLabel'))
    // Visible from `sm`; on a phone the heart and the number carry the pill (title and accessible name keep the sentence), one row with Save and Share.
    expect(label.className).not.toMatch(/(^|\s)sr-only/)
    expect(label.className).toContain('max-sm:sr-only')
    expect(label.closest('[aria-hidden="true"]')).toBeNull()
    // The accessible name starts with exactly the visible sentence (WCAG 2.5.3, label in name).
    expect(link.getAttribute('aria-label')!.startsWith(label.textContent!)).toBe(true)
    expect(link).toHaveTextContent('12')
    // Not the same style as the signed-in user's like button: a long sentence can wrap, not fixed at 40px tall.
    expect(link.className).toContain('min-h-10')
    expect(link.className).not.toMatch(/(^|\s)h-10(\s|$)/)
  })

  it('once signed in there is no sign-in invitation beside the like button', async () => {
    await mount(READER)

    await screen.findByRole('button', { name: LIKE_NAME })
    expect(screen.queryByText(msg('Site.like.guestLabel'))).toBeNull()
  })

  it('the number is written in vi-VN, both on screen and in the name', async () => {
    await mount(null, { liked: false, count: 1234 })

    const link = await screen.findByRole('link', { name: msg('Site.like.guestAriaLabel', { n: 1234, count: '1.234' }) })
    expect(link).toHaveTextContent('1.234')
  })

  it('slug with diacritics: returnTo and the route URL are both encoded', async () => {
    sessionAnswer = () => Promise.resolve(json(200, { data: null }))
    likeAnswer = () => liked({ liked: false, count: 1 })
    vi.resetModules()
    const { LikeButton } = await import('./LikeButton')
    render(<LikeButton slug={DIACRITIC_SLUG} />)

    const link = await screen.findByRole('link', { name: GUEST_NAME })
    expect(likeGets()[0]![0]).toBe('/api/posts/xin-ch%C3%A0o/like')
    const returnTo = new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('returnTo')
    expect(returnTo).toBe('/posts/xin-ch%C3%A0o#luot-thich')
  })
})

describe('LikeButton: signed in', () => {
  it('not liked: toggle button aria-pressed=false, outline heart, name has the count', async () => {
    await mount(READER)

    const button = await screen.findByRole('button', { name: msg('Site.like.ariaLabel', { n: 12, count: '12' }), pressed: false })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveTextContent('12')
    const svg = button.querySelector('svg')!
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg.querySelector('path')).not.toHaveAttribute('fill')
    expect(likeGets()).toHaveLength(1)
  })

  it('liked: aria-pressed=true, solid heart', async () => {
    await mount(READER, { liked: true, count: 13 })

    const button = await screen.findByRole('button', { name: msg('Site.like.ariaLabel', { n: 13, count: '13' }), pressed: true })
    expect(button.querySelector('svg path')).toHaveAttribute('fill', 'currentColor')
  })

  it('click to like: PUT, wait for the server (not optimistic), then show exactly the { liked, count } the server returns', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    const answer = deferToggle()

    fireEvent.click(button)

    expect(toggleCalls()).toHaveLength(1)
    const [url, init] = toggleCalls()[0]!
    expect(url).toBe('/api/posts/bai-viet/like')
    expect(init).toMatchObject({ method: 'PUT', credentials: 'same-origin', cache: 'no-store' })
    // The BFF route demands JSON for every PUT (blocks forms from other sites).
    expect(new Headers((init as RequestInit).headers).get('content-type')).toBe('application/json')
    // While waiting: nothing changes on screen, only the busy indicator.
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveTextContent('12')

    // The server says 20 (someone else just liked too): show 20, do not add up to 13 itself.
    await answer(json(200, { data: { liked: true, count: 20 } }))

    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button).toHaveAccessibleName(msg('Site.like.ariaLabel', { n: 20, count: '20' }))
    expect(button).toHaveTextContent('20')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.like.liked'))
  })

  it('click to unlike: DELETE, then "Like removed"', async () => {
    await mount(READER, { liked: true, count: 13 })
    const button = await screen.findByRole('button', { name: LIKE_NAME, pressed: true })
    toggleAnswer = () => liked({ liked: false, count: 12 })

    await act(async () => {
      fireEvent.click(button)
    })

    expect(toggleCalls()[0]![1]).toMatchObject({ method: 'DELETE' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveTextContent('12')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.like.unliked'))
  })

  it('clicking twice in a row while waiting: only one request; once done it can be clicked again', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    const answer = deferToggle()

    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)

    expect(toggleCalls()).toHaveLength(1)
    await answer(json(200, { data: { liked: true, count: 13 } }))
    expect(button).toHaveAttribute('aria-pressed', 'true')

    toggleAnswer = () => liked({ liked: false, count: 12 })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(toggleCalls()).toHaveLength(2)
    expect(toggleCalls()[1]![1]).toMatchObject({ method: 'DELETE' })
  })

  it('focus stays on the same button after the server replies', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    button.focus()
    const answer = deferToggle()

    fireEvent.click(button)
    await answer(json(200, { data: { liked: true, count: 13 } }))

    expect(likeButton()).toBe(button)
    expect(button).toHaveFocus()
  })

  it('the live region is cleared on every click: a sentence identical to the previous one is still read again', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    toggleAnswer = () => liked({ liked: true, count: 13 })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.like.liked'))

    const answer = deferToggle()
    fireEvent.click(button)

    expect(screen.getByRole('status')).toHaveTextContent('')
    await answer(json(200, { data: { liked: false, count: 12 } }))
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.like.unliked'))
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
      msg('Errors.interaction.userSuspended.comment'),
    ],
    [
      '404 POST_NOT_FOUND',
      () => Promise.resolve(json(404, { error: { code: 'POST_NOT_FOUND' } })),
      msg('Errors.interaction.postNotFound.like'),
    ],
    [
      '413 PAYLOAD_TOO_LARGE',
      () => Promise.resolve(json(413, { error: { code: 'PAYLOAD_TOO_LARGE' } })),
      msg('Errors.interaction.invalid.like'),
    ],
    [
      '502 without envelope',
      () => Promise.resolve(new Response('<html>', { status: 502 })),
      msg('Site.profile.author.errors.network'),
    ],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch')), msg('Site.profile.author.errors.network')],
    ['200 off contract', () => Promise.resolve(json(200, { data: { liked: true } })), msg('Site.profile.author.errors.network')],
  ])('%s: state unchanged, error sentence in role="status", focus kept, can retry', async (_label, answer, message) => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    button.focus()
    toggleAnswer = answer

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button).toHaveAccessibleName(msg('Site.like.ariaLabel', { n: 12, count: '12' }))
    expect(button).toHaveFocus()

    // Retry: the old error message disappears, the server's new result shows.
    toggleAnswer = () => liked({ liked: true, count: 13 })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.like.liked'))
    expect(screen.getByRole('status')).not.toHaveTextContent(message)
  })

  it('401 (session expired): becomes a sign-in link, reports the expired session, and focus moves to that link', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    button.focus()
    toggleAnswer = () => Promise.resolve(json(401, { error: { code: 'UNAUTHENTICATED' } }))

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.queryByRole('button', { name: LIKE_NAME })).toBeNull()
    const link = screen.getByRole('link', { name: msg('Site.like.guestAriaLabel', { n: 12, count: '12' }) })
    await waitFor(() => expect(link).toHaveFocus())
    expect(screen.getByRole('status')).toHaveTextContent(SESSION_EXPIRED)
  })

  it('401 while focus is elsewhere: does not steal focus', async () => {
    await mount(READER)
    const button = await screen.findByRole('button', { name: LIKE_NAME })
    const elsewhere = screen.getByRole('link', { name: 'Other link' })
    elsewhere.focus()
    toggleAnswer = () => Promise.resolve(json(401, { error: { code: 'UNAUTHENTICATED' } }))

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.getByRole('link', { name: GUEST_LABEL_RE })).toBeInTheDocument()
    expect(elsewhere).toHaveFocus()
  })

  it('session becomes guest from elsewhere (sign-out in the header): button becomes a link, count kept, no new request', async () => {
    await mount(READER)
    await screen.findByRole('button', { name: LIKE_NAME })
    const { setAnonymous } = await import('@/lib/session-client')

    act(() => setAnonymous())

    expect(screen.getByRole('link', { name: msg('Site.like.guestAriaLabel', { n: 12, count: '12' }) })).toBeInTheDocument()
    expect(likeGets()).toHaveLength(1)
  })
})

describe('LikeButton: changing post', () => {
  it("a new slug is a new button: placeholder while asking, never showing the old post's count", async () => {
    const { view, LikeButton } = await mount(READER, { liked: true, count: 7 })
    await screen.findByRole('button', { name: msg('Site.like.ariaLabel', { n: 7, count: '7' }) })
    let answer: (response: Response) => void = () => {}
    likeAnswer = () => new Promise<Response>((resolve) => (answer = resolve))

    // Same tree as at mount: exactly the old instance receives the new slug (client-side navigation between two posts).
    view.rerender(
      <>
        <LikeButton slug="bai-khac" />
        <a href="/elsewhere">Other link</a>
      </>,
    )

    expect(screen.queryByRole('button', { name: LIKE_NAME })).toBeNull()
    await waitFor(() => expect(likeGets().at(-1)![0]).toBe('/api/posts/bai-khac/like'))
    await act(async () => answer(json(200, { data: { liked: false, count: 2 } })))
    expect(
      screen.getByRole('button', { name: msg('Site.like.ariaLabel', { n: 2, count: '2' }), pressed: false }),
    ).toBeInTheDocument()
  })
})
