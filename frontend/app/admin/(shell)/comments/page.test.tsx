import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * Every assertion about `listAdminComments` parameters carries `postId` (filtering by post). `getAdminPost` is only there to get the title for the
 * "Post: …" chip when filtering by post.
 */
const { listAdminComments, getAdminPost, redirect, router, adminRole } = vi.hoisted(() => ({
  listAdminComments: vi.fn(),
  getAdminPost: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  router: { refresh: vi.fn() },
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAdminComments,
  getAdminPost,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => router,
}))
// The action file is 'use server'; the page only forwards them to CommentModeration.
vi.mock('./actions', () => ({ hideComment: vi.fn(), restoreComment: vi.fn(), deleteComment: vi.fn() }))

import { ApiError } from '@/lib/api'
import type { AdminComment } from '@/lib/types'
import { deleteComment, hideComment, restoreComment } from './actions'
import AdminCommentsPage from './page'
import { msg } from '@/test/render-intl'

const FIRST_TEXT = 'A great article.'
const POST_TITLE = 'The first post'
const AUTHOR = 'John Smith'

const word = (key: string) => msg(`Admin.comments.table.${key}`)
/** The accessible name of a row action: its visible word and the target comment. */
const action = (key: string, content: string) =>
  `${word(key)} ${msg('Admin.comments.table.target', { name: AUTHOR, excerpt: content })}`
const filterName = (filter: string) => msg(`Admin.comments.filters.${filter}`).toLowerCase()
const caption = (values: Record<string, string | number>) =>
  msg('Admin.comments.caption', { onPost: 'no', postTitle: '', searched: 'no', query: '', page: 1, totalPages: 1, ...values })
const count = (n: number) => msg('Admin.comments.count', { count: n })
const pagerSummary = (from: number, to: number, total: number, page: number, totalPages: number) =>
  msg('Admin.common.pager.summary', { from, to, total, unit: 'comment', page, totalPages })
const startsWith = (text: string) => (name: string) => name.startsWith(text)

const comment = (over: Partial<AdminComment> = {}): AdminComment => ({
  id: 'c1',
  content: FIRST_TEXT,
  status: 'VISIBLE',
  reply: false,
  createdAt: '2026-10-02T19:00:00Z',
  editedAt: null,
  postId: 'p1',
  postSlug: 'the-first-post',
  postTitle: POST_TITLE,
  postStatus: 'PUBLISHED',
  authorId: 'u1',
  authorDisplayName: AUTHOR,
  authorGithubLogin: 'nva',
  authorAvatarUrl: null,
  authorRole: 'USER',
  authorStatus: 'ACTIVE',
  ...over,
})

function apiReturns(items: AdminComment[], meta: Partial<{ page: number; totalElements: number; totalPages: number }> = {}) {
  listAdminComments.mockResolvedValue({
    items,
    meta: { page: 0, size: 20, totalElements: items.length, totalPages: items.length === 0 ? 0 : 1, ...meta },
  })
}

async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  return render(await AdminCommentsPage({ searchParams: Promise.resolve(params) }))
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

function filterLinks() {
  return within(screen.getByRole('navigation', { name: msg('Admin.comments.statusNav') })).getAllByRole('link')
}

afterEach(() => vi.clearAllMocks())

describe('Comments page', () => {
  // Pinned on purpose: the default entry is "Visible" — what readers currently see —
  // instead of "All" (which includes deleted comments). "All" stays first, with its own URL ?status=all.
  it('top of the page, four status filters ("Visible" selected), and the comments table', async () => {
    apiReturns([comment()])

    await renderPage()

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.comments.heading') })).toBeInTheDocument()
    expect(filterLinks().map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual(
      [
        [msg('Site.notifications.center.filterAll'), '/admin/comments?status=all', null],
        [msg('Admin.statuses.comment.VISIBLE'), '/admin/comments', 'page'],
        [msg('Admin.statuses.comment.HIDDEN'), '/admin/comments?status=hidden', null],
        [msg('Admin.statuses.comment.DELETED'), '/admin/comments?status=deleted', null],
      ],
    )
    expect(listAdminComments).toHaveBeenCalledWith({ status: 'VISIBLE', q: '', postId: null, page: 0, size: 20 })
    expect(screen.getByRole('table', { name: caption({ filter: filterName('visible'), postTitle: '' }) })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(`${msg('Admin.comments.filters.visible')} ${count(1)}`)
  })

  it('"All" (?status=all): sends no status to the backend', async () => {
    apiReturns([comment()])

    await renderPage({ status: 'all' })

    expect(listAdminComments).toHaveBeenCalledWith({ status: null, q: '', postId: null, page: 0, size: 20 })
    expect(filterLinks().find((link) => link.getAttribute('aria-current') === 'page')).toHaveTextContent(
      msg('Site.notifications.center.filterAll'),
    )
    expect(screen.getByRole('table', { name: caption({ filter: filterName('all') }) })).toBeInTheDocument()
  })

  it('reads filter, search box and page from the URL; changing the filter keeps the search box, back to the first page', async () => {
    apiReturns([comment({ status: 'HIDDEN' })], { page: 1, totalElements: 45, totalPages: 3 })

    await renderPage({ status: 'hidden', q: '  spam  ', page: '1' })

    expect(listAdminComments).toHaveBeenCalledWith({ status: 'HIDDEN', q: 'spam', postId: null, page: 1, size: 20 })
    expect(filterLinks().find((link) => link.getAttribute('aria-current') === 'page')).toHaveTextContent(
      msg('Admin.statuses.comment.HIDDEN'),
    )
    expect(filterLinks().map((link) => link.getAttribute('href'))).toEqual([
      '/admin/comments?status=all&q=spam',
      '/admin/comments?q=spam',
      '/admin/comments?status=hidden&q=spam',
      '/admin/comments?status=deleted&q=spam',
    ])
    expect(
      screen.getByRole('table', {
        name: caption({ filter: filterName('hidden'), searched: 'yes', query: 'spam', page: 2, totalPages: 3 }),
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(`${msg('Admin.comments.results')} ${count(45)}`)
    // The pager keeps the filter and the search box.
    const pager = screen.getByRole('navigation', { name: msg('Site.pagination.label') })
    expect(pager).toHaveTextContent(pagerSummary(21, 40, 45, 2, 3))
    expect(within(pager).getByRole('link', { name: msg('Admin.common.pager.previous') })).toHaveAttribute(
      'href',
      '/admin/comments?status=hidden&q=spam',
    )
    expect(within(pager).getByRole('link', { name: msg('Admin.common.pager.next') })).toHaveAttribute(
      'href',
      '/admin/comments?status=hidden&q=spam&page=2',
    )
    // Removing the search box, keeping the filter.
    expect(
      screen.getByRole('link', {
        name: `${msg('Admin.comments.chip.query', { query: 'spam' })} ${msg('Admin.comments.chip.removeQuery')}`,
      }),
    ).toHaveAttribute('href', '/admin/comments?status=hidden')
  })

  it('search box: a labelled GET form role="search", keeps the chosen filter in a hidden field, shows the searched text again', async () => {
    apiReturns([comment()])

    await renderPage({ status: 'deleted', q: 'free offer' })

    const search = screen.getByRole('search')
    expect(search).toHaveAttribute('action', '/admin/comments')
    expect(search).toHaveAttribute('method', 'get')
    expect(within(search).getByRole('searchbox', { name: msg('Admin.comments.searchLabel') })).toHaveValue('free offer')
    expect(search.querySelector('input[type="hidden"][name="status"]')).toHaveValue('deleted')
  })

  // Pinned on purpose: an unknown value falls back to the default entry, now "Visible".
  it('an unknown ?status= is the default entry "Visible", never an unknown enum value reaching the backend', async () => {
    apiReturns([comment()])

    await renderPage({ status: 'SPAM', page: 'abc' })

    expect(listAdminComments).toHaveBeenCalledWith({ status: 'VISIBLE', q: '', postId: null, page: 0, size: 20 })
  })

  it.each([
    [{ status: 'all' }, msg('Admin.comments.empty.all.title')],
    [{}, msg('Admin.comments.empty.visible.title')],
    [{ status: 'visible' }, msg('Admin.comments.empty.visible.title')],
    [{ status: 'hidden' }, msg('Admin.comments.empty.hidden.title')],
    [{ status: 'deleted' }, msg('Admin.comments.empty.deleted.title')],
  ])('empty list at %j: the filter own sentence, no table', async (params, title) => {
    apiReturns([])

    await renderPage(params)

    expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Site.pagination.label') })).toBeNull()
  })

  it('search with no result: says where it searched, a hint, and a way back to every comment', async () => {
    apiReturns([])

    await renderPage({ status: 'hidden', q: 'xyz' })

    expect(screen.getByText(msg('Admin.comments.empty.noMatch'))).toBeInTheDocument()
    expect(
      screen.getByText(msg('Admin.comments.empty.queryHint', { status: 'hidden', query: 'xyz', onPost: 'no' })),
    ).toBeInTheDocument()
    // Pinned on purpose: "every comment" is the "All" entry, no longer the bare URL (which is now "Visible").
    expect(screen.getByRole('link', { name: msg('Admin.comments.empty.viewAll') })).toHaveAttribute(
      'href',
      '/admin/comments?status=all',
    )
  })

  it('session expired while loading → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAdminComments.mockRejectedValue(new SessionExpiredError())

    await expect(AdminCommentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('backend refuses the request (4xx): a local error message, the filter strip and search box remain to change the request', async () => {
    listAdminComments.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'bad status'))

    await renderPage({ status: 'hidden' })

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.invalidDetail', { detail: 'bad status' }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(filterLinks()).toHaveLength(4)
    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  // Pinned on purpose: a 403 is no longer a local error message — changing the filter does not help an account that is no
  // longer ADMIN.
  it('not ADMIN: AUTHOR does not call the backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = await renderPage()
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.comments.heading') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(listAdminComments).not.toHaveBeenCalled()
    author.unmount()

    listAdminComments.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    await renderPage({ status: 'hidden' })
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('search')).toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('server error (5xx) or lost connection: rethrown to the admin error.tsx (which has "Try again")', async () => {
    listAdminComments.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'))
    await expect(AdminCommentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('boom')

    listAdminComments.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(AdminCommentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('fetch failed')
  })

  it('?page= beyond the last page (the list just got shorter): redirects to the last page, keeping the filter', async () => {
    listAdminComments.mockResolvedValue({ items: [], meta: { page: 7, size: 20, totalElements: 45, totalPages: 3 } })

    await expect(AdminCommentsPage({ searchParams: Promise.resolve({ status: 'hidden', q: 'a', page: '7' }) })).rejects.toThrow(
      'NEXT_REDIRECT',
    )
    expect(redirect).toHaveBeenCalledWith('/admin/comments?status=hidden&q=a&page=2')
  })
})

describe('Comments page: filter by post', () => {
  const POST = '11111111-1111-4111-8111-111111111111'

  it('?post=: sends postId to the backend; the chip "Post: <title>" can be removed; every link of the page keeps this filter', async () => {
    getAdminPost.mockResolvedValue({ id: POST, title: POST_TITLE })
    apiReturns([comment({ postId: POST })], { page: 0, totalElements: 30, totalPages: 2 })

    await renderPage({ status: 'hidden', q: 'spam', post: POST })

    expect(listAdminComments).toHaveBeenCalledWith({ status: 'HIDDEN', q: 'spam', postId: POST, page: 0, size: 20 })
    expect(getAdminPost).toHaveBeenCalledWith(POST)
    // Removing the post chip: keeps the status and the search box.
    expect(
      screen.getByRole('link', {
        name: `${msg('Admin.comments.chip.post', { title: POST_TITLE })} ${msg('Admin.comments.chip.removePost')}`,
      }),
    ).toHaveAttribute('href', '/admin/comments?status=hidden&q=spam')
    // Removing the search box: keeps the status and the post.
    expect(
      screen.getByRole('link', {
        name: `${msg('Admin.comments.chip.query', { query: 'spam' })} ${msg('Admin.comments.chip.removeQuery')}`,
      }),
    ).toHaveAttribute('href', `/admin/comments?status=hidden&post=${POST}`)
    expect(filterLinks().map((link) => link.getAttribute('href'))).toEqual([
      `/admin/comments?status=all&q=spam&post=${POST}`,
      `/admin/comments?q=spam&post=${POST}`,
      `/admin/comments?status=hidden&q=spam&post=${POST}`,
      `/admin/comments?status=deleted&q=spam&post=${POST}`,
    ])
    expect(screen.getByRole('search').querySelector('input[type="hidden"][name="post"]')).toHaveValue(POST)
    expect(
      within(screen.getByRole('navigation', { name: msg('Site.pagination.label') })).getByRole('link', {
        name: msg('Admin.common.pager.next'),
      }),
    ).toHaveAttribute('href', `/admin/comments?status=hidden&q=spam&post=${POST}&page=1`)
    expect(
      screen.getByRole('table', {
        name: caption({
          filter: filterName('hidden'),
          onPost: 'yes',
          postTitle: POST_TITLE,
          searched: 'yes',
          query: 'spam',
          totalPages: 2,
        }),
      }),
    ).toBeInTheDocument()
    // Already filtered by exactly this post: no redundant "Only this post" link on each row.
    expect(screen.queryByRole('link', { name: startsWith(word('onlyThisPost')) })).toBeNull()
  })

  it('not filtering by post: each row has "Only this post", keeping the status entry, dropping the search box', async () => {
    apiReturns([comment({ postId: POST })])

    await renderPage({ status: 'hidden', q: 'spam' })

    const links = screen.getAllByRole('link', {
      name: `${word('onlyThisPost')} ${msg('Admin.comments.table.onlyThisPostSr', { title: POST_TITLE })}`,
    })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link).toHaveAttribute('href', `/admin/comments?status=hidden&post=${POST}`)
    expect(getAdminPost).not.toHaveBeenCalled()
  })

  it('?post= not a UUID: no filtering, nothing extra called (the backend returns 400 for a malformed postId)', async () => {
    apiReturns([comment()])

    await renderPage({ post: 'khong-phai-uuid' })

    expect(listAdminComments).toHaveBeenCalledWith({ status: 'VISIBLE', q: '', postId: null, page: 0, size: 20 })
    expect(getAdminPost).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: startsWith(msg('Admin.comments.chip.post', { title: '' }).trim()) })).toBeNull()
  })

  it('post cannot be read (deleted): the chip is still there, with a generic name; the list still filters', async () => {
    getAdminPost.mockRejectedValue(new ApiError(404, 'POST_NOT_FOUND', 'Post not found'))
    apiReturns([])

    await renderPage({ post: POST })

    expect(
      screen.getByRole('link', { name: `${msg('Admin.comments.chip.selectedPost')} ${msg('Admin.comments.chip.removePost')}` }),
    ).toHaveAttribute('href', '/admin/comments')
    expect(
      screen.getByText(msg('Admin.comments.empty.postNone', { filter: msg('Admin.comments.filters.visible') })),
    ).toBeInTheDocument()
  })

  it('an old backend ignoring postId (returns comments of other posts): says so, does not pretend it filtered', async () => {
    getAdminPost.mockResolvedValue({ id: POST, title: POST_TITLE })
    apiReturns([comment({ postId: POST }), comment({ id: 'c2', postId: 'p-khac', content: 'Other post comment' })])

    await renderPage({ post: POST })

    expect(screen.getByText(msg('Admin.comments.postFilterIgnored'))).toBeInTheDocument()
  })

  it('the author is a reader: the name leads to the Users page, searching by login', async () => {
    apiReturns([comment()])

    await renderPage()

    for (const link of screen.getAllByRole('link', { name: `${AUTHOR} ${word('usersPageSr')}` })) {
      expect(link).toHaveAttribute('href', '/admin/users?q=nva')
    }
  })
})

describe('Comments page: row buttons call the exact Server Action', () => {
  it('"Hide" calls hideComment, "Unhide" calls restoreComment, confirming "Delete" calls deleteComment, each with the exact id', async () => {
    apiReturns([
      comment(),
      comment({ id: 'c2', status: 'HIDDEN', content: 'Already hidden' }),
      comment({ id: 'c3', content: 'About to be deleted' }),
    ])
    vi.mocked(hideComment).mockResolvedValue(comment({ status: 'HIDDEN' }))
    vi.mocked(restoreComment).mockResolvedValue(comment({ id: 'c2', content: 'Already hidden' }))
    vi.mocked(deleteComment).mockResolvedValue(null)
    await renderPage()

    await click(screen.getByRole('button', { name: action('hide', FIRST_TEXT) }))
    await click(screen.getByRole('button', { name: action('restore', 'Already hidden') }))
    await click(screen.getByRole('button', { name: action('delete', 'About to be deleted') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Site.comments.item.delete') }))

    // Swapping the onHide/onRestore props would make "Hide" call restoreComment: each action exactly once, on the right row.
    expect(hideComment).toHaveBeenCalledExactlyOnceWith('c1')
    expect(restoreComment).toHaveBeenCalledExactlyOnceWith('c2')
    expect(deleteComment).toHaveBeenCalledExactlyOnceWith('c3')
  })

  it('the URL filter reaches the table: hiding under "Visible" gives a reload notice; under "All" it does not', async () => {
    vi.mocked(hideComment).mockResolvedValue(comment({ status: 'HIDDEN' }))
    apiReturns([comment()])
    const { unmount } = await renderPage({ status: 'visible' })

    await click(screen.getByRole('button', { name: action('hide', FIRST_TEXT) }))
    await click(screen.getByRole('button', { name: msg('Admin.common.staleList.reload') }))
    expect(router.refresh).toHaveBeenCalledTimes(1)
    unmount()

    // Pinned on purpose: the bare URL is now "Visible", so "All" must be explicit.
    await renderPage({ status: 'all' })
    await click(screen.getByRole('button', { name: action('hide', FIRST_TEXT) }))
    expect(screen.queryByRole('button', { name: msg('Admin.common.staleList.reload') })).toBeNull()
  })
})
