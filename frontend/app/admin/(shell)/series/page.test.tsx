import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeriesAdmin, SeriesAdminPost } from '@/lib/types'

const { listAdminSeries, redirect, adminRole } = vi.hoisted(() => ({
  listAdminSeries: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAdminSeries,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect }))
// The action file is 'use server' and pulls in next/cache; the page only passes it down to the form.
vi.mock('./actions', () => ({ addSeries: vi.fn() }))

import { ApiError } from '@/lib/api'
import SeriesListPage from './page'
import { msg } from '@/test/render-intl'

const member = (id: string, status = 'PUBLISHED', position = 1): SeriesAdminPost => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  status,
  position,
})

const series = (id: string, over: Partial<SeriesAdmin> = {}): SeriesAdmin => ({
  id,
  title: `Series ${id}`,
  slug: `series-${id}`,
  description: null,
  posts: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

const rowOf = (title: string) => screen.getByText(title).closest('li')!

afterEach(() => vi.clearAllMocks())

describe('/admin/series', () => {
  it('each series: name, post count, public path and an edit link to its page', async () => {
    listAdminSeries.mockResolvedValue([
      series('s1', { title: 'A test series', slug: 'a-test-series', posts: [member('a'), member('b', 'PUBLISHED', 2)] }),
      series('s2', { title: 'Half-published series', posts: [member('c'), member('d', 'DRAFT', 2), member('e', 'DRAFT', 3)] }),
    ])

    render(await SeriesListPage())

    expect(screen.getByRole('heading', { level: 1, name: 'Series' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: msg('Admin.series.listLabel') })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)

    const first = rowOf('A test series')
    expect(first).toHaveTextContent(msg('Admin.topics.manager.usageAll', { count: '2' }))
    expect(first).toHaveTextContent('/series/a-test-series')
    // The published count only when it differs from the total: "2 posts · 2 published" says one thing twice.
    expect(first).not.toHaveTextContent(msg('Admin.statuses.post.PUBLISHED').toLowerCase())
    expect(within(first).getByRole('link', { name: msg('Admin.series.editAria', { title: 'A test series' }) })).toHaveAttribute(
      'href',
      '/admin/series/s1',
    )

    const second = rowOf('Half-published series')
    expect(second).toHaveTextContent(msg('Admin.topics.manager.usagePartly', { count: '3', published: '1' }))
    expect(
      within(second).getByRole('link', { name: msg('Admin.series.editAria', { title: 'Half-published series' }) }),
    ).toHaveAttribute('href', '/admin/series/s2')
  })

  it('the spoken name of the edit link sits entirely in ONE sr-only span, the visible name is aria-hidden', async () => {
    // jsdom has no CSS so it cannot catch this bug: split into sr-only "Edit series “" + name +
    // sr-only "”", in Chrome (and Playwright) sr-only is position:absolute, the span becomes a block, and
    // the name becomes "Edit series “ Name ”" — an E2E link looked up by name would no longer match (measured with Chrome).
    listAdminSeries.mockResolvedValue([series('s1', { title: 'A test series' })])

    render(await SeriesListPage())

    const link = screen.getByRole('link', { name: msg('Admin.series.editAria', { title: 'A test series' }) })
    const spoken = link.querySelectorAll('.sr-only')
    expect(spoken).toHaveLength(1)
    expect(spoken[0].textContent).toBe(msg('Admin.series.editAria', { title: 'A test series' }))
    expect(within(link).getByText('A test series')).toHaveAttribute('aria-hidden', 'true')
  })

  it('the top of the page has an anchor link "Create series" to the form; the only "Create series" button is the form submit button', async () => {
    listAdminSeries.mockResolvedValue([series('s1')])

    render(await SeriesListPage())

    expect(screen.getByRole('link', { name: msg('Admin.series.create') })).toHaveAttribute('href', '#tao-series')
    const region = screen.getByRole('region', { name: msg('Admin.series.createHeading') })
    expect(region.querySelector('#tao-series')).toHaveTextContent(msg('Admin.series.createHeading'))
    // getAllByRole: exactly one button, and it sits in the create area.
    const buttons = screen.getAllByRole('button', { name: msg('Admin.series.create') })
    expect(buttons).toHaveLength(1)
    expect(region).toContainElement(buttons[0])
  })

  it('a series with no published post says plainly it is not on the public page yet', async () => {
    listAdminSeries.mockResolvedValue([
      series('s1', { title: 'Already there', posts: [member('a')] }),
      series('s2', { title: 'Freshly created' }),
      series('s3', { title: 'All drafts', posts: [member('b', 'DRAFT')] }),
    ])

    render(await SeriesListPage())

    expect(rowOf('Freshly created')).toHaveTextContent(msg('Admin.series.countNone'))
    expect(rowOf('Freshly created')).toHaveTextContent(msg('Admin.series.hiddenOnSite'))
    expect(rowOf('All drafts')).toHaveTextContent(msg('Admin.series.hiddenOnSite'))
    expect(rowOf('Already there')).not.toHaveTextContent(msg('Admin.series.hiddenOnSite'))
  })

  it('no series yet: says so plainly; the create form is still there', async () => {
    listAdminSeries.mockResolvedValue([])

    render(await SeriesListPage())

    expect(screen.getByText(msg('Site.series.empty'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: msg('Admin.series.listLabel') })).toBeNull()
    expect(screen.getByRole('button', { name: msg('Admin.series.create') })).toBeInTheDocument()
  })

  it('the form for a new series: the name is required', async () => {
    listAdminSeries.mockResolvedValue([series('s1')])

    render(await SeriesListPage())

    const region = screen.getByRole('region', { name: msg('Admin.series.createHeading') })
    expect(within(region).getByLabelText(msg('Admin.series.form.titleLabel'))).toBeRequired()
    expect(within(region).getByRole('button', { name: msg('Admin.series.create') })).toBeInTheDocument()
  })

  it('session expired while loading the page → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAdminSeries.mockRejectedValue(new SessionExpiredError())

    await expect(SeriesListPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  // Pinned on purpose: the series' own sentence gives way to the shared AdminOnly state.
  it('403 (the token still carries an old role) → the admin-only page, no redirect', async () => {
    listAdminSeries.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    render(await SeriesListPage())

    expect(screen.getByRole('heading', { level: 1, name: 'Series' })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: msg('Admin.series.create') })).toBeNull()
    // The anchor link at the top of the page too: there is no form to anchor to.
    expect(screen.queryByRole('link', { name: msg('Admin.series.create') })).toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('AUTHOR: the admin-only page, does not call the backend', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')

    render(await SeriesListPage())

    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(listAdminSeries).not.toHaveBeenCalled()
  })

  it('another error (backend down) is not turned into a redirect to the login page', async () => {
    listAdminSeries.mockRejectedValue(new Error('fetch failed'))

    await expect(SeriesListPage()).rejects.toThrow('fetch failed')
    expect(redirect).not.toHaveBeenCalled()
  })
})
