// frontend/app/admin/page.test.tsx
import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'

/**
 * `vi.hoisted`, not plain top-level consts: Vitest hoists the `vi.mock` factories and the
 * `import ... from './page'` above any const declarations, so a factory referencing a plain
 * const runs while it is still in its temporal dead zone ("Cannot access 'redirect' before
 * initialization"). `vi.hoisted` is the supported way to share a mock fn with a hoisted factory.
 */
const { listAdminPosts, redirect, adminRole } = vi.hoisted(() => ({
  listAdminPosts: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  // The role in the token: ADMIN by default; the AUTHOR tests change it once.
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAdminPosts,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect }))
// The two action files are 'use server' and pull in next/cache, admin-action; the page only passes them down to
// the row buttons and the bulk action bar.
vi.mock('./posts/actions', () => ({ bulkSetPublished: vi.fn(), deletePosts: vi.fn() }))
vi.mock('./curated/actions', () => ({ feature: vi.fn(), unfeature: vi.fn() }))

import { ApiError } from '@/lib/api'
import { feature } from './curated/actions'
import { bulkSetPublished, deletePosts } from './posts/actions'
import AdminPostsPage from './page'
import { msg } from '@/test/render-intl'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { ACCENTED_TITLE, OTHER_ACCENTED_TITLE } from '@/test/fixtures/vi/admin-dashboard-search'
import viCatalog from '@/messages/vi.json'

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// "Edited <date>" keeps its <time> tag in the raw message: take the word before it.
const editedWord = viCatalog.Admin.dashboard.meta.edited.split('<')[0].trim()
const editedPattern = new RegExp('^' + esc(editedWord))
const selectedPrefix = new RegExp('^' + esc(msg('Admin.posts.list.selected', { count: 0 }).split('0')[0]))
const rowName = (key: string, title: string) => `${msg(`Admin.posts.row.${key}`)} “${title}”`
const deleteName = (title: string) =>
  `${msg('Admin.posts.row.delete')} ${msg('Admin.posts.row.deleteSr', { title: `“${title}”` })}`

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'First post',
  slug: 'first-post',
  excerpt: null,
  status: 'DRAFT',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 1,
  ...over,
})

/** One call returns everything: every-admin-post stops when `totalPages` is 1. */
function apiReturns(items: unknown[]) {
  listAdminPosts.mockResolvedValue({ items, meta: { page: 0, size: 100, totalElements: items.length, totalPages: 1 } })
}

async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  return render(await AdminPostsPage({ searchParams: Promise.resolve(params) }))
}

/** Titles of the posts in the table, in row order. */
function listedTitles(): string[] {
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
  return rows.map((row) => within(row).getAllByRole('link')[0].textContent ?? '')
}

describe('AdminPostsPage', () => {
  afterEach(() => vi.clearAllMocks())

  it('each post is a row: the title is the post edit link, with its status', async () => {
    apiReturns([summary()])

    await renderPage()

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.about.readNextLinks.writing') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'First post' })).toHaveAttribute('href', '/admin/posts/p1/edit')
    expect(screen.getByRole('cell', { name: msg('Admin.statuses.post.DRAFT') })).toBeInTheDocument()
  })

  it('reads EVERY post through the API pagination (100 per call), not the 20 posts of the page being viewed', async () => {
    apiReturns([summary()])

    await renderPage({ page: '3' })

    // The counters and filters need the whole list; the page's ?page never reaches the API.
    expect(listAdminPosts).toHaveBeenCalledWith({ page: 0, size: 100 })
  })

  it('formats the published date in UTC, not the server timezone', async () => {
    // 19:00Z is 02:00 the NEXT day in Asia/Ho_Chi_Minh, which the suite pins TZ to.
    // So this instant renders as 2 October with an explicit timeZone and 3 October
    // without one — the only kind of fixture that can detect the option's removal.
    apiReturns([summary({ status: 'PUBLISHED', publishedAt: '2026-10-02T19:00:00Z' })])

    const { container } = await renderPage()
    const times = Array.from(container.querySelectorAll('time'))

    expect(times.length).toBeGreaterThan(0)
    for (const time of times) {
      expect(time.textContent).toContain('2 thg 10')
      expect(time.textContent).not.toContain('3 thg 10')
      // The original instant, machine readable.
      expect(time).toHaveAttribute('dateTime', '2026-10-02T19:00:00Z')
    }
  })

  it('an unpublished post says "Not published" instead of a date', async () => {
    apiReturns([summary({ status: 'DRAFT', publishedAt: null })])

    const { container } = await renderPage()

    expect(screen.getAllByText(msg('Admin.editor.facts.notPublished')).length).toBeGreaterThan(0)
    expect(container.querySelector('time')).toBeNull()
  })

  it('no post yet: exactly one invitation to write the first post', async () => {
    apiReturns([])

    await renderPage()

    // The literal first thing this project's owner will see after logging in.
    expect(screen.getByText(msg('Admin.dashboard.noPosts.title'))).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: new RegExp(`${esc(msg('Admin.dashboard.newPost'))}|new post`, 'i') }),
    ).toHaveAttribute('href', '/admin/posts/new')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('no post yet: a secondary link to import posts below "Write a post", with a different name', async () => {
    apiReturns([])

    await renderPage()

    const write = screen.getByRole('link', { name: msg('Admin.dashboard.noPosts.action') })
    const importLink = screen.getByRole('link', { name: msg('Admin.posts.import.entry.empty') })
    expect(importLink).toHaveAttribute('href', '/admin/posts/import')
    expect(importLink.textContent).not.toBe(write.textContent)
    // Below the primary action, in the same empty state.
    expect(write.compareDocumentPosition(importLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The header carries no second copy of the link while the list is empty.
    expect(screen.queryByRole('link', { name: msg('Admin.posts.import.entry.header') })).toBeNull()
  })

  it.each(['ADMIN', 'AUTHOR'])(
    'a list with posts has the import link in its header next to "Write a post" for an %s',
    async (role) => {
      adminRole.mockResolvedValueOnce(role)
      apiReturns([summary()])

      await renderPage()

      const importLink = screen.getByRole('link', { name: msg('Admin.posts.import.entry.header') })
      expect(importLink).toHaveAttribute('href', '/admin/posts/import')
      const write = screen.getByRole('link', { name: msg('Admin.dashboard.newPost') })
      expect(write).toHaveAttribute('href', '/admin/posts/new')
      expect(importLink.parentElement).toBe(write.parentElement)
      expect(screen.queryByRole('link', { name: msg('Admin.posts.import.entry.empty') })).toBeNull()
    },
  )

  it('redirects to login when the session died inside the request', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAdminPosts.mockRejectedValue(new SessionExpiredError())

    await expect(AdminPostsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  // Pinned on purpose: a 403 is no longer thrown to error.tsx. Still never to the login page —
  // signing in again successfully and being refused again is a loop; only SessionExpiredError redirects.
  it('403 (the token still carries an old role): the no-permission state inside the admin frame, no redirect; other errors are still thrown', async () => {
    listAdminPosts.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    await renderPage()

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.about.readNextLinks.writing') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.noAccess.account.title'))).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(redirect).not.toHaveBeenCalled()

    listAdminPosts.mockRejectedValueOnce(new ApiError(503, undefined, 'down'))
    await expect(AdminPostsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('down')
  })

  it('renders an unknown status as its raw name rather than an empty cell', async () => {
    // A fourth PostStatus added to the backend must be visible, not blank.
    apiReturns([summary({ status: 'SCHEDULED' })])

    await renderPage()

    expect(screen.getByRole('cell', { name: 'SCHEDULED' })).toBeInTheDocument()
  })

  it('overview: real numbers by status and views; the first three cells are filters', async () => {
    apiReturns([
      summary({ id: 'a', status: 'PUBLISHED', viewCount: 1200, publishedAt: '2026-10-01T00:00:00Z' }),
      summary({ id: 'b', status: 'PUBLISHED', viewCount: 34, publishedAt: '2026-10-01T00:00:00Z' }),
      summary({ id: 'c', status: 'DRAFT' }),
    ])

    await renderPage()

    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.all')} 3` })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.published')} 2` })).toHaveAttribute(
      'href',
      '/admin?status=published',
    )
    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.draft')} 1` })).toHaveAttribute(
      'href',
      '/admin?status=draft',
    )
    // vi-VN groups thousands with a dot.
    expect(screen.getByText('1.234')).toBeInTheDocument()
  })

  it('?status=draft lists only drafts, and the "Draft" cell is the selected one', async () => {
    apiReturns([
      summary({ id: 'a', title: 'Published one', status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }),
      summary({ id: 'c', title: 'Draft one', status: 'DRAFT' }),
    ])

    await renderPage({ status: 'draft' })

    expect(listedTitles()).toEqual(['Draft one'])
    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.draft')} 1` })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.all')} 2` })).not.toHaveAttribute('aria-current')
  })

  it('search ignores accents, and the search box keeps the chosen status filter', async () => {
    apiReturns([
      summary({
        id: 'a',
        title: ACCENTED_TITLE,
        slug: 'sample-async',
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
      }),
      summary({
        id: 'b',
        title: OTHER_ACCENTED_TITLE,
        slug: 'sample-source',
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
      }),
    ])

    const { container } = await renderPage({ q: 'bat dong bo', status: 'published' })

    expect(listedTitles()).toEqual([ACCENTED_TITLE])
    const search = screen.getByRole('search')
    expect(within(search).getByLabelText(msg('Admin.dashboard.toolbar.searchLabel'))).toHaveValue('bat dong bo')
    expect(container.querySelector('input[type="hidden"][name="status"]')).toHaveAttribute('value', 'published')
  })

  it('no post matches: says so and gives a way back to the full list', async () => {
    apiReturns([summary()])

    await renderPage({ q: 'kubernetes' })

    expect(screen.getByText(msg('Admin.dashboard.empty.noMatch'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.dashboard.empty.viewAll') })).toHaveAttribute('href', '/admin')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('filtering by status only and getting empty: says that entry is empty, not "no match"', async () => {
    apiReturns([summary({ status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' })])

    await renderPage({ status: 'draft' })

    expect(
      screen.getByText(msg('Admin.dashboard.empty.noneIn', { filter: msg('Admin.dashboard.filters.draft') })),
    ).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.dashboard.empty.noMatch'))).toBeNull()
    expect(screen.getByRole('link', { name: msg('Admin.dashboard.empty.viewAll') })).toHaveAttribute('href', '/admin')
  })

  it('20 posts per page; a page past the end is clamped to the last page; a garbage ?page is the first page', async () => {
    apiReturns(Array.from({ length: 45 }, (_, i) => summary({ id: `p${i}`, title: `Post ${i + 1}` })))

    await renderPage({ page: '2' })
    expect(listedTitles()).toEqual(['Post 41', 'Post 42', 'Post 43', 'Post 44', 'Post 45'])
    const pager = screen.getByRole('navigation', { name: msg('Site.pagination.label') })
    expect(within(pager).getByRole('link', { name: msg('Admin.common.pager.previous') })).toHaveAttribute('href', '/admin?page=1')
    expect(within(pager).queryByRole('link', { name: 'Trang sau' })).toBeNull()
  })

  it.each([['2147483648'], ['1e3'], ['-1'], ['abc']])('?page=%j shows the first page, no error', async (raw) => {
    apiReturns(Array.from({ length: 25 }, (_, i) => summary({ id: `p${i}`, title: `Post ${i + 1}` })))

    await renderPage({ page: raw })

    expect(listedTitles()[0]).toBe('Post 1')
  })

  it('filter by category: only posts in the category, with a removable "Filtering" chip for that filter', async () => {
    const arch = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }
    const backend = { id: 'c2', name: 'Backend', slug: 'backend', description: null }
    apiReturns([
      summary({ id: 'a', title: 'Architecture post', category: arch }),
      summary({ id: 'b', title: 'Backend post', category: backend }),
    ])

    await renderPage({ cat: 'architecture' })

    expect(listedTitles()).toEqual(['Architecture post'])
    expect(screen.getByLabelText(msg('Site.writing.categories'))).toHaveValue('architecture')
    expect(
      screen.getByRole('link', {
        name: new RegExp(
          `${esc(msg('Admin.dashboard.activeFilters.category', { name: 'Architecture' }))}.*${esc(msg('Admin.dashboard.activeFilters.remove'))}`,
        ),
      }),
    ).toHaveAttribute('href', '/admin')
  })

  it('filter by language: only posts of that language, a language badge on every row, and a removable chip', async () => {
    apiReturns([
      summary({ id: 'a', title: 'Vietnamese post', language: 'vi' }),
      summary({ id: 'b', title: 'English post', language: 'en' }),
    ])

    await renderPage({ lang: 'en' })

    expect(listedTitles()).toEqual(['English post'])
    expect(screen.getByLabelText(msg('Admin.dashboard.toolbar.language'))).toHaveValue('en')
    expect(within(screen.getByRole('table')).getByText(LANGUAGE_NAMES.en)).toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: new RegExp(esc(msg('Admin.dashboard.activeFilters.language', { name: LANGUAGE_NAMES.en }))),
      }),
    ).toHaveAttribute('href', '/admin')
  })

  it('an unknown ?lang= is every language', async () => {
    apiReturns([
      summary({ id: 'a', title: 'Vietnamese post', language: 'vi' }),
      summary({ id: 'b', title: 'English post', language: 'en' }),
    ])

    await renderPage({ lang: 'fr' })

    expect(listedTitles()).toHaveLength(2)
    expect(screen.getByLabelText(msg('Admin.dashboard.toolbar.language'))).toHaveValue('')
  })

  it('sort "Most read": posts with the most views first', async () => {
    apiReturns([
      summary({ id: 'a', title: 'Few', status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z', viewCount: 2 }),
      summary({ id: 'b', title: 'Many', status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z', viewCount: 90 }),
    ])

    await renderPage({ sort: 'views' })

    expect(listedTitles()).toEqual(['Many', 'Few'])
    expect(screen.getByLabelText(msg('Admin.dashboard.toolbar.sort'))).toHaveValue('views')
  })

  it('"Needs attention": real counts, each item a filter link; ?health= filters exactly that kind', async () => {
    const tag = { id: 't1', name: 'AWS', slug: 'aws' }
    apiReturns([
      summary({
        id: 'a',
        title: 'Complete',
        excerpt: 'description',
        tags: [tag],
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        category: { id: 'c', name: 'C', slug: 'c', description: null },
      }),
      summary({
        id: 'b',
        title: 'No description',
        excerpt: null,
        tags: [tag],
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        category: { id: 'c', name: 'C', slug: 'c', description: null },
      }),
    ])

    await renderPage({ health: 'no-excerpt' })

    const attention = screen.getByRole('region', { name: msg('Admin.dashboard.attention.title') })
    expect(
      within(attention).getByRole('link', { name: msg('Admin.dashboard.health.no-excerpt.item', { count: 1 }) }),
    ).toHaveAttribute('aria-current', 'page')
    expect(listedTitles()).toEqual(['No description'])
  })

  it('with nothing needing attention there is no "Needs attention" block', async () => {
    const tag = { id: 't1', name: 'AWS', slug: 'aws' }
    apiReturns([
      summary({
        excerpt: 'description',
        tags: [tag],
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        category: { id: 'c', name: 'C', slug: 'c', description: null },
      }),
    ])

    await renderPage()

    expect(screen.queryByRole('region', { name: msg('Admin.dashboard.attention.title') })).toBeNull()
  })

  it('after deleting a post: announces the fixed sentence, even when the list just became empty', async () => {
    apiReturns([])

    await renderPage({ deleted: '1' })

    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.shell.postDeleted'))
    // Focus goes into the notice: the new page is freshly built so a screen reader does not read a status that already has text,
    // and the "Delete forever" button that held focus was lost with the old page.
    expect(screen.getByRole('status')).toHaveFocus()
  })

  it.each(['Visit example.invalid to claim your prize', '<b>Deleted</b>'])(
    'never repeats %s from ?deleted= on the page (a link could put its own sentence there)',
    async (value) => {
      apiReturns([summary()])

      await renderPage({ deleted: value })

      expect(screen.queryByText(msg('Admin.shell.postDeleted'))).toBeNull()
      expect(document.body).not.toHaveTextContent(value)
    },
  )

  it.each(['2', '', 'true', ' 1 x'])(
    'shows no notice for ?deleted=%j: only the exact flag the delete action sets counts',
    async (value) => {
      apiReturns([summary()])

      await renderPage({ deleted: value })

      expect(screen.queryByText(msg('Admin.shell.postDeleted'))).toBeNull()
    },
  )

  it('shows the fixed sentence only, whatever else the URL carries, and also with the list not empty', async () => {
    apiReturns([summary()])

    await renderPage({ deleted: ['1', 'Visit example.invalid'] })

    expect(screen.getByText(msg('Admin.shell.postDeleted'))).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('example.invalid')
  })

  it('changing the filter by link (chip, status cell): the search box and selects follow the new URL, not keeping old values', async () => {
    const arch = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }
    apiReturns([summary({ id: 'a', title: 'Architecture post', category: arch }), summary({ id: 'b', title: 'Other post' })])
    const view = await renderPage({ cat: 'architecture', q: 'bai', sort: 'views' })
    expect(screen.getByLabelText(msg('Site.writing.categories'))).toHaveValue('architecture')

    // Next keeps the page's React tree when only searchParams change: re-render on the SAME tree, as when clicking
    // the "category Architecture" chip or "Clear all filters".
    view.rerender(await AdminPostsPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByLabelText(msg('Site.writing.categories'))).toHaveValue('')
    expect(screen.getByLabelText(msg('Admin.dashboard.toolbar.sort'))).toHaveValue('newest')
    expect(screen.getByLabelText(msg('Admin.dashboard.toolbar.searchLabel'))).toHaveValue('')
  })

  it('the numbers in the status cells and "Needs attention" count over the active filters: exactly the number of posts the link opens', async () => {
    const arch = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }
    const other = { id: 'c2', name: msg('Admin.analytics.sources.group.other'), slug: 'khac', description: null }
    apiReturns([
      summary({
        id: 'a',
        title: 'Architecture published',
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        category: arch,
        excerpt: null,
      }),
      summary({ id: 'b', title: 'Architecture draft', status: 'DRAFT', category: arch, excerpt: 'yes' }),
      summary({
        id: 'c',
        title: 'Other published',
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        category: other,
        excerpt: null,
      }),
      summary({
        id: 'd',
        title: 'Other published 2',
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        category: other,
        excerpt: null,
      }),
    ])

    await renderPage({ cat: 'architecture' })

    // The whole blog: 4 posts, 3 published, 3 missing a description. Within "Architecture": 2 posts, 1 published, 1 missing a description.
    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.all')} 2` })).toHaveAttribute(
      'href',
      '/admin?cat=architecture',
    )
    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.published')} 1` })).toHaveAttribute(
      'href',
      '/admin?status=published&cat=architecture',
    )
    const attention = screen.getByRole('region', { name: msg('Admin.dashboard.attention.title') })
    expect(
      within(attention).getByRole('link', { name: msg('Admin.dashboard.health.no-excerpt.item', { count: 1 }) }),
    ).toHaveAttribute('href', '/admin?cat=architecture&health=no-excerpt')
    // The list heading has a space between the label and the number: the accessible name is not run together.
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: `${msg('Admin.dashboard.results')} ${msg('Admin.dashboard.postCount', { count: 2 })}`,
      }),
    ).toBeInTheDocument()
  })

  it('a published post has a view link on the blog, opening a new tab; a draft does not', async () => {
    apiReturns([
      summary({
        id: 'a',
        title: msg('Admin.statuses.post.PUBLISHED'),
        slug: 'da-dang',
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
      }),
      summary({ id: 'b', title: 'Draft', slug: 'draft' }),
    ])

    await renderPage()

    const view = screen.getByRole('link', {
      name: `${msg('Admin.dashboard.meta.view')} ${msg('Admin.dashboard.meta.viewSr', { title: msg('Admin.statuses.post.PUBLISHED') })}`,
    })
    expect(view).toHaveAttribute('href', '/posts/da-dang')
    expect(view).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('link', { name: new RegExp(esc(`${msg('Admin.dashboard.meta.view')} “Draft”`)) })).toBeNull()
  })
})

/** Published, with a publish date: enough not to land in "Needs attention" for missing anything. */
const published = (over: Record<string, unknown>) =>
  summary({ status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z', ...over })

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

describe('AdminPostsPage: no more "Archived"', () => {
  afterEach(() => vi.clearAllMocks())

  it('an old link\'s ?status=archived is "All"; no "archived" cell or link; a post stranded in that status is still shown with its own label', async () => {
    apiReturns([
      published({ id: 'a', title: 'Published one' }),
      summary({ id: 'b', title: 'Stranded status', status: 'ARCHIVED' }),
    ])

    await renderPage({ status: 'archived' })

    expect(screen.getByRole('link', { name: `${msg('Admin.dashboard.filters.all')} 2` })).toHaveAttribute('aria-current', 'page')
    expect(listedTitles()).toEqual(['Published one', 'Stranded status'])
    expect(screen.queryByRole('link', { name: new RegExp(esc(msg('Admin.statuses.post.ARCHIVED')), 'i') })).toBeNull()
    expect(screen.getByRole('cell', { name: msg('Admin.statuses.post.ARCHIVED') })).toBeInTheDocument()
  })

  it('"Views" only sums published posts, like the number the public page prints', async () => {
    apiReturns([
      published({ id: 'a', viewCount: 1200 }),
      published({ id: 'b', viewCount: 34 }),
      // A removed post keeps its old views; it is no longer a post readers see.
      summary({ id: 'c', status: 'DRAFT', viewCount: 900 }),
    ])

    await renderPage()

    expect(screen.getByText('1.234')).toBeInTheDocument()
    expect(screen.queryByText('2.134')).toBeNull()
  })
})

describe('AdminPostsPage: "Recently edited" ', () => {
  afterEach(() => vi.clearAllMocks())

  it('?sort=updated: the most recently edited post first; the sort select and table caption say that exact order', async () => {
    apiReturns([
      published({ id: 'a', title: 'Edited long ago', updatedAt: '2026-10-01T00:00:00Z' }),
      summary({ id: 'b', title: 'Just edited', updatedAt: '2026-10-05T00:00:00Z' }),
      published({ id: 'c', title: 'Edited midway', updatedAt: '2026-10-03T00:00:00Z' }),
    ])

    await renderPage({ sort: 'updated' })

    expect(listedTitles()).toEqual(['Just edited', 'Edited midway', 'Edited long ago'])
    expect(screen.getByLabelText(msg('Admin.dashboard.toolbar.sort'))).toHaveValue('updated')
    expect(
      within(screen.getByLabelText(msg('Admin.dashboard.toolbar.sort'))).getByRole('option', {
        name: msg('Admin.dashboard.toolbar.sortUpdated'),
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('table', {
        name: msg('Admin.dashboard.table.caption', {
          filter: msg('Admin.dashboard.filters.all').toLowerCase(),
          searched: 'no',
          sort: 'updated',
          page: 1,
          totalPages: 1,
        }),
      }),
    ).toBeInTheDocument()
  })

  it('the secondary line says "edited <date>" (UTC, machine readable) for a draft; a published post edited on the same day does not', async () => {
    apiReturns([
      summary({ id: 'a', title: 'Draft', updatedAt: '2026-10-02T19:00:00Z' }),
      published({ id: 'b', title: 'Published then edited the same day', updatedAt: '2026-10-01T05:00:00Z' }),
    ])

    await renderPage()

    const [draftRow, publishedRow] = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    const edited = within(draftRow).getByText(editedPattern)
    // 19:00Z is 02:00 THE NEXT DAY in the time zone the test suite pins: by UTC it is still the 2nd.
    expect(edited).toHaveTextContent(`${editedWord} 2 thg 10, 2026`)
    expect(edited.querySelector('time')).toHaveAttribute('dateTime', '2026-10-02T19:00:00Z')
    expect(within(publishedRow).queryByText(editedPattern)).toBeNull()
  })
})

describe('AdminPostsPage: per-row and bulk actions', () => {
  afterEach(() => vi.clearAllMocks())

  const ID = '11111111-1111-1111-1111-111111111111'

  it('each row: a named select box, preview, ZIP download, publish/unpublish, "Best posts", delete; the table head has a select-the-whole-page box', async () => {
    apiReturns([
      summary({ id: ID, title: msg('Admin.statuses.post.DRAFT') }),
      published({ id: 'b', title: msg('Admin.statuses.post.PUBLISHED'), featured: true }),
    ])

    await renderPage()

    const table = screen.getByRole('table')
    expect(
      within(table).getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '2' }) }),
    ).toBeInTheDocument()
    expect(
      within(table).getByRole('checkbox', {
        name: msg('Admin.posts.list.selectRowAria', { title: msg('Admin.statuses.post.DRAFT') }),
      }),
    ).toBeInTheDocument()
    expect(
      within(table).getByRole('link', {
        name: msg('Admin.gallery.uploader.previewAlt', { name: `“${msg('Admin.statuses.post.DRAFT')}”` }),
      }),
    ).toHaveAttribute('href', `/admin/posts/${ID}/preview`)
    expect(within(table).getByRole('link', { name: rowName('download', msg('Admin.statuses.post.DRAFT')) })).toHaveAttribute(
      'href',
      `/admin/posts/${ID}/export`,
    )
    expect(within(table).getByRole('button', { name: rowName('publish', msg('Admin.statuses.post.DRAFT')) })).toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: rowName('unpublish', msg('Admin.statuses.post.PUBLISHED')) }),
    ).toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: rowName('featured', msg('Admin.statuses.post.PUBLISHED')) }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(within(table).getByRole('button', { name: deleteName(msg('Admin.statuses.post.DRAFT')) })).toBeInTheDocument()
  })

  it('the row buttons call the exact Server Action the page passes down, with the row id', async () => {
    vi.mocked(bulkSetPublished).mockResolvedValue({ done: [ID], skipped: [], failed: [] })
    vi.mocked(feature).mockResolvedValue({
      id: ID,
      title: msg('Admin.statuses.post.DRAFT'),
      slug: 's',
      status: 'DRAFT',
      publishedAt: null,
      featuredRank: null,
    })
    apiReturns([summary({ id: ID, title: msg('Admin.statuses.post.DRAFT') })])
    await renderPage()

    await click(screen.getByRole('button', { name: rowName('publish', msg('Admin.statuses.post.DRAFT')) }))
    await click(screen.getByRole('button', { name: rowName('featured', msg('Admin.statuses.post.DRAFT')) }))

    expect(bulkSetPublished).toHaveBeenCalledExactlyOnceWith([ID], true)
    expect(feature).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it('select the whole page then delete: asks again with the post count, confirming calls deletePosts with every id of the page', async () => {
    vi.mocked(deletePosts).mockResolvedValue({ done: [ID, 'b'], skipped: [], failed: [] })
    apiReturns([
      summary({ id: ID, title: msg('Admin.statuses.post.DRAFT') }),
      published({ id: 'b', title: msg('Admin.statuses.post.PUBLISHED') }),
    ])
    await renderPage()

    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '2' }) }))
    await click(
      within(screen.getByRole('group', { name: msg('Admin.posts.list.selected', { count: '2' }) })).getByRole('button', {
        name: msg('Admin.posts.list.deleteN', { count: '2' }),
      }),
    )
    await click(screen.getByRole('button', { name: msg('Admin.posts.list.deleteForeverN', { count: '2' }) }))

    expect(deletePosts).toHaveBeenCalledExactlyOnceWith([ID, 'b'])
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.posts.list.doneAll.delete', { count: '2' }))
  })

  it('changing page or filter is a different list: the selection does not follow', async () => {
    apiReturns(Array.from({ length: 25 }, (_, i) => summary({ id: `p${i}`, title: `Post ${i + 1}` })))
    const view = await renderPage()
    await click(screen.getByRole('checkbox', { name: msg('Admin.posts.list.selectRowAria', { title: 'Post 1' }) }))
    expect(screen.getByRole('group', { name: msg('Admin.posts.list.selected', { count: '1' }) })).toBeInTheDocument()

    // Next keeps the page's React tree when only searchParams change: re-render on the SAME tree.
    view.rerender(await AdminPostsPage({ searchParams: Promise.resolve({ page: '1' }) }))

    expect(screen.queryByRole('group', { name: selectedPrefix })).toBeNull()
  })
})

/** AUTHOR uses this very page, with the backend list already filtered to their own posts. */
describe('AdminPostsPage: AUTHOR', () => {
  afterEach(() => vi.clearAllMocks())

  it('"My posts": every action on their own posts, except "Best posts" — both the button and the "Needs attention" item and its filter', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    // A draft the admin already put into "Featured posts": for ADMIN it is the "featured but not published" item.
    apiReturns([summary({ title: 'My draft', featured: true })])

    await renderPage({ health: 'featured-unpublished' })

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.myPosts') })).toBeInTheDocument()
    const table = screen.getByRole('table')
    for (const name of [msg('Admin.gallery.uploader.previewAlt', { name: '“My draft”' }), rowName('download', 'My draft')]) {
      expect(within(table).getByRole('link', { name })).toBeInTheDocument()
    }
    for (const name of [rowName('publish', 'My draft'), deleteName('My draft')]) {
      expect(within(table).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(within(table).queryByRole('button', { name: new RegExp('^' + esc(msg('Admin.posts.row.featured'))) })).toBeNull()
    expect(screen.getByRole('region', { name: msg('Admin.dashboard.attention.title') })).not.toHaveTextContent(
      msg('Site.footer.links.startHere'),
    )
    // The `?health=` of that item filters nothing: the post stays in the list, no "Filtering" chip.
    expect(listedTitles()).toEqual(['My draft'])
    expect(screen.queryByText(msg('Site.search.active.label'))).toBeNull()
  })

  it('deleting asks with the author wording (the post leaves the list, an administrator keeps it); an administrator is asked about a permanent delete', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    apiReturns([summary({ title: 'My draft' })])
    const author = await renderPage()

    await act(async () => {
      fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: deleteName('My draft') }))
    })
    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.posts.row.author.consequences'))
    expect(screen.getByRole('group')).not.toHaveTextContent(msg('Admin.posts.row.consequences'))
    author.unmount()

    apiReturns([summary({ title: 'My draft' })])
    await renderPage()
    await act(async () => {
      fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: deleteName('My draft') }))
    })
    expect(screen.getByRole('group')).toHaveTextContent(msg('Admin.posts.row.consequences'))
  })
})
