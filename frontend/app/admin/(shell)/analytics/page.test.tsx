import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getAnalytics, redirect, adminRole } = vi.hoisted(() => ({
  getAnalytics: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  getAnalytics,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))

import { ApiError } from '@/lib/api'
import type { Analytics } from '@/lib/types'
import { msg } from '@/test/intl'
import { DAY_10, DAY_8, DAY_9 } from '@/test/fixtures/vi/analytics-dates'
import AdminAnalyticsPage from './page'
import { RANGE_MESSAGES } from './range'

const report = (over: Partial<Analytics> = {}): Analytics => ({
  from: '2026-10-08',
  to: '2026-10-10',
  timeZone: 'Asia/Ho_Chi_Minh',
  since: '2026-10-09',
  totals: { views: 7, allTimeViews: 1234 },
  daily: [
    { day: '2026-10-08', views: 0 },
    { day: '2026-10-09', views: 5 },
    { day: '2026-10-10', views: 2 },
  ],
  topPosts: [
    { id: 'p1', slug: 'bai-dau-tien', title: 'First post', status: 'PUBLISHED', views: 5 },
    { id: 'p2', slug: 'bai-da-go', title: 'Removed post', status: 'DRAFT', views: 2 },
  ],
  // The order the backend returns is not the display order.
  sources: [
    { source: 'search', views: 4 },
    { source: 'other', views: 0 },
    { source: 'internal', views: 1 },
    { source: 'direct', views: 2 },
    { source: 'github', views: 0 },
    { source: 'social', views: 0 },
  ],
  ...over,
})

async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  return render(await AdminAnalyticsPage({ searchParams: Promise.resolve(params) }))
}

/** The text of each cell (th of the row and td) of the table body rows. */
function bodyRows(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent ?? ''))
}

afterEach(() => vi.clearAllMocks())

describe('Analytics page', () => {
  it('ADMIN, no parameters: asks the backend for the default range; totals cells, chart, per-day table, most read, sources', async () => {
    getAnalytics.mockResolvedValue(report())

    await renderPage()

    expect(getAnalytics).toHaveBeenCalledExactlyOnceWith({ from: undefined, to: undefined })
    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.analytics') })).toBeInTheDocument()
    expect(document.body).toHaveTextContent(
      msg('Admin.analytics.report.range', {
        from: () => DAY_8,
        to: () => DAY_10,
        timeZone: 'Asia/Ho_Chi_Minh',
      } as never),
    )
    expect(screen.getByText(msg('Admin.analytics.totals.inRange')).nextElementSibling).toHaveTextContent('7')
    expect(screen.getByText(msg('Admin.analytics.totals.allTime')).nextElementSibling).toHaveTextContent('1.234')
    expect(screen.getByText(new RegExp(msg('Admin.analytics.report.note').split(',')[0]!))).toHaveTextContent(
      `${msg('Admin.analytics.report.note').split('; ')[1]} ${msg('Admin.analytics.report.dailySince', { day: () => DAY_9 } as never)}`,
    )

    // The chart is an image with a one-line summary; the per-day numbers are in the table.
    expect(
      screen.getByRole('img', {
        name: msg('Admin.analytics.chart.summary', { from: DAY_8, to: DAY_10, total: 7, peak: 5, peakDay: DAY_9 }),
      }),
    ).toBeInTheDocument()
    const daily = screen.getByRole('table', {
      name: msg('Admin.analytics.daily.caption', { from: DAY_8, to: DAY_10 }),
    })
    // A day before `since`: not measured, not 0 views.
    expect(bodyRows(daily)).toEqual([
      [DAY_8, `—${msg('Admin.analytics.daily.noData')}`],
      [DAY_9, '5'],
      [DAY_10, '2'],
    ])
    expect(screen.getByRole('region', { name: msg('Admin.analytics.daily.tableLabel') })).toHaveAttribute('tabindex', '0')

    const top = screen.getByRole('table', { name: msg('Admin.analytics.top.caption') })
    expect(within(top).getByRole('link', { name: 'First post' })).toHaveAttribute('href', '/admin/posts/p1/edit')
    expect(within(top).getAllByText(msg('Admin.statuses.post.DRAFT')).length).toBeGreaterThan(0)

    expect(bodyRows(screen.getByRole('table', { name: msg('Admin.analytics.sources.caption') }))).toEqual([
      [msg('Admin.analytics.sources.group.direct'), '2', '29%'],
      [msg('Admin.analytics.sources.group.search'), '4', '57%'],
      [msg('Admin.analytics.sources.group.social'), '0', '0%'],
      ['GitHub', '0', '0%'],
      [msg('Admin.analytics.sources.group.internal'), '1', '14%'],
      [msg('Admin.analytics.sources.group.other'), '0', '0%'],
    ])
  })

  it("AUTHOR: the same page, the author wording; the backend is still asked (it limits itself to the caller's posts)", async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    getAnalytics.mockResolvedValue(report())

    await renderPage()

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.analytics.copy.author.title') })).toBeInTheDocument()
    expect(getAnalytics).toHaveBeenCalledTimes(1)
  })

  it('GET form: two labelled date fields carrying the range the backend returned; a self-chosen range has a way back to the default', async () => {
    getAnalytics.mockResolvedValue(report({ from: '2026-09-01', to: '2026-09-30' }))

    await renderPage({ from: '2026-09-01', to: '2026-09-30' })

    expect(getAnalytics).toHaveBeenCalledExactlyOnceWith({ from: '2026-09-01', to: '2026-09-30' })
    const form = screen.getByRole('form', { name: msg('Admin.analytics.range.label') })
    expect(form).toHaveAttribute('action', '/admin/analytics')
    expect(form).toHaveAttribute('method', 'get')
    expect(within(form).getByLabelText(msg('Admin.analytics.range.from'))).toHaveValue('2026-09-01')
    expect(within(form).getByLabelText(msg('Admin.analytics.range.to'))).toHaveValue('2026-09-30')
    expect(within(form).getByRole('link', { name: msg('Admin.analytics.range.last30') })).toHaveAttribute(
      'href',
      '/admin/analytics',
    )
  })

  it.each([
    [{ from: '2026-13-01', to: '2026-10-10' }, RANGE_MESSAGES.format, ['from']],
    [{ from: '2026-10-10', to: '2026-10-01' }, RANGE_MESSAGES.order, ['from', 'to']],
    [{ from: '2025-01-01', to: '2026-10-10' }, RANGE_MESSAGES.tooLong, ['from', 'to']],
  ])('invalid date range %j: a local message, the wrong field marked, no backend call', async (params, messageKey, fields) => {
    const message = msg(`Admin.analytics.${messageKey}`, { days: 366 })
    await renderPage(params)

    expect(getAnalytics).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    for (const [name, label] of [
      ['from', msg('Admin.analytics.range.from')],
      ['to', msg('Admin.analytics.range.to')],
    ] as const) {
      const input = screen.getByLabelText(label)
      expect(input.getAttribute('aria-invalid'), name).toBe(fields.includes(name) ? 'true' : null)
      expect(input).toHaveAccessibleDescription(message)
    }
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('session expired → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    getAnalytics.mockRejectedValue(new SessionExpiredError())

    await expect(AdminAnalyticsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('403 (the token still carries an old role): the no-permission state, no redirect', async () => {
    getAnalytics.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    await renderPage()

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.analytics') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.noAccess.account.title'))).toBeInTheDocument()
    expect(screen.queryByRole('form')).toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('backend rejects the date range (400): a Vietnamese message in place, the form remains to change it', async () => {
    getAnalytics.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'from must not be after to'))

    await renderPage({ from: '2026-10-01' })

    expect(screen.getByRole('alert')).toHaveTextContent(
      msg('Errors.admin.invalidDetail', { detail: 'from must not be after to' }),
    )
    expect(screen.getByRole('form', { name: msg('Admin.analytics.range.label') })).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Admin.analytics.range.from'))).toHaveValue('2026-10-01')
  })

  it('server error (5xx) or lost connection: rethrown to the admin error.tsx', async () => {
    getAnalytics.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'boom'))
    await expect(AdminAnalyticsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('boom')

    getAnalytics.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(AdminAnalyticsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('fetch failed')
  })

  it('no views in the range: the empty state instead of the chart and table; the all-time total still shows', async () => {
    getAnalytics.mockResolvedValue(
      report({
        totals: { views: 0, allTimeViews: 1234 },
        daily: [{ day: '2026-10-10', views: 0 }],
        topPosts: [],
        sources: report().sources.map((row) => ({ ...row, views: 0 })),
      }),
    )

    await renderPage()

    expect(screen.getByText(msg('Admin.analytics.report.emptyTitle'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.analytics.totals.allTime')).nextElementSibling).toHaveTextContent('1.234')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
