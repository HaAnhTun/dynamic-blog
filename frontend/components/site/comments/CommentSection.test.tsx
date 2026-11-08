import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IntlWrapper } from '@/test/intl'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestCommentTarget } from '@/lib/comment-target'
import type { CommentPage, CommentThread, PublicComment, SessionUser } from '@/lib/types'
import { msg } from '@/test/render-intl'
import { currentTestLocale, translatorFor } from '@/test/intl'
import { AGO_VI } from '@/test/fixtures/vi/relative-time'

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exactly = (text: string) => new RegExp(`^${escapeRe(text)}$`)
const rawMsg = (key: string) => (translatorFor(currentTestLocale()) as unknown as { raw(key: string): string }).raw(key)
const EDITED_AT = rawMsg('Site.comments.item.editedAt').split(' <')[0]!
const EDITED_AT_START = new RegExp(`^${escapeRe(EDITED_AT)}`)
const EDITED_OR_INVALID = new RegExp(`${escapeRe(EDITED_AT.split(' ').pop()!)}|Invalid`)
const HEADING_RE = new RegExp(`<h2[^>]*id="binh-luan-heading"[^>]*>${escapeRe(msg('Site.comments.heading'))}</h2>`)
const NO_FORM_RE = new RegExp(
  `<textarea|<form|${escapeRe(msg('Site.account.signInWithGithub'))}|${escapeRe(msg('Site.comments.empty'))}`,
)
const LIKE_FULL = new RegExp(
  `^${escapeRe(msg('Site.comments.like.ariaLabel', { author: 'x', n: 0, count: '0' }).split('x')[0]!)}`,
)
const LIKE_NAME = new RegExp(
  `^${escapeRe(msg('Site.comments.like.ariaLabel', { author: 'x', n: 0, count: '0' }).split(' x ')[0]!)}`,
)
const ACTIONS_RE = new RegExp(
  `^(${['reply', 'edit', 'delete'].map((key) => escapeRe(msg(`Site.comments.item.${key}`))).join('|')})$`,
)
const LOAD_MORE_RE = new RegExp(`^(${escapeRe(msg('Site.comments.loadMore'))}|${escapeRe(msg('Site.comments.loadingMore'))})$`)

/**
 * The comments area runs with the REAL session store (lib/session-client.ts) and a fake `fetch`: exactly the path on a
 * real page — /api/session after mount, then GET a page of comments through the BFF route,
 * then POST/PUT/DELETE when writing. The store is module state, so every test reloads the module
 * (`vi.resetModules` + dynamic import), like LikeButton.test.tsx.
 *
 * jsdom has no IntersectionObserver: the area loads immediately (the fallback path). A separate describe
 * installs a fake IntersectionObserver to see the wait until it is near the screen.
 */

const SLUG = 'bai-viet'
const LIST = `/api/posts/${SLUG}/comments`

const READER: SessionUser = {
  displayName: 'Alice Reader',
  githubLogin: 'doc-gia',
  avatarUrl: null,
  role: 'USER',
  joinedAt: '2026-10-01T08:00:00Z',
  canAccessAdmin: false,
}

const SESSION_EXPIRED = msg('Errors.interaction.sessionExpired')

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function data(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(json(status, { data: body }))
}

function error(status: number, code: string): Promise<Response> {
  return Promise.resolve(json(status, { error: { code, message: 'English text that must never be shown' } }))
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function comment(n: number, extra: Partial<PublicComment> = {}): PublicComment {
  return {
    id: uuid(n),
    status: 'VISIBLE',
    content: `Comment number ${n}`,
    author: { displayName: `Writer ${n}`, githubLogin: `writer-${n}`, avatarUrl: null, siteOwner: false },
    createdAt: minutesAgo(3),
    edited: false,
    mine: false,
    editedAt: null,
    likeCount: 0,
    likedByMe: false,
    ...extra,
  }
}

/** Exactly the shape the older backend sends (not restarted after the upgrade): no `editedAt`, `likeCount`, `likedByMe`. */
function v5(n: number, extra: Partial<PublicComment> = {}): Record<string, unknown> {
  const shape: Record<string, unknown> = { ...comment(n, extra) }
  delete shape.editedAt
  delete shape.likeCount
  delete shape.likedByMe
  return shape
}

function thread(root: PublicComment, replies: PublicComment[] = []): CommentThread {
  return { comment: root, replies }
}

function page(threads: CommentThread[], nextCursor: string | null = null): CommentPage {
  return { threads, nextCursor }
}

type Answer = () => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn>
let sessionAnswer: Answer
/** GET a page of comments, by `after` (null is the first page). */
let listAnswer: (after: string | null) => Promise<Response>
/** POST / PUT / DELETE. */
let writeAnswer: (method: string, url: string, body: unknown) => Promise<Response>

function listGets(): string[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).startsWith(LIST) && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')
    .map(([url]) => String(url))
}

function writes(): { method: string; url: string; body: unknown }[] {
  return fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => {
      const request = init as RequestInit
      return {
        method: request.method ?? 'GET',
        url: String(url),
        body: typeof request.body === 'string' ? (JSON.parse(request.body) as unknown) : undefined,
      }
    })
}

beforeEach(() => {
  sessionStorage.clear()
  writeAnswer = () => Promise.reject(new Error('nobody wrote'))
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/session') return sessionAnswer()
    if (method === 'GET' && url.startsWith(LIST)) {
      return listAnswer(new URL(url, 'http://localhost').searchParams.get('after'))
    }
    if (method !== 'GET') {
      return writeAnswer(method, url, typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined)
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * `user`: the session /api/session returns; `'pending'`: never answers. `list`: the first page, or a
 * function that answers by `after`. Waits until the first page has been requested (unless the session hangs).
 */
async function mount(
  user: SessionUser | null | 'pending',
  list: CommentPage | ((after: string | null) => Promise<Response>) = page([]),
  language?: 'vi' | 'en',
) {
  sessionAnswer = user === 'pending' ? () => new Promise<Response>(() => {}) : () => data(user)
  listAnswer = typeof list === 'function' ? list : () => data(list)
  vi.resetModules()
  const { CommentSection } = await import('./CommentSection')
  const view = render(
    <>
      <CommentSection slug={SLUG} language={language} />
      <a href="/other">Other link</a>
    </>,
  )
  if (user !== 'pending') {
    await waitFor(() => expect(listGets().length).toBeGreaterThan(0))
    await act(async () => {})
  }
  return view
}

function section(): HTMLElement {
  return document.getElementById('binh-luan')!
}

function articleOf(id: string): HTMLElement {
  return section().querySelector<HTMLElement>(`article[data-comment-id="${id}"]`)!
}

function heading(): HTMLElement {
  return screen.getByRole('heading', { level: 2, name: msg('Site.comments.heading') })
}

function rootTextarea(): HTMLElement {
  return screen.getByRole('textbox', { name: msg('Site.comments.rootForm.label') })
}

async function postRoot(text: string) {
  fireEvent.change(rootTextarea(), { target: { value: text } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.rootForm.submit') }))
  })
}

describe('CommentSection: before loading', () => {
  it('server HTML: section#binh-luan has a name, a heading, a loading frame — no form, no invitation, no fetch', async () => {
    vi.resetModules()
    const { CommentSection } = await import('./CommentSection')

    const html = renderToString(
      <IntlWrapper>
        <CommentSection slug={SLUG} />
      </IntlWrapper>,
    )

    expect(html).toContain('id="binh-luan"')
    expect(html).toContain('aria-labelledby="binh-luan-heading"')
    expect(html).toMatch(HEADING_RE)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toMatch(NO_FORM_RE)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('not printed: the whole area, from the outermost frame (rule, padding) to the form', async () => {
    const { container } = await mount('pending')

    const root = container.firstElementChild!
    expect(root).toHaveClass('print:hidden')
    expect(root).toContainElement(section())
  })

  it('width: the default frame is the prose Container, the divider and rhythm stay on section#binh-luan', async () => {
    const { container } = await mount('pending')

    const root = container.firstElementChild!
    expect(root.className).toMatch(/max-w-3xl/)
    expect(root.className).toMatch(/px-4/)
    expect(section()).toHaveClass('border-t', 'border-neutral-200', 'py-10', 'dark:border-neutral-800')
    expect(section().className).not.toMatch(/mt-/)
    expect(section()).toHaveAttribute('aria-labelledby', 'binh-luan-heading')
  })

  it("width='reader' widens the frame", async () => {
    vi.resetModules()
    const { CommentSection } = await import('./CommentSection')
    const { container } = render(<CommentSection slug={SLUG} width="reader" />)

    expect(container.firstElementChild?.className).toContain('max-w-[87.5rem]')
  })

  it("width='bare': no Container classes, the section keeps its anchor, name, rule and padding, and stays out of print", async () => {
    vi.resetModules()
    const { CommentSection } = await import('./CommentSection')
    const { container } = render(<CommentSection slug={SLUG} width="bare" />)

    expect(container.innerHTML).not.toMatch(/max-w-[356]xl|px-4|sm:px-6|mx-auto/)
    expect(container.firstElementChild).toHaveClass('print:hidden')
    expect(container.firstElementChild).toContainElement(section())
    expect(section()).toHaveAttribute('aria-labelledby', 'binh-luan-heading')
    expect(section()).toHaveClass('border-t', 'py-10')
    expect(heading()).toBeInTheDocument()
  })

  it('waits for /api/session to answer before asking for comments: no token rotation race with it', async () => {
    await mount('pending')

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.anything()))
    expect(listGets()).toHaveLength(0)
    expect(section().querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('link', { name: new RegExp(escapeRe(msg('Site.comments.heading').toLowerCase())) })).toBeNull()
  })

  describe('with IntersectionObserver', () => {
    type Entry = Pick<IntersectionObserverEntry, 'isIntersecting'>
    const observers: FakeObserver[] = []

    class FakeObserver {
      readonly observed: Element[] = []
      disconnected = false
      constructor(
        readonly callback: (entries: Entry[]) => void,
        readonly options?: IntersectionObserverInit,
      ) {
        observers.push(this)
      }
      observe(element: Element) {
        this.observed.push(element)
      }
      disconnect() {
        this.disconnected = true
      }
      unobserve() {}
      takeRecords() {
        return []
      }
    }

    beforeEach(() => {
      observers.length = 0
      vi.stubGlobal('IntersectionObserver', FakeObserver)
    })

    it('only loads when the area comes within 800px of the screen, then stops observing', async () => {
      sessionAnswer = () => data(null)
      listAnswer = () => data(page([thread(comment(1))]))
      vi.resetModules()
      const { CommentSection } = await import('./CommentSection')
      render(<CommentSection slug={SLUG} />)

      await waitFor(() => expect(observers).toHaveLength(1))
      const observer = observers[0]!
      expect(observer.observed).toEqual([section()])
      expect(observer.options?.rootMargin).toBe('800px 0px')
      expect(listGets()).toHaveLength(0)

      // One "not yet" report loads nothing.
      act(() => observer.callback([{ isIntersecting: false }]))
      expect(listGets()).toHaveLength(0)

      await act(async () => observer.callback([{ isIntersecting: true }]))

      expect(listGets()).toEqual([LIST])
      expect(observer.disconnected).toBe(true)
      expect(await screen.findByText('Comment number 1')).toBeInTheDocument()
    })
  })
})

describe('CommentSection: state of the list', () => {
  it('loading: a placeholder frame with aria-busy; when loaded the frame goes', async () => {
    let answer: (response: Response) => void = () => {}
    await mount(null, () => new Promise<Response>((resolve) => (answer = resolve)))

    const skeleton = section().querySelector('[aria-busy="true"]')!
    expect(skeleton).toHaveTextContent(msg('Site.comments.loading'))

    await act(async () => answer(json(200, { data: page([thread(comment(1))]) })))

    expect(section().querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.getByText('Comment number 1')).toBeInTheDocument()
  })

  it('empty: the invitation sentence', async () => {
    await mount(null, page([]))

    expect(screen.getByText(msg('Site.comments.empty'))).toBeInTheDocument()
    expect(section().querySelector('ol')).toBeNull()
  })

  it.each([
    ['502', () => error(502, 'UPSTREAM_UNAVAILABLE')],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['payload off contract', () => data({ threads: [{ comment: { id: 1 } }], nextCursor: null })],
  ])(
    'error (%s): role="alert" "Could not load comments." and "Try again" reloads, focus on the heading',
    async (_label, failure) => {
      let fail = true
      await mount(null, () => (fail ? failure() : data(page([thread(comment(1))]))))

      expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.comments.loadFailed'))
      expect(screen.queryByText(msg('Site.comments.empty'))).toBeNull()

      fail = false
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))
      })

      expect(listGets()).toHaveLength(2)
      expect(await screen.findByText('Comment number 1')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(heading()).toHaveFocus()
    },
  )
})

describe('CommentSection: display', () => {
  it('roots in server order, replies indented under their own root', async () => {
    await mount(null, page([thread(comment(1), [comment(11), comment(12)]), thread(comment(2))]))

    const roots = within(section())
      .getAllByRole('listitem')
      .filter((li) => li.parentElement?.parentElement === section())
    expect(roots.map((li) => li.querySelector('article')!.getAttribute('data-comment-id'))).toEqual([uuid(1), uuid(2)])
    const replies = roots[0]!.querySelector('ol')!
    expect(replies.className).toMatch(/\bps-4\b/)
    expect(replies.className).toMatch(/\bsm:ps-10\b/)
    expect(
      within(replies)
        .getAllByRole('article')
        .map((a) => a.getAttribute('data-comment-id')),
    ).toEqual([uuid(11), uuid(12)])
    // A reply is not nested inside the <article> of its root: every comment is its own article.
    expect(articleOf(uuid(1)).querySelector('article')).toBeNull()
  })

  it('XSS: the content and the name are text, no element is created from them', async () => {
    const payloads = [
      '<img src=x onerror="window.__xss=1">',
      '<script>window.__xss=1</script>',
      '<a href="javascript:window.__xss=1">click</a>',
    ]
    await mount(
      null,
      page(
        payloads.map((content, i) =>
          thread(
            comment(i + 1, {
              content,
              author: {
                displayName: '<b onmouseover="window.__xss=1">Name</b>',
                githubLogin: 'x',
                avatarUrl: null,
                siteOwner: false,
              },
            }),
          ),
        ),
      ),
    )

    for (const content of payloads) expect(screen.getByText(content)).toBeInTheDocument()
    expect(screen.getAllByText('<b onmouseover="window.__xss=1">Name</b>')).toHaveLength(3)
    expect(section().querySelector('img, script, b, a[href^="javascript"]')).toBeNull()
    expect((window as unknown as { __xss?: unknown }).__xss).toBeUndefined()
  })

  it('placeholder: a deleted or hidden root that still has replies shows one sentence, no name, no content, no buttons', async () => {
    const deleted = comment(1, { status: 'DELETED', content: null, author: null })
    const hidden = comment(2, { status: 'HIDDEN', content: null, author: null })
    await mount(READER, page([thread(deleted, [comment(11)]), thread(hidden, [comment(21)])]))

    expect(articleOf(uuid(1))).toHaveTextContent(exactly(msg('Site.comments.item.deleted')))
    expect(articleOf(uuid(2))).toHaveTextContent(exactly(msg('Site.comments.item.hidden')))
    expect(articleOf(uuid(1))).toHaveAccessibleName(msg('Site.comments.item.deleted'))
    expect(within(articleOf(uuid(1))).queryByRole('button')).toBeNull()
    expect(within(articleOf(uuid(2))).queryByRole('button')).toBeNull()
    // Their replies still show as usual.
    expect(screen.getByText('Comment number 11')).toBeInTheDocument()
  })

  it('pre-wrap: the leading whitespace and newlines of pasted code are kept as they are', async () => {
    const code = '  if (x) {\n      return y\n  }'
    await mount(null, page([thread(comment(1, { content: code }))]))

    const body = articleOf(uuid(1)).querySelector('p.whitespace-pre-wrap')!
    expect(body.textContent).toBe(code)
    expect(body.className).toContain('[overflow-wrap:anywhere]')
  })

  it('name in <bdi>, @login only when present — never "@null" for an admin or an author with only a password', async () => {
    const admin = comment(1, { author: { displayName: 'Blog Admin', githubLogin: null, avatarUrl: null, siteOwner: true } })
    const reader = comment(2, {
      author: { displayName: 'Reader Bob', githubLogin: 'reader-bob', avatarUrl: null, siteOwner: false },
    })
    await mount(null, page([thread(admin), thread(reader)]))

    const name = within(articleOf(uuid(1))).getByText('Blog Admin')
    expect(name.tagName).toBe('BDI')
    expect(articleOf(uuid(1))).toHaveAccessibleName('Blog Admin')
    expect(articleOf(uuid(1)).textContent).not.toContain('@')
    expect(section().textContent).not.toContain('null')
    expect(within(articleOf(uuid(2))).getByText('@reader-bob')).toBeInTheDocument()
  })

  describe('the "Site owner" label', () => {
    const BADGE = msg('Site.comments.item.ownerBadge')

    it('only by the server siteOwner flag: a reader who picks a name equal to the site owner name gets no label', async () => {
      // A reader's display name follows their GitHub profile, and anyone can choose the exact name of the site owner. The label
      // only comes from the server (the author is ADMIN), never from comparing a name or login.
      const owner = comment(1, {
        author: { displayName: 'Sam Example', githubLogin: 'sam-example', avatarUrl: null, siteOwner: true },
      })
      const impostor = comment(2, {
        author: { displayName: 'Sam Example', githubLogin: 'sam-example', avatarUrl: null, siteOwner: false },
      })
      await mount(null, page([thread(owner, [impostor])]))

      expect(within(articleOf(uuid(1))).getByText(BADGE)).toBeInTheDocument()
      expect(within(articleOf(uuid(2))).queryByText(BADGE)).toBeNull()
      expect(screen.getAllByText(BADGE)).toHaveLength(1)
    })

    it('sits right after the name in the meta line, not inside <bdi>, does not change the comment name', async () => {
      await mount(
        null,
        page([
          thread(
            comment(1, { author: { displayName: 'Blog Admin', githubLogin: 'blog-admin', avatarUrl: null, siteOwner: true } }),
          ),
        ]),
      )

      const name = within(articleOf(uuid(1))).getByText('Blog Admin')
      const badge = within(articleOf(uuid(1))).getByText(BADGE)
      expect(name.nextElementSibling).toBe(badge)
      expect(name.contains(badge)).toBe(false)
      // The name of the <article> (aria-labelledby pointing into the <bdi>) is still only the author name.
      expect(articleOf(uuid(1))).toHaveAccessibleName('Blog Admin')
      // One line: the label does not break between its two words at 320px.
      expect(badge).toHaveClass('whitespace-nowrap')
    })

    it('a reply by the site owner also has the label; when the backend has not sent the flag nobody has it', async () => {
      const ownerReply = comment(11, {
        author: { displayName: 'Blog Admin', githubLogin: null, avatarUrl: null, siteOwner: true },
      })
      const first = await mount(null, page([thread(comment(1), [ownerReply])]))
      expect(within(articleOf(uuid(11))).getByText(BADGE)).toBeInTheDocument()
      expect(within(articleOf(uuid(1))).queryByText(BADGE)).toBeNull()
      first.unmount()

      // Payload of an older backend: the author has no `siteOwner` — the comment still shows, no label.
      const legacy = { displayName: 'Blog Admin', githubLogin: null, avatarUrl: null }
      await mount(null, () => data({ threads: [{ comment: { ...comment(3), author: legacy }, replies: [] }], nextCursor: null }))
      expect(within(articleOf(uuid(3))).getByText('Blog Admin')).toBeInTheDocument()
      expect(within(articleOf(uuid(3))).queryByText(BADGE)).toBeNull()
    })
  })

  describe('date and time (the suite pins TZ=Asia/Ho_Chi_Minh, UTC+7)', () => {
    // A fixed clock, only Date: the relative time and the clock time can both be read from one reference point.
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-10-08T08:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** The line with the name, @login, time of one comment. */
    function metaOf(id: string): HTMLElement {
      return articleOf(id).querySelector<HTMLElement>('p')!
    }

    it('the posting date and time is visible text, in the reader time, in <time dateTime>; the relative time comes after, as secondary text', async () => {
      await mount(null, page([thread(comment(1, { createdAt: '2026-10-08T07:57:00Z' }))]))

      const time = articleOf(uuid(1)).querySelector('time')!
      expect(time).toHaveTextContent(/^14:57, 08\/10\/2026$/)
      expect(time).toHaveAttribute('dateTime', '2026-10-08T07:57:00Z')
      // The exact time is no longer hidden in `title`: a phone never shows it.
      expect(time).not.toHaveAttribute('title')
      const relative = within(metaOf(uuid(1))).getByText(AGO_VI.minutes3)
      expect(relative.tagName).toBe('SPAN')
      expect(relative).toHaveClass('text-neutral-500')
      expect(metaOf(uuid(1))).toHaveTextContent(`Writer 1@writer-1·14:57, 08/10/2026·${AGO_VI.minutes3}`)
    })

    it('past midnight by the reader time: the reader date, not the UTC date', async () => {
      await mount(null, page([thread(comment(1, { createdAt: '2026-10-07T17:30:00Z' }))]))

      expect(articleOf(uuid(1)).querySelector('time')).toHaveTextContent('00:30, 08/10/2026')
    })

    it('"edited at HH:mm" when edited on the same day, the full date and time when edited on another day', async () => {
      await mount(
        null,
        page([
          thread(comment(1, { createdAt: '2026-10-08T01:00:00Z', edited: true, editedAt: '2026-10-08T07:02:00Z' })),
          thread(comment(2, { createdAt: '2026-10-06T01:00:00Z', edited: true, editedAt: '2026-10-07T03:15:00Z' })),
          thread(comment(3, { createdAt: '2026-10-08T01:00:00Z' })),
        ]),
      )

      const sameDay = within(metaOf(uuid(1))).getByText(EDITED_AT_START)
      expect(sameDay).toHaveTextContent(exactly(`${EDITED_AT} 14:02`))
      expect(sameDay.querySelector('time')).toHaveAttribute('dateTime', '2026-10-08T07:02:00Z')
      expect(within(metaOf(uuid(2))).getByText(EDITED_AT_START)).toHaveTextContent(exactly(`${EDITED_AT} 10:15, 07/10/2026`))
      expect(metaOf(uuid(3))).not.toHaveTextContent(msg('Site.comments.item.edited'))
    })

    it('edited but the edit time is unreadable: a bare "edited", never "Invalid Date"', async () => {
      await mount(null, page([thread(comment(1, { edited: true, editedAt: 'not a time' }))]))

      expect(within(metaOf(uuid(1))).getByText(msg('Site.comments.item.edited'))).toBeInTheDocument()
      expect(metaOf(uuid(1))).not.toHaveTextContent(EDITED_OR_INVALID)
    })
  })

  it('the older backend (not restarted): the comment still shows, no like button, a bare "edited"', async () => {
    await mount(READER, () => data({ threads: [{ comment: v5(1, { edited: true }), replies: [v5(11)] }], nextCursor: null }))

    expect(screen.getByText('Comment number 1')).toBeInTheDocument()
    expect(screen.getByText('Comment number 11')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: LIKE_NAME })).toBeNull()
    expect(section().querySelector('[data-like-count]')).toBeNull()
    expect(within(articleOf(uuid(1))).getByText(msg('Site.comments.item.edited'))).toBeInTheDocument()
    expect(articleOf(uuid(1))).not.toHaveTextContent(EDITED_AT)
    // The older backend buttons are all still there.
    expect(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') })).toBeInTheDocument()
  })
})

describe('CommentSection: guest', () => {
  it('the sign-in invitation of an English post returns to its own language URL', async () => {
    await mount(null, page([]), 'en')

    const link = screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fen%2Fposts%2Fbai-viet%23binh-luan')
  })

  it('the sign-in invitation returns to exactly #binh-luan; no form, no write button', async () => {
    // The server never sends mine=true to a guest; if it did, the UI still would not offer to edit.
    await mount(null, page([thread(comment(1, { mine: true }), [comment(11)])]))

    const link = screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })
    expect(link).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fposts%2Fbai-viet%23binh-luan')
    expect(link).toHaveAttribute('rel', 'nofollow')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: ACTIONS_RE })).toBeNull()
  })
})

describe('CommentSection: load more', () => {
  it('goes on by cursor, appends after the existing roots, focus on the first root just loaded; when exhausted the button goes', async () => {
    await mount(null, (after) =>
      after === null
        ? data(page([thread(comment(1)), thread(comment(2))], 'con-tro-2'))
        : data(page([thread(comment(3)), thread(comment(4))], null)),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })

    expect(listGets()).toEqual([LIST, `${LIST}?after=con-tro-2`])
    const ids = [...section().querySelectorAll('article[data-comment-id]')].map((a) => a.getAttribute('data-comment-id'))
    expect(ids).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)])
    expect(articleOf(uuid(3))).toHaveFocus()
    expect(screen.queryByRole('button', { name: msg('Site.comments.loadMore') })).toBeNull()
  })

  it('two quick presses: one request; while loading "Loading…" and the list aria-busy', async () => {
    let answer: (response: Response) => void = () => {}
    await mount(null, (after) =>
      after === null ? data(page([thread(comment(1))], 'c2')) : new Promise<Response>((resolve) => (answer = resolve)),
    )
    const more = screen.getByRole('button', { name: msg('Site.comments.loadMore') })

    fireEvent.click(more)
    fireEvent.click(more)

    expect(listGets()).toHaveLength(2)
    expect(more).toHaveTextContent(msg('Site.bookmarks.loading'))
    expect(more).toHaveAttribute('aria-disabled', 'true')
    expect(section().querySelector('ol')).toHaveAttribute('aria-busy', 'true')
    await act(async () => answer(json(200, { data: page([thread(comment(2))]) })))
    expect(screen.getByText('Comment number 2')).toBeInTheDocument()
  })

  it('failure: an error sentence, the list stays, the button is still there to retry', async () => {
    let fail = true
    await mount(null, (after) =>
      after === null
        ? data(page([thread(comment(1))], 'c2'))
        : fail
          ? error(503, 'UPSTREAM_UNAVAILABLE')
          : data(page([thread(comment(2))])),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.comments.loadFailed'))
    expect(screen.getByText('Comment number 1')).toBeInTheDocument()

    fail = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })
    expect(screen.getByText('Comment number 2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CommentSection: posting a comment', () => {
  it('post: POST the sanitized version, the new comment at the end, the writing box empty, focus on it, announces "Comment posted"', async () => {
    await mount(READER, page([thread(comment(1))]))
    const mine = comment(50, {
      content: 'Great post',
      mine: true,
      createdAt: minutesAgo(0),
      author: { displayName: READER.displayName, githubLogin: 'doc-gia', avatarUrl: null, siteOwner: false },
    })
    writeAnswer = () => data(mine, 201)

    await postRoot('  Great post  ')

    expect(writes()).toEqual([{ method: 'POST', url: LIST, body: { content: 'Great post' } }])
    const ids = [...section().querySelectorAll('article[data-comment-id]')].map((a) => a.getAttribute('data-comment-id'))
    expect(ids).toEqual([uuid(1), uuid(50)])
    expect(rootTextarea()).toHaveValue('')
    expect(articleOf(uuid(50))).toHaveFocus()
    expect(articleOf(uuid(50))).toHaveTextContent(msg('Site.time.justNow'))
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.posted'))
    // Mine: has edit and delete.
    expect(within(articleOf(uuid(50))).getByRole('button', { name: msg('Site.comments.item.edit') })).toBeInTheDocument()
  })

  it('DE-DUPLICATION: "Show more comments" right after posting returns that very comment → it shows only once', async () => {
    const mine = comment(50, { mine: true, content: 'Mine' })
    await mount(READER, (after) =>
      after === null ? data(page([thread(comment(1))], 'c2')) : data(page([thread(comment(2)), thread(mine)], null)),
    )
    writeAnswer = () => data(mine, 201)
    await postRoot('Mine')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })

    expect(screen.getAllByText('Mine')).toHaveLength(1)
    const ids = [...section().querySelectorAll('article[data-comment-id]')].map((a) => a.getAttribute('data-comment-id'))
    expect(ids).toEqual([uuid(1), uuid(2), uuid(50)])
  })

  it.each([
    [429, 'RATE_LIMITED', msg('Errors.interaction.byCode.RATE_LIMITED')],
    [413, 'PAYLOAD_TOO_LARGE', msg('Errors.interaction.invalid.comment')],
    [400, 'VALIDATION_ERROR', msg('Errors.interaction.invalid.comment')],
    [409, 'COMMENT_DUPLICATE', msg('Errors.interaction.byCode.COMMENT_DUPLICATE')],
    [403, 'USER_SUSPENDED', msg('Errors.interaction.userSuspended.comment')],
    [404, 'POST_NOT_FOUND', msg('Errors.interaction.postNotFound.comment')],
    [502, 'UPSTREAM_UNAVAILABLE', msg('Site.profile.author.errors.network')],
  ])('%i %s: Vietnamese sentence in role="alert", text kept, nothing added to the list', async (status, code, message) => {
    await mount(READER, page([]))
    writeAnswer = () => error(status, code)

    await postRoot('A comment')

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('alert')).not.toHaveTextContent('English')
    expect(rootTextarea()).toHaveValue('A comment')
    expect(section().querySelector('article')).toBeNull()
  })

  it('401: becomes a sign-in invitation with "Your session has ended…", focus to the link; after signing in again the text is still there', async () => {
    await mount(READER, page([]))
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    fireEvent.change(rootTextarea(), { target: { value: 'Long writing at last done' } })
    const submit = screen.getByRole('button', { name: msg('Site.comments.rootForm.submit') })
    submit.focus()

    await act(async () => {
      fireEvent.click(submit)
    })

    expect(screen.queryByRole('textbox')).toBeNull()
    const link = screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_EXPIRED)
    await waitFor(() => expect(link).toHaveFocus())

    // Signing in is a fresh page load (OAuth goes through GitHub): a new module, the same author.
    await mount(READER, page([]))
    expect(rootTextarea()).toHaveValue('Long writing at last done')
    expect(sessionStorage.length).toBe(0)
  })

  it('a draft after 401 never goes to another person who signs in on the same tab', async () => {
    await mount(READER, page([]))
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    await postRoot('Only mine')

    await mount({ ...READER, displayName: 'Someone else', githubLogin: 'someone-else' }, page([]))

    expect(rootTextarea()).toHaveValue('')
    expect(sessionStorage.length).toBe(0)
  })
})

describe('CommentSection: reply', () => {
  it('"Reply" only on a root that is still visible, when signed in, and when the thread has fewer than 30 replies', async () => {
    const deleted = comment(2, { status: 'DELETED', content: null, author: null })
    const full = thread(
      comment(3),
      Array.from({ length: 30 }, (_, i) => comment(300 + i)),
    )
    await mount(READER, page([thread(comment(1), [comment(11)]), thread(deleted, [comment(21)]), full]))

    expect(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') })).toBeInTheDocument()
    expect(within(articleOf(uuid(11))).queryByRole('button', { name: msg('Site.comments.item.reply') })).toBeNull()
    expect(within(articleOf(uuid(2))).queryByRole('button', { name: msg('Site.comments.item.reply') })).toBeNull()
    expect(within(articleOf(uuid(3))).queryByRole('button', { name: msg('Site.comments.item.reply') })).toBeNull()
  })

  it('open: a reply box with focus, the button reports aria-expanded; Escape or "Cancel" closes and returns focus to "Reply"', async () => {
    await mount(READER, page([thread(comment(1))]))
    const reply = within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') })

    fireEvent.click(reply)
    const box = screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') })
    expect(box).toHaveFocus()
    expect(reply).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: msg('Site.comments.replyForm.label') })).toBeNull()
    expect(reply).toHaveFocus()
    expect(reply).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(reply)
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }))
    expect(screen.queryByRole('textbox', { name: msg('Site.comments.replyForm.label') })).toBeNull()
    expect(reply).toHaveFocus()
  })

  it('one box at a time: opening a reply on another root closes the old box', async () => {
    await mount(READER, page([thread(comment(1)), thread(comment(2))]))

    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.click(within(articleOf(uuid(2))).getByRole('button', { name: msg('Site.comments.item.reply') }))

    const boxes = screen.getAllByRole('textbox', { name: msg('Site.comments.replyForm.label') })
    expect(boxes).toHaveLength(1)
    expect(articleOf(uuid(2)).closest('li')!.contains(boxes[0]!)).toBe(true)
  })

  it('submit: POST /api/comments/<root>/replies, the reply is appended to the end of the thread, the box closes, focus on the new reply', async () => {
    await mount(READER, page([thread(comment(1), [comment(11)]), thread(comment(2))]))
    const answer = comment(12, { content: 'Agreed', mine: true })
    writeAnswer = () => data(answer, 201)
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') }), { target: { value: 'Agreed' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    expect(writes()).toEqual([{ method: 'POST', url: `/api/comments/${uuid(1)}/replies`, body: { content: 'Agreed' } }])
    const thread1 = articleOf(uuid(1)).closest('li')!
    // `:scope >`: a bare "ol article" selector would also match the root list <ol> that wraps this <li>.
    expect([...thread1.querySelectorAll(':scope > ol article')].map((a) => a.getAttribute('data-comment-id'))).toEqual([
      uuid(11),
      uuid(12),
    ])
    expect(screen.queryByRole('textbox', { name: msg('Site.comments.replyForm.label') })).toBeNull()
    expect(articleOf(uuid(12))).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.replied'))
  })

  it('thread full (422): the error sentence in the reply box, the text kept', async () => {
    await mount(READER, page([thread(comment(1))]))
    writeAnswer = () => error(422, 'COMMENT_NOT_REPLYABLE')
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') }), {
      target: { value: 'Late reply' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.interaction.byCode.COMMENT_NOT_REPLYABLE'))
    expect(screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') })).toHaveValue('Late reply')
  })
})

describe('CommentSection: 401 on reply or edit (an error keeps the text)', () => {
  const REPLY_BOX = { name: msg('Site.comments.replyForm.label') }
  const EDIT_BOX = { name: msg('Site.comments.item.editLabel') }

  it('reply: the box disappears with the signed-in UI, but after signing in again the box reopens on exactly that root, with all the text, with focus', async () => {
    const threads = page([thread(comment(1)), thread(comment(2))])
    const first = await mount(READER, threads)
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    fireEvent.click(within(articleOf(uuid(2))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', REPLY_BOX), { target: { value: 'A long reply' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    expect(screen.queryByRole('textbox', REPLY_BOX)).toBeNull()
    expect(screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_EXPIRED)

    // Signing in is a fresh page load: a new module, the same author.
    first.unmount()
    await mount(READER, threads)
    const box = screen.getByRole('textbox', REPLY_BOX)
    expect(box).toHaveValue('A long reply')
    expect(articleOf(uuid(2)).closest('li')!.contains(box)).toBe(true)
    expect(box).toHaveFocus()
    expect(sessionStorage.length).toBe(0)

    // It can be resubmitted right away, into exactly that root.
    writeAnswer = () => data(comment(22, { content: 'A long reply', mine: true }), 201)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })
    expect(writes().at(-1)).toEqual({
      method: 'POST',
      url: `/api/comments/${uuid(2)}/replies`,
      body: { content: 'A long reply' },
    })
    expect(screen.queryByRole('textbox', REPLY_BOX)).toBeNull()

    // Open that reply box once more: empty, the draft is used up.
    fireEvent.click(within(articleOf(uuid(2))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    expect(screen.getByRole('textbox', REPLY_BOX)).toHaveValue('')
  })

  it('edit: after signing in again the edit box reopens with the half-edited text, not the old content', async () => {
    const threads = page([thread(comment(1), [comment(11, { mine: true, content: 'Old version' })])])
    const first = await mount(READER, threads)
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    fireEvent.click(within(articleOf(uuid(11))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    fireEvent.change(screen.getByRole('textbox', EDIT_BOX), { target: { value: 'New draft' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.item.editSave') }))
    })
    expect(screen.queryByRole('textbox', EDIT_BOX)).toBeNull()

    first.unmount()
    await mount(READER, threads)
    const box = screen.getByRole('textbox', EDIT_BOX)
    expect(box).toHaveValue('New draft')
    expect(articleOf(uuid(11)).contains(box)).toBe(true)
    expect(sessionStorage.length).toBe(0)

    // Cancel discards the draft: reopening the edit box shows the content being stored.
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }))
    fireEvent.click(within(articleOf(uuid(11))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    expect(screen.getByRole('textbox', EDIT_BOX)).toHaveValue('Old version')
  })

  it('target comment on a later page: the box reopens when "Show more comments" loads it, and focus stays in the box', async () => {
    const pages = (after: string | null) =>
      after === null ? data(page([thread(comment(1))], 'c1')) : data(page([thread(comment(2))]))
    const first = await mount(READER, pages)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    fireEvent.click(within(articleOf(uuid(2))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', REPLY_BOX), { target: { value: 'Reply on page two' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    first.unmount()
    await mount(READER, pages)
    expect(screen.queryByRole('textbox', REPLY_BOX)).toBeNull()
    const more = screen.getByRole('button', { name: msg('Site.comments.loadMore') })
    more.focus()
    await act(async () => {
      fireEvent.click(more)
    })

    const box = screen.getByRole('textbox', REPLY_BOX)
    expect(box).toHaveValue('Reply on page two')
    expect(articleOf(uuid(2)).closest('li')!.contains(box)).toBe(true)
    expect(box).toHaveFocus()
  })

  it('the reader is writing in another box when the page of the target comment arrives: that box is not closed abruptly', async () => {
    const pages = (after: string | null) =>
      after === null ? data(page([thread(comment(1))], 'c1')) : data(page([thread(comment(2))]))
    const first = await mount(READER, pages)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    fireEvent.click(within(articleOf(uuid(2))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', REPLY_BOX), { target: { value: 'Draft for root two' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    first.unmount()
    await mount(READER, pages)
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', REPLY_BOX), { target: { value: 'Writing at root one' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })

    const boxes = screen.getAllByRole('textbox', REPLY_BOX)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toHaveValue('Writing at root one')
    expect(articleOf(uuid(1)).closest('li')!.contains(boxes[0]!)).toBe(true)
  })

  it('a reply draft never goes to another person who signs in on the same tab', async () => {
    const threads = page([thread(comment(1))])
    const first = await mount(READER, threads)
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', REPLY_BOX), { target: { value: 'Only mine' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    first.unmount()
    await mount({ ...READER, displayName: 'Someone else', githubLogin: 'someone-else' }, threads)

    expect(screen.queryByRole('textbox', REPLY_BOX)).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })
})

describe('CommentSection: edit', () => {
  it('"Edit", "Delete" only on your own comment', async () => {
    await mount(READER, page([thread(comment(1, { mine: true }), [comment(11), comment(12, { mine: true })])]))

    for (const id of [uuid(1), uuid(12)]) {
      expect(within(articleOf(id)).getByRole('button', { name: msg('Site.comments.item.edit') })).toBeInTheDocument()
      expect(within(articleOf(id)).getByRole('button', { name: msg('Site.comments.item.delete') })).toBeInTheDocument()
    }
    expect(within(articleOf(uuid(11))).queryByRole('button', { name: msg('Site.comments.item.edit') })).toBeNull()
    expect(within(articleOf(uuid(11))).queryByRole('button', { name: msg('Site.comments.item.delete') })).toBeNull()
  })

  it('save: the pre-filled edit box has focus; PUT the new version; the content changes, "edited" shows, focus returns to "Edit"', async () => {
    await mount(READER, page([thread(comment(1, { mine: true, content: 'Old version' }))]))
    writeAnswer = () => data(comment(1, { mine: true, content: 'New version', edited: true }))

    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    const box = screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') })
    expect(box).toHaveValue('Old version')
    expect(box).toHaveFocus()
    expect(within(articleOf(uuid(1))).queryByText('Old version', { selector: 'p' })).toBeNull()

    fireEvent.change(box, { target: { value: 'New version' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.item.editSave') }))
    })

    expect(writes()).toEqual([{ method: 'PUT', url: `/api/comments/${uuid(1)}`, body: { content: 'New version' } }])
    expect(screen.queryByRole('textbox', { name: msg('Site.comments.item.editLabel') })).toBeNull()
    expect(within(articleOf(uuid(1))).getByText('New version')).toBeInTheDocument()
    expect(within(articleOf(uuid(1))).getByText(msg('Site.comments.item.edited'))).toBeInTheDocument()
    expect(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.saved'))
  })

  it('"Cancel" or Escape: the content does not change, no request, focus returns to "Edit"', async () => {
    await mount(READER, page([thread(comment(1, { mine: true, content: 'Keep as is' }))]))

    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    fireEvent.change(screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') }), {
      target: { value: 'Changed mind' },
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') }), { key: 'Escape' })

    expect(within(articleOf(uuid(1))).getByText('Keep as is')).toBeInTheDocument()
    expect(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') })).toHaveFocus()

    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.form.cancel') }))
    expect(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') })).toHaveFocus()
    expect(writes()).toEqual([])
  })
})

describe('CommentSection: delete', () => {
  async function confirmDelete(id: string) {
    fireEvent.click(within(articleOf(id)).getByRole('button', { name: msg('Site.comments.item.delete') }))
    await act(async () => {
      fireEvent.click(
        within(within(articleOf(id)).getByRole('group')).getByRole('button', { name: msg('Site.comments.item.delete') }),
      )
    })
  }

  it('in-place confirmation, focus on "Cancel"; "Cancel" returns focus to "Delete" and deletes nothing', async () => {
    await mount(READER, page([thread(comment(1, { mine: true }))]))

    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.delete') }))

    const group = within(articleOf(uuid(1))).getByRole('group', { name: msg('Site.comments.item.deleteConfirm') })
    expect(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()
    fireEvent.click(within(group).getByRole('button', { name: msg('Site.comments.form.cancel') }))
    expect(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.delete') })).toHaveFocus()
    expect(writes()).toEqual([])
  })

  it('a root with replies: DELETE, becomes a placeholder "This comment was deleted.", focus on the next reply, announces "Comment deleted"', async () => {
    await mount(READER, page([thread(comment(1, { mine: true }), [comment(11)])]))
    writeAnswer = () => Promise.resolve(new Response(null, { status: 204 }))

    await confirmDelete(uuid(1))

    expect(writes()).toEqual([{ method: 'DELETE', url: `/api/comments/${uuid(1)}`, body: undefined }])
    expect(articleOf(uuid(1))).toHaveTextContent(exactly(msg('Site.comments.item.deleted')))
    expect(articleOf(uuid(11))).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.deleted'))
  })

  it('a root without replies: disappears, focus goes to the next root; the last one goes to the previous root; with nothing left, the heading', async () => {
    await mount(
      READER,
      page([thread(comment(1, { mine: true })), thread(comment(2, { mine: true })), thread(comment(3, { mine: true }))]),
    )
    writeAnswer = () => Promise.resolve(new Response(null, { status: 204 }))

    await confirmDelete(uuid(2))
    expect(articleOf(uuid(2))).toBeNull()
    expect(articleOf(uuid(3))).toHaveFocus()

    await confirmDelete(uuid(3))
    expect(articleOf(uuid(1))).toHaveFocus()

    await confirmDelete(uuid(1))
    expect(section().querySelector('article')).toBeNull()
    expect(heading()).toHaveFocus()
    expect(screen.getByText(msg('Site.comments.empty'))).toBeInTheDocument()
  })

  it('delete a reply: disappears, focus goes to the next comment', async () => {
    await mount(READER, page([thread(comment(1), [comment(11, { mine: true }), comment(12)])]))
    writeAnswer = () => Promise.resolve(new Response(null, { status: 204 }))

    await confirmDelete(uuid(11))

    expect(articleOf(uuid(11))).toBeNull()
    expect(articleOf(uuid(12))).toHaveFocus()
  })

  it('failure (404): an error sentence in the confirmation, the comment intact', async () => {
    await mount(READER, page([thread(comment(1, { mine: true }))]))
    writeAnswer = () => error(404, 'COMMENT_NOT_FOUND')

    await confirmDelete(uuid(1))

    expect(within(articleOf(uuid(1))).getByRole('alert')).toHaveTextContent(msg('Errors.interaction.byCode.COMMENT_NOT_FOUND'))
    expect(within(articleOf(uuid(1))).getByText('Comment number 1')).toBeInTheDocument()
  })
})

describe('CommentSection: a write in flight', () => {
  /** The next write hangs until the test answers it. */
  function holdWrite(): (response: Response) => Promise<void> {
    let resolve: (response: Response) => void = () => {}
    writeAnswer = () => new Promise<Response>((done) => (resolve = done))
    return (response) =>
      act(async () => {
        resolve(response)
      })
  }

  function button(id: string, name: string): HTMLElement {
    return within(articleOf(id)).getByRole('button', { name })
  }

  function replyBox(): HTMLElement | null {
    return screen.queryByRole('textbox', { name: msg('Site.comments.replyForm.label') })
  }

  async function sendReply(rootId: string, text: string) {
    fireEvent.click(button(rootId, msg('Site.comments.item.reply')))
    fireEvent.change(replyBox()!, { target: { value: text } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })
  }

  /** No reply form, edit form or delete confirmation is open; the root comment box is always there. */
  function expectNoSlotOpen() {
    expect(replyBox()).toBeNull()
    expect(screen.queryByRole('textbox', { name: msg('Site.comments.item.editLabel') })).toBeNull()
    expect(screen.queryByRole('group')).toBeNull()
  }

  it('a pending reply: every action button aria-disabled, pressing opens or closes nothing; a 429 shows in the reply box, the text intact', async () => {
    await mount(READER, page([thread(comment(1)), thread(comment(2, { mine: true }))]))
    const answer = holdWrite()
    await sendReply(uuid(1), 'Quick reply')
    const toggle = button(uuid(1), msg('Site.comments.item.reply'))

    for (const control of [
      toggle,
      button(uuid(2), msg('Site.comments.item.reply')),
      button(uuid(2), msg('Site.comments.item.edit')),
      button(uuid(2), msg('Site.comments.item.delete')),
    ]) {
      expect(control).toHaveAttribute('aria-disabled', 'true')
    }
    // Adversarial presses: open edit on another comment, press reply of this very root again (the toggle button), open
    // delete, open a reply on another root. No press may replace the pending spot.
    fireEvent.click(button(uuid(2), msg('Site.comments.item.edit')))
    fireEvent.click(toggle)
    fireEvent.click(button(uuid(2), msg('Site.comments.item.delete')))
    fireEvent.click(button(uuid(2), msg('Site.comments.item.reply')))

    expect(screen.queryByRole('textbox', { name: msg('Site.comments.item.editLabel') })).toBeNull()
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getAllByRole('textbox', { name: msg('Site.comments.replyForm.label') })).toHaveLength(1)
    expect(articleOf(uuid(1)).closest('li')!.contains(replyBox())).toBe(true)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await answer(json(429, { error: { code: 'RATE_LIMITED', message: 'English text that must never be shown' } }))

    expect(within(replyBox()!.closest('form')!).getByRole('alert')).toHaveTextContent(
      msg('Errors.interaction.byCode.RATE_LIMITED'),
    )
    expect(replyBox()).toHaveValue('Quick reply')
    expect(writes()).toHaveLength(1)
    // Once there is a result the lock is gone.
    expect(toggle).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button(uuid(2), msg('Site.comments.item.edit')))
    expect(screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') })).toHaveFocus()
    expect(replyBox()).toBeNull()
  })

  it('a press that arrives before the next render is also blocked: the lock is a ref, not waiting for state', async () => {
    await mount(READER, page([thread(comment(1)), thread(comment(2, { mine: true }))]))
    const answer = holdWrite()
    fireEvent.click(button(uuid(1), msg('Site.comments.item.reply')))
    fireEvent.change(replyBox()!, { target: { value: 'Nhanh tay' } })

    // The same act: React has not re-rendered between the two presses, the edit button is still the unlocked one.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
      fireEvent.click(button(uuid(2), msg('Site.comments.item.edit')))
    })

    expect(screen.queryByRole('textbox', { name: msg('Site.comments.item.editLabel') })).toBeNull()
    await answer(json(429, { error: { code: 'RATE_LIMITED', message: 'English text that must never be shown' } }))
    expect(within(replyBox()!.closest('form')!).getByRole('alert')).toHaveTextContent(
      msg('Errors.interaction.byCode.RATE_LIMITED'),
    )
    expect(replyBox()).toHaveValue('Nhanh tay')
  })

  /** Three writes into one spot: open and submit, the server successful reply, where focus goes afterwards. */
  const SLOT_WRITES: [string, () => Promise<void>, () => Response, () => HTMLElement][] = [
    [
      'reply',
      () => sendReply(uuid(1), 'Agreed'),
      () => json(201, { data: comment(12, { mine: true, content: 'Agreed' }) }),
      () => articleOf(uuid(12)),
    ],
    [
      'edit',
      async () => {
        fireEvent.click(button(uuid(1), msg('Site.comments.item.edit')))
        fireEvent.change(screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') }), {
          target: { value: 'New version' },
        })
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.item.editSave') }))
        })
      },
      () => json(200, { data: comment(1, { mine: true, content: 'New version', edited: true }) }),
      () => button(uuid(1), msg('Site.comments.item.edit')),
    ],
    [
      'delete',
      async () => {
        fireEvent.click(button(uuid(1), msg('Site.comments.item.delete')))
        await act(async () => {
          fireEvent.click(
            within(within(articleOf(uuid(1))).getByRole('group')).getByRole('button', { name: msg('Site.comments.item.delete') }),
          )
        })
      },
      () => new Response(null, { status: 204 }),
      () => articleOf(uuid(2)),
    ],
  ]

  /** Root 1 is mine; root 2 belongs to someone else, with reply 21 that is mine: every button, to try opening another spot. */
  const SLOT_PAGE = () => page([thread(comment(1, { mine: true })), thread(comment(2), [comment(21, { mine: true })])])

  it.each(SLOT_WRITES)(
    '%s pending: no other spot can be opened; when done only its own spot closes, focus goes to the result, then the lock is gone',
    async (_label, start, success, focused) => {
      await mount(READER, SLOT_PAGE())
      const answer = holdWrite()
      await start()

      fireEvent.click(button(uuid(2), msg('Site.comments.item.reply')))
      fireEvent.click(button(uuid(21), msg('Site.comments.item.edit')))
      fireEvent.click(button(uuid(21), msg('Site.comments.item.delete')))
      expect(within(articleOf(uuid(2)).closest('li')!).queryByRole('textbox')).toBeNull()
      expect(within(articleOf(uuid(21))).queryByRole('group')).toBeNull()

      await answer(success())

      expectNoSlotOpen()
      expect(focused()).toHaveFocus()
      expect(writes()).toHaveLength(1)
      fireEvent.click(button(uuid(2), msg('Site.comments.item.reply')))
      expect(replyBox()).toHaveFocus()
    },
  )

  it.each(SLOT_WRITES)(
    '%s pending, the reader moves to type in the root comment box: when done focus stays there, the text is intact',
    async (_label, start, success) => {
      await mount(READER, SLOT_PAGE())
      const answer = holdWrite()
      await start()
      rootTextarea().focus()
      fireEvent.change(rootTextarea(), { target: { value: 'Another idea' } })

      await answer(success())

      expectNoSlotOpen()
      expect(rootTextarea()).toHaveFocus()
      expect(rootTextarea()).toHaveValue('Another idea')
    },
  )

  it('a pending root comment, the reader opens a reply box and types: finishing the post does not pull focus out of that box', async () => {
    await mount(READER, page([thread(comment(1))]))
    const answer = holdWrite()
    await postRoot('Root comment')

    // Posting a root comment locks no spot: the root form stands apart, it is not an "open spot".
    fireEvent.click(button(uuid(1), msg('Site.comments.item.reply')))
    fireEvent.change(replyBox()!, { target: { value: 'Half typed' } })
    expect(replyBox()).toHaveFocus()

    await answer(json(201, { data: comment(50, { mine: true, content: 'Root comment' }) }))

    expect(articleOf(uuid(50))).toBeInTheDocument()
    expect(rootTextarea()).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.posted'))
    expect(replyBox()).toHaveFocus()
    expect(replyBox()).toHaveValue('Half typed')
  })

  it('a root comment submitted by keyboard (focus on the submit button, inside the form): focus still goes to the new comment', async () => {
    await mount(READER, page([]))
    writeAnswer = () => data(comment(50, { mine: true, content: 'By keyboard' }), 201)
    fireEvent.change(rootTextarea(), { target: { value: 'By keyboard' } })
    const submit = screen.getByRole('button', { name: msg('Site.comments.rootForm.submit') })
    submit.focus()

    await act(async () => {
      fireEvent.click(submit)
    })

    expect(articleOf(uuid(50))).toHaveFocus()
  })

  it('"Show more comments": if the reader has moved to a reply box the arriving page does not pull focus away; if still on the button focus goes to the first root just loaded', async () => {
    let answer: (response: Response) => void = () => {}
    await mount(READER, (after) =>
      after === null ? data(page([thread(comment(1))], 'c2')) : new Promise<Response>((resolve) => (answer = resolve)),
    )

    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    fireEvent.click(button(uuid(1), msg('Site.comments.item.reply')))
    fireEvent.change(replyBox()!, { target: { value: 'Half typed' } })
    await act(async () => answer(json(200, { data: page([thread(comment(2))], 'c3') })))

    expect(articleOf(uuid(2))).toBeInTheDocument()
    expect(replyBox()).toHaveFocus()
    expect(replyBox()).toHaveValue('Half typed')

    const more = screen.getByRole('button', { name: msg('Site.comments.loadMore') })
    more.focus()
    fireEvent.click(more)
    await act(async () => answer(json(200, { data: page([thread(comment(3))]) })))

    expect(articleOf(uuid(3))).toHaveFocus()
  })
})

describe('CommentSection: the session turns into a guest', () => {
  it('signing out elsewhere: no more edit/delete/reply, an open form closes, the sign-in invitation appears', async () => {
    await mount(READER, page([thread(comment(1, { mine: true }))]))
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    expect(screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') })).toBeInTheDocument()
    const { setAnonymous } = await import('@/lib/session-client')

    act(() => setAnonymous())

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: ACTIONS_RE })).toBeNull()
    expect(screen.getByText('Comment number 1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })).toBeInTheDocument()
    // No re-asking: the data already there is still right for a guest, it just stops being "mine".
    expect(listGets()).toHaveLength(1)
  })
})

describe('CommentSection: comment likes', () => {
  const LIKE = LIKE_FULL

  function likeOf(id: string): HTMLElement {
    return within(articleOf(id)).getByRole('button', { name: LIKE })
  }

  /** The next write hangs until the test answers it. */
  function holdWrite(): (response: Response) => Promise<void> {
    let resolve: (response: Response) => void = () => {}
    writeAnswer = () => new Promise<Response>((done) => (resolve = done))
    return (response) =>
      act(async () => {
        resolve(response)
      })
  }

  it('signed in: every VISIBLE comment, root and reply, has a like button carrying the number and state from the server; a placeholder does not', async () => {
    const deleted = comment(2, { status: 'DELETED', content: null, author: null })
    await mount(
      READER,
      page([
        thread(comment(1, { likeCount: 4, likedByMe: true }), [comment(11)]),
        thread(deleted, [comment(21, { likeCount: 2, mine: true })]),
      ]),
    )

    expect(likeOf(uuid(1))).toHaveAccessibleName(msg('Site.comments.like.ariaLabel', { author: 'Writer 1', n: 4, count: '4' }))
    expect(likeOf(uuid(1))).toHaveAttribute('aria-pressed', 'true')
    expect(likeOf(uuid(11))).toHaveAccessibleName(msg('Site.comments.like.ariaLabel', { author: 'Writer 11', n: 0, count: '0' }))
    expect(likeOf(uuid(11))).toHaveAttribute('aria-pressed', 'false')
    expect(within(articleOf(uuid(2))).queryByRole('button')).toBeNull()
    // Your own comment can also be liked; the like button comes first in the action row.
    const row = likeOf(uuid(21)).parentElement!
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['2', msg('Site.comments.item.edit'), msg('Site.comments.item.delete')])
  })

  it('press like: PUT /api/comments/<id>/like, wait for the server (not optimistic), then show the { liked, count } the server returns, announces "Liked the comment"', async () => {
    await mount(READER, page([thread(comment(1), [comment(11, { likeCount: 1 })])]))
    const answer = holdWrite()
    const button = likeOf(uuid(11))
    button.focus()

    fireEvent.click(button)
    fireEvent.click(button)

    expect(writes()).toEqual([{ method: 'PUT', url: `/api/comments/${uuid(11)}/like`, body: undefined }])
    // The BFF route demands JSON for every PUT (blocking forms from other sites).
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/like'))!
    expect(new Headers((init as RequestInit).headers).get('content-type')).toBe('application/json')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveTextContent('1')

    // The server says 5 (someone else also just liked): show 5, do not add up to 2 by itself.
    await answer(json(200, { data: { liked: true, count: 5 } }))

    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button).toHaveAccessibleName(msg('Site.comments.like.ariaLabel', { author: 'Writer 11', n: 5, count: '5' }))
    expect(button.querySelector('svg path')).toHaveAttribute('fill', 'currentColor')
    expect(button).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.liked'))
    // Only that comment changes.
    expect(likeOf(uuid(1))).toHaveAttribute('aria-pressed', 'false')
  })

  it('unlike: DELETE, then "Comment like removed"', async () => {
    await mount(READER, page([thread(comment(1, { likeCount: 3, likedByMe: true }))]))
    writeAnswer = () => data({ liked: false, count: 2 })

    await act(async () => {
      fireEvent.click(likeOf(uuid(1)))
    })

    expect(writes()).toEqual([{ method: 'DELETE', url: `/api/comments/${uuid(1)}/like`, body: undefined }])
    expect(likeOf(uuid(1))).toHaveAttribute('aria-pressed', 'false')
    expect(likeOf(uuid(1))).toHaveTextContent('2')
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.unliked'))
  })

  it.each([
    [404, 'COMMENT_NOT_FOUND', msg('Errors.interaction.byCode.COMMENT_NOT_FOUND')],
    [429, 'RATE_LIMITED', msg('Errors.interaction.byCode.RATE_LIMITED')],
    [403, 'USER_SUSPENDED', msg('Errors.interaction.userSuspended.comment')],
    [502, 'UPSTREAM_UNAVAILABLE', msg('Site.profile.author.errors.network')],
  ])(
    '%i %s: error sentence visible under the row of that very comment, state unchanged, focus kept',
    async (status, code, message) => {
      await mount(READER, page([thread(comment(1, { likeCount: 3 })), thread(comment(2))]))
      writeAnswer = () => error(status, code)
      const button = likeOf(uuid(1))
      button.focus()

      await act(async () => {
        fireEvent.click(button)
      })

      const alert = within(articleOf(uuid(1))).getByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).not.toHaveTextContent('English')
      expect(within(articleOf(uuid(2))).queryByRole('alert')).toBeNull()
      expect(button).toHaveAttribute('aria-pressed', 'false')
      expect(button).toHaveTextContent('3')
      expect(button).toHaveFocus()
      expect(screen.getByRole('status')).toHaveTextContent('')
    },
  )

  it('200 but the payload breaks the contract: like a failing server, the state is not guessed', async () => {
    await mount(READER, page([thread(comment(1, { likeCount: 3 }))]))
    writeAnswer = () => data({ liked: true })

    await act(async () => {
      fireEvent.click(likeOf(uuid(1)))
    })

    expect(within(articleOf(uuid(1))).getByRole('alert')).toHaveTextContent(msg('Site.profile.author.errors.network'))
    expect(likeOf(uuid(1))).toHaveAttribute('aria-pressed', 'false')
  })

  it('401 (session expired): becomes a guest — the sign-in invitation with "Your session has ended…", focus to the link, the number becomes static text', async () => {
    await mount(READER, page([thread(comment(1, { likeCount: 3 })), thread(comment(2))]))
    writeAnswer = () => error(401, 'UNAUTHENTICATED')
    const button = likeOf(uuid(1))
    button.focus()

    await act(async () => {
      fireEvent.click(button)
    })

    expect(screen.queryByRole('button', { name: LIKE })).toBeNull()
    const link = screen.getByRole('link', { name: msg('Site.comments.loginPrompt') })
    // One single sentence, in the sign-in invitation: not repeated next to the number.
    expect(screen.getByRole('alert')).toHaveTextContent(SESSION_EXPIRED)
    await waitFor(() => expect(link).toHaveFocus())
    expect(articleOf(uuid(1)).querySelector('[data-like-count]')).toHaveTextContent(
      `3 ${msg('Site.comments.like.countLabel', { n: 3 })}`,
    )
    expect(articleOf(uuid(2)).querySelector('[data-like-count]')).toBeNull()
    // No re-asking: the data already there is still right for a guest.
    expect(listGets()).toHaveLength(1)
  })

  it('guest: the number only when there are likes, and only as text — no button, no link, no Tab stop', async () => {
    await mount(null, page([thread(comment(1, { likeCount: 2 }), [comment(11)])]))

    expect(screen.queryByRole('button', { name: LIKE })).toBeNull()
    const count = articleOf(uuid(1)).querySelector<HTMLElement>('[data-like-count]')!
    expect(count).toHaveTextContent(`2 ${msg('Site.comments.like.countLabel', { n: 2 })}`)
    expect(count.closest('a, button, [tabindex="0"]')).toBeNull()
    expect(count.querySelector('[tabindex]')).toBeNull()
    expect(articleOf(uuid(11)).querySelector('[data-like-count]')).toBeNull()
    // A guest only reads: no button in the area.
    expect(within(section()).queryAllByRole('button')).toHaveLength(0)
  })

  it('liking locks no spot: while a like is pending a reply box can still be opened and typed in, the result does not pull focus away', async () => {
    await mount(READER, page([thread(comment(1))]))
    const answer = holdWrite()

    fireEvent.click(likeOf(uuid(1)))
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    const box = screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') })
    fireEvent.change(box, { target: { value: 'Typing' } })
    await answer(json(200, { data: { liked: true, count: 1 } }))

    expect(likeOf(uuid(1))).toHaveAttribute('aria-pressed', 'true')
    expect(box).toHaveFocus()
    expect(box).toHaveValue('Typing')
  })
})

describe('CommentSection: the target comment of a notification', () => {
  // jsdom has no scrollIntoView: record the element scrolled to (and how) instead of scrolling.
  const proto = Element.prototype as unknown as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }
  let scrolledTo: Element[] = []
  let scrollOptions: (ScrollIntoViewOptions | undefined)[] = []

  beforeEach(() => {
    scrolledTo = []
    scrollOptions = []
    proto.scrollIntoView = function (this: Element, options?: ScrollIntoViewOptions) {
      scrolledTo.push(this)
      scrollOptions.push(options)
    }
  })

  afterEach(() => {
    delete proto.scrollIntoView
    window.history.replaceState(null, '', '/')
  })

  function openAt(hash: string) {
    window.history.replaceState(null, '', `/posts/${SLUG}${hash}`)
  }

  it('anchor #binh-luan-<uuid> at mount: the area scrolls itself into view; when the first page arrives it scrolls to and focuses exactly that comment, even a reply', async () => {
    openAt(`#binh-luan-${uuid(11)}`)

    await mount(READER, page([thread(comment(1), [comment(11), comment(12)]), thread(comment(2))]))

    await waitFor(() => expect(articleOf(uuid(11))).toHaveFocus())
    expect(scrolledTo[0]).toBe(section())
    expect(scrolledTo.at(-1)).toBe(articleOf(uuid(11)))
    // Loads nothing more to find it.
    expect(listGets()).toEqual([LIST])
  })

  it('an uppercase UUID in the anchor still finds the comment', async () => {
    openAt(`#binh-luan-${uuid(1).toUpperCase()}`)

    await mount(null, page([thread(comment(1))]))

    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
  })

  it('a target not on the loaded pages: focus goes to the area heading, no further page is loaded', async () => {
    openAt(`#binh-luan-${uuid(99)}`)

    await mount(READER, page([thread(comment(1))], 'c2'))

    await waitFor(() => expect(heading()).toHaveFocus())
    expect(listGets()).toEqual([LIST])
    expect(screen.getByRole('button', { name: msg('Site.comments.loadMore') })).toBeInTheDocument()

    // The target is used up: "load more" afterwards goes as usual, focus on the first root just loaded.
    listAnswer = () => data(page([thread(comment(99))]))
    const more = screen.getByRole('button', { name: msg('Site.comments.loadMore') })
    more.focus()
    await act(async () => {
      fireEvent.click(more)
    })
    expect(articleOf(uuid(99))).toHaveFocus()
  })

  it('anchor at mount, first page fails: the target waits, "Try again" loads and it still reaches exactly that comment', async () => {
    openAt(`#binh-luan-${uuid(1)}`)
    let fail = true
    await mount(READER, () => (fail ? error(503, 'UPSTREAM_UNAVAILABLE') : data(page([thread(comment(1))]))))
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.comments.loadFailed'))

    fail = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))
    })

    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
  })

  it('the area has unmounted (moved to another page): no more listening, nothing reloaded', async () => {
    const view = await mount(READER, page([thread(comment(1))]))
    view.unmount()

    requestCommentTarget(uuid(1))
    await act(async () => {})

    expect(listGets()).toEqual([LIST])
  })

  it('anchor at mount but the reader has moved elsewhere while waiting: does not steal focus', async () => {
    openAt(`#binh-luan-${uuid(1)}`)
    let answer: (response: Response) => void = () => {}
    await mount(READER, () => new Promise<Response>((resolve) => (answer = resolve)))
    const elsewhere = screen.getByRole('link', { name: 'Other link' })
    elsewhere.focus()

    await act(async () => answer(json(200, { data: page([thread(comment(1))]) })))

    expect(articleOf(uuid(1))).toBeInTheDocument()
    expect(elsewhere).toHaveFocus()
  })

  it.each(['#binh-luan', '#binh-luan-heading', '#gioi-thieu', ''])(
    'anchor %j does not point to a comment: no scroll, no focus grab',
    async (hash) => {
      openAt(hash)

      await mount(READER, page([thread(comment(1))]))

      expect(scrolledTo).toEqual([])
      expect(document.body).toHaveFocus()
    },
  )

  it('pressing a notification of the post that is currently open (blog:comment-target): reloads the first page, the new reply appears, is scrolled to and gets focus', async () => {
    let fresh = false
    await mount(READER, () =>
      data(page([thread(comment(1), fresh ? [comment(11), comment(12, { content: 'Fresh reply' })] : [comment(11)])])),
    )
    expect(screen.queryByText('Fresh reply')).toBeNull()
    fresh = true
    // Focus is somewhere else (the notification link just pressed): the reader just moved there, so focus follows.
    screen.getByRole('link', { name: 'Other link' }).focus()

    await act(async () => {
      requestCommentTarget(uuid(12))
    })

    await waitFor(() => expect(articleOf(uuid(12))).toHaveFocus())
    expect(listGets()).toEqual([LIST, LIST])
    expect(screen.getByText('Fresh reply')).toBeInTheDocument()
    expect(scrolledTo.at(-1)).toBe(articleOf(uuid(12)))
  })

  it('the reload replaces every loaded page with the new first page: "Show more comments" goes again from its cursor', async () => {
    await mount(READER, (after) => (after === null ? data(page([thread(comment(1))], 'c2')) : data(page([thread(comment(2))]))))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })
    expect(articleOf(uuid(2))).toBeInTheDocument()

    await act(async () => {
      requestCommentTarget(uuid(1))
    })

    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    expect(articleOf(uuid(2))).toBeNull()
    expect(screen.getByRole('button', { name: msg('Site.comments.loadMore') })).toBeInTheDocument()
  })

  it('"Show more comments" in flight when the first page is reloaded: its result (the old list) is dropped', async () => {
    let more: (response: Response) => void = () => {}
    await mount(READER, (after) =>
      after === null ? data(page([thread(comment(1))], 'c2')) : new Promise<Response>((resolve) => (more = resolve)),
    )
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))

    await act(async () => {
      requestCommentTarget(uuid(1))
    })
    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    await act(async () => more(json(200, { data: page([thread(comment(2))]) })))

    expect(articleOf(uuid(2))).toBeNull()
    expect(screen.getByRole('button', { name: msg('Site.comments.loadMore') })).toHaveTextContent(msg('Site.comments.loadMore'))
  })

  it('the event arrives before the first page has returned: scrolls to the area, loads nothing more, when the first page arrives focus goes to the target', async () => {
    let answer: (response: Response) => void = () => {}
    await mount(READER, () => new Promise<Response>((resolve) => (answer = resolve)))

    act(() => requestCommentTarget(uuid(1)))
    expect(scrolledTo).toEqual([section()])
    await act(async () => answer(json(200, { data: page([thread(comment(1))]) })))

    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    expect(listGets()).toEqual([LIST])
  })

  it('the reload fails: the list stays, no error sentence, a target comment already on the page still gets focus', async () => {
    let fail = false
    await mount(READER, () => (fail ? error(503, 'UPSTREAM_UNAVAILABLE') : data(page([thread(comment(1))]))))
    fail = true

    await act(async () => {
      requestCommentTarget(uuid(1))
    })

    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    expect(listGets()).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Comment number 1')).toBeInTheDocument()
  })

  it('the reload fails while "Show more comments" is in flight: the list is still that list, the page of "Show more comments" is still used, the button does not stick on "Loading…"', async () => {
    let fail = false
    let more: (response: Response) => void = () => {}
    await mount(READER, (after) =>
      after !== null
        ? new Promise<Response>((resolve) => (more = resolve))
        : fail
          ? error(503, 'UPSTREAM_UNAVAILABLE')
          : data(page([thread(comment(1))], 'c2')),
    )
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    fail = true

    await act(async () => {
      requestCommentTarget(uuid(1))
    })
    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    await act(async () => more(json(200, { data: page([thread(comment(2))], 'c3') })))

    expect(listGets()).toEqual([LIST, `${LIST}?after=c2`, LIST])
    expect(articleOf(uuid(2))).toBeInTheDocument()
    const button = screen.getByRole('button', { name: msg('Site.comments.loadMore') })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(section().querySelector('ol')).not.toHaveAttribute('aria-busy')
  })

  it('the reload finishes while an old "Show more comments" is still in flight: the button is usable at once, continues from the new cursor; the old one returning later is dropped and does not release the lock of the new one', async () => {
    let fresh = false
    const held = new Map<string, (response: Response) => void>()
    await mount(READER, (after) =>
      after === null
        ? data(page([thread(comment(1))], fresh ? 'c2-moi' : 'c2'))
        : new Promise<Response>((resolve) => held.set(after, resolve)),
    )
    fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    fresh = true

    await act(async () => {
      requestCommentTarget(uuid(1))
    })
    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    const more = screen.getByRole('button', { name: msg('Site.comments.loadMore') })
    expect(more).not.toHaveAttribute('aria-disabled')

    fireEvent.click(more)
    expect(listGets()).toEqual([LIST, `${LIST}?after=c2`, LIST, `${LIST}?after=c2-moi`])

    await act(async () => held.get('c2')!(json(200, { data: page([thread(comment(2))]) })))
    expect(articleOf(uuid(2))).toBeNull()
    expect(more).toHaveTextContent(msg('Site.bookmarks.loading'))
    // The new one is still in flight: pressing again sends no further request.
    fireEvent.click(more)
    expect(listGets()).toHaveLength(4)

    await act(async () => held.get('c2-moi')!(json(200, { data: page([thread(comment(3))]) })))
    expect(articleOf(uuid(3))).toBeInTheDocument()
    expect(articleOf(uuid(2))).toBeNull()
    expect(screen.queryByRole('button', { name: LOAD_MORE_RE })).toBeNull()
  })

  it.each<[string, () => Promise<string>]>([
    [
      'a thread loaded by "Load more"',
      async () => {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
        })
        return uuid(2)
      },
    ],
    [
      'a comment just posted in place (the first page is not the last page)',
      async () => {
        writeAnswer = () => data(comment(50, { mine: true, content: 'Just posted' }), 201)
        await postRoot('Just posted')
        return uuid(50)
      },
    ],
  ])(
    'reply box open in %s, absent from the new first page: the list is not replaced — box and text intact, the loaded target gets focus',
    async (_label, openThread) => {
      await mount(READER, (after) => (after === null ? data(page([thread(comment(1))], 'c2')) : data(page([thread(comment(2))]))))
      const rootId = await openThread()
      fireEvent.click(within(articleOf(rootId)).getByRole('button', { name: msg('Site.comments.item.reply') }))
      const box = screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') })
      fireEvent.change(box, { target: { value: 'Half typed' } })
      // The reader pressed a notification elsewhere (the bell in the header): focus has already left the box.
      screen.getByRole('link', { name: 'Other link' }).focus()

      await act(async () => {
        requestCommentTarget(uuid(1))
      })

      await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
      expect(listGets().filter((url) => url === LIST)).toHaveLength(2)
      expect(articleOf(rootId)).toBeInTheDocument()
      expect(box).toBeInTheDocument()
      expect(box).toHaveValue('Half typed')
    },
  )

  it('a reply pending on the server in a thread not on the new first page: the list is not replaced; when done the reply shows in the right thread, announces "Reply posted"', async () => {
    await mount(READER, (after) => (after === null ? data(page([thread(comment(1))], 'c2')) : data(page([thread(comment(2))]))))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.loadMore') }))
    })
    let answer: (response: Response) => void = () => {}
    writeAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    fireEvent.click(within(articleOf(uuid(2))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    fireEvent.change(screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') }), { target: { value: 'Agreed' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: msg('Site.comments.replyForm.submit') }))
    })

    await act(async () => {
      requestCommentTarget(uuid(1))
    })
    await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
    await act(async () => answer(json(201, { data: comment(22, { mine: true, content: 'Agreed' }) })))

    expect(
      articleOf(uuid(2))
        .closest('li')!
        .contains(articleOf(uuid(22))),
    ).toBe(true)
    expect(screen.getByRole('status')).toHaveTextContent(msg('Site.comments.announce.replied'))
    expect(screen.queryByRole('textbox', { name: msg('Site.comments.replyForm.label') })).toBeNull()
    // Focus has followed the notification the reader pressed: the later result does not pull it away.
    expect(articleOf(uuid(1))).toHaveFocus()
  })

  it('a reply box open in a thread that is on the new first page: the list is replaced (the new reply appears), the box and text remain', async () => {
    let fresh = false
    await mount(READER, () => data(page([thread(comment(1), fresh ? [comment(11)] : [])])))
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.reply') }))
    const box = screen.getByRole('textbox', { name: msg('Site.comments.replyForm.label') })
    fireEvent.change(box, { target: { value: 'Half typed' } })
    fresh = true

    await act(async () => {
      requestCommentTarget(uuid(11))
    })

    await waitFor(() => expect(articleOf(uuid(11))).toHaveFocus())
    expect(box).toBeInTheDocument()
    expect(box).toHaveValue('Half typed')
  })

  it('an edit box open while the new first page makes that comment a placeholder (just hidden): the list is not replaced, the text intact', async () => {
    let hidden = false
    const hiddenRoot = comment(1, { status: 'HIDDEN', content: null, author: null })
    await mount(READER, () => data(page([thread(hidden ? hiddenRoot : comment(1, { mine: true }), [comment(11)])])))
    fireEvent.click(within(articleOf(uuid(1))).getByRole('button', { name: msg('Site.comments.item.edit') }))
    const box = screen.getByRole('textbox', { name: msg('Site.comments.item.editLabel') })
    fireEvent.change(box, { target: { value: 'Half edit' } })
    hidden = true

    await act(async () => {
      requestCommentTarget(uuid(11))
    })

    await waitFor(() => expect(articleOf(uuid(11))).toHaveFocus())
    expect(box).toBeInTheDocument()
    expect(box).toHaveValue('Half edit')
  })

  it('the target is taller than the screen: the top of the comment (name, date and time) goes to the top edge; if it fits the screen it is centered', async () => {
    // jsdom does no layout: comment 2 is 2000px tall, every other element 120px; the jsdom screen is 768px tall.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = this.getAttribute('data-comment-id') === uuid(2) ? 2000 : 120
      return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) }
    })
    try {
      expect(window.innerHeight).toBeLessThan(2000)
      openAt(`#binh-luan-${uuid(2)}`)
      await mount(READER, page([thread(comment(1)), thread(comment(2))]))

      await waitFor(() => expect(articleOf(uuid(2))).toHaveFocus())
      expect(scrolledTo.at(-1)).toBe(articleOf(uuid(2)))
      expect(scrollOptions.at(-1)).toEqual({ block: 'start' })

      await act(async () => {
        requestCommentTarget(uuid(1))
      })

      await waitFor(() => expect(articleOf(uuid(1))).toHaveFocus())
      expect(scrolledTo.at(-1)).toBe(articleOf(uuid(1)))
      expect(scrollOptions.at(-1)).toEqual({ block: 'center' })
    } finally {
      rect.mockRestore()
    }
  })
})
