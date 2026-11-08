import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostSummary, SeriesAdmin } from '@/lib/types'

const { getAdminSeries, listAdminPosts, redirect, notFound, adminRole } = vi.hoisted(() => ({
  getAdminSeries: vi.fn(),
  listAdminPosts: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  getAdminSeries,
  listAdminPosts,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect, notFound }))
// The action file is 'use server' and pulls in next/cache; the page only forwards to them.
vi.mock('../actions', () => ({ saveSeries: vi.fn(), saveSeriesParts: vi.fn(), removeSeries: vi.fn() }))

import { ApiError } from '@/lib/api'
import EditSeriesPage from './page'
import { msg } from '@/test/render-intl'

const ID = '5f0c2a1e-3b4d-4c6e-8f7a-9b0c1d2e3f40'
const OTHER = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const series = (over: Partial<SeriesAdmin> = {}): SeriesAdmin => ({
  id: ID,
  title: 'A test series',
  slug: 'a-test-series',
  description: 'A few introduction lines.',
  posts: [
    { id: 'p2', title: msg('Site.series.part', { number: 'one' }), slug: 'part-one', status: 'PUBLISHED', position: 1 },
    { id: 'p1', title: msg('Site.series.part', { number: 'next' }), slug: 'part-next', status: 'DRAFT', position: 3 },
  ],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

const post = (id: string, over: Partial<PostSummary> = {}): PostSummary => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 3,
  publishedAt: '2026-10-03T02:00:00Z',
  series: null,
  ...over,
})

const ref = (id: string, title: string) => ({ id, slug: 's', title, position: 1, partNumber: null, partCount: null })

const everyPost = [
  post('le'),
  post('p2', { title: msg('Site.series.part', { number: 'one' }), series: ref(ID, 'A test series') }),
  post('khac', { series: ref(OTHER, 'Neighbor series') }),
  post('p1', { title: msg('Site.series.part', { number: 'next' }), status: 'DRAFT', series: ref(ID, 'A test series') }),
]

async function renderPage(s: SeriesAdmin = series(), posts: PostSummary[] = everyPost) {
  getAdminSeries.mockResolvedValue(s)
  listAdminPosts.mockResolvedValue({ items: posts, meta: { page: 0, size: 100, totalElements: posts.length, totalPages: 1 } })
  return render(await EditSeriesPage({ params: Promise.resolve({ id: s.id }) }))
}

afterEach(() => vi.clearAllMocks())

describe('/admin/series/[id]', () => {
  it('the edit form is prefilled; parts by position; the "Add post" box has the remaining posts, with the other series label', async () => {
    await renderPage()

    expect(getAdminSeries).toHaveBeenCalledWith(ID)
    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.series.edit.title') })).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Admin.series.form.titleLabel'))).toHaveValue('A test series')
    expect(screen.getByLabelText(msg('Site.breadcrumb.label'))).toHaveValue('a-test-series')
    expect(screen.getByLabelText(msg('Admin.topics.manager.descriptionLabel'))).toHaveValue('A few introduction lines.')

    const parts = within(screen.getByRole('list', { name: msg('Admin.series.parts.orderLabel') }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('[data-title]')?.textContent)
    expect(parts).toEqual([msg('Site.series.part', { number: 'one' }), msg('Site.series.part', { number: 'next' })])

    const options = within(screen.getByLabelText(msg('Admin.series.parts.addLabel')))
      .getAllByRole('option')
      .filter((o) => (o as HTMLOptionElement).value !== '')
      .map((o) => o.textContent)
    // A post that is already a part of this series does not repeat in the "Add post" box.
    expect(options).toEqual(['Post le', `Post khac ${msg('Admin.series.parts.optionOtherSeries', { name: 'Neighbor series' })}`])
  })

  it('the top of the page says which series is being edited: the h1 is the same for every series', async () => {
    await renderPage()

    expect(screen.getByText(msg('Admin.series.edit.description', { title: 'A test series' }))).toBeInTheDocument()
  })

  it('order of the regions: "Parts", "Info", "Delete" — also the stacking order on phones', async () => {
    await renderPage()

    const sections = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(sections).toEqual([
      msg('Admin.series.edit.partsHeading'),
      msg('Admin.series.edit.infoHeading'),
      msg('Admin.series.delete.heading'),
    ])
    expect(screen.getByRole('region', { name: msg('Admin.series.edit.partsHeading') })).toContainElement(
      screen.getByRole('list', { name: msg('Admin.series.parts.orderLabel') }),
    )
    expect(screen.getByRole('region', { name: msg('Admin.series.edit.infoHeading') })).toContainElement(
      screen.getByLabelText(msg('Admin.series.form.titleLabel')),
    )
  })

  it('the "All series" link goes back to the list', async () => {
    await renderPage()

    // The arrow is now an icon (aria-hidden) of PageHeader, no longer a "←" character in the link name.
    expect(screen.getByRole('link', { name: msg('Site.discovery.allSeries') })).toHaveAttribute('href', '/admin/series')
  })

  it('a published part → a link to view the series on the blog; none → no link (that page is a 404)', async () => {
    const { unmount } = await renderPage()
    expect(screen.getByRole('link', { name: msg('Admin.posts.preview.viewOnBlog') })).toHaveAttribute(
      'href',
      '/series/a-test-series',
    )
    unmount()

    await renderPage(
      series({
        posts: [
          {
            id: 'p1',
            title: msg('Site.series.part', { number: 'next' }),
            slug: 'part-next',
            status: 'DRAFT',
            position: 1,
          },
        ],
      }),
    )
    expect(screen.queryByRole('link', { name: msg('Admin.posts.preview.viewOnBlog') })).toBeNull()
  })

  it('there is a delete-series button, and it only opens the confirmation step', async () => {
    await renderPage()

    expect(screen.getByRole('button', { name: msg('Admin.series.delete.heading') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeNull()
  })

  it('id not a UUID → 404 at once, no API call (the backend returns 400 for it)', async () => {
    await expect(EditSeriesPage({ params: Promise.resolve({ id: 'a-test-series' }) })).rejects.toThrow(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    )
    expect(getAdminSeries).not.toHaveBeenCalled()
    expect(listAdminPosts).not.toHaveBeenCalled()
  })

  it('series does not exist (404 SERIES_NOT_FOUND) → the 404 page', async () => {
    getAdminSeries.mockRejectedValue(new ApiError(404, 'SERIES_NOT_FOUND', `Series not found: ${ID}`))
    listAdminPosts.mockResolvedValue({ items: [], meta: { page: 0, size: 100, totalElements: 0, totalPages: 0 } })

    await expect(EditSeriesPage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
    expect(notFound).toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('session expired → the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    getAdminSeries.mockRejectedValue(new SessionExpiredError())
    listAdminPosts.mockResolvedValue({ items: [], meta: { page: 0, size: 100, totalElements: 0, totalPages: 0 } })

    await expect(EditSeriesPage({ params: Promise.resolve({ id: ID }) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  // Pinned on purpose: the series' own sentence gives way to the shared AdminOnly state.
  it('403 (the token still carries an old role) → the admin-only page, no redirect', async () => {
    getAdminSeries.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    listAdminPosts.mockResolvedValue({ items: [], meta: { page: 0, size: 100, totalElements: 0, totalPages: 0 } })

    render(await EditSeriesPage({ params: Promise.resolve({ id: ID }) }))

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.series.edit.title') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('AUTHOR: the admin-only page, does not call the backend', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')

    render(await EditSeriesPage({ params: Promise.resolve({ id: ID }) }))

    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(getAdminSeries).not.toHaveBeenCalled()
    expect(listAdminPosts).not.toHaveBeenCalled()
  })
})
