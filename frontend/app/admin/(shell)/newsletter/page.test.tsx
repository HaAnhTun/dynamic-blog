import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getNewsletterStats, getHeldNewsletterIssues, redirect, adminRole } = vi.hoisted(() => ({
  getNewsletterStats: vi.fn(),
  getHeldNewsletterIssues: vi.fn(async (): Promise<unknown[]> => []),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  getNewsletterStats,
  getHeldNewsletterIssues,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))

import { ApiError } from '@/lib/api'
import type { HeldNewsletterIssue, NewsletterStats } from '@/lib/types'
import AdminNewsletterPage from './page'
import { msg } from '@/test/render-intl'
import viCatalog from '@/messages/vi.json'

// The part of the transport note after the rich <code> element (the catalog keeps the tags in the raw message).
const transportNote = new RegExp(
  (viCatalog.Admin.newsletter.transport.split('</code>').pop() ?? '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
)

const POST_ID = '11111111-1111-1111-1111-111111111111'

const stats = (over: Partial<NewsletterStats> = {}): NewsletterStats => ({
  subscribers: { pending: 3, confirmed: 1250 },
  suppressed: 7,
  issues: [
    {
      postId: POST_ID,
      slug: 'bai-moi',
      title: msg('Admin.editor.titleNew'),
      createdAt: '2026-10-09T03:00:00Z',
      status: 'EXPANDED',
      sent: 1240,
      retrying: 2,
      dead: 1,
      pending: 7,
    },
  ],
  failures: [
    { reason: 'TIMEOUT', count: 2 },
    { reason: 'SMTP_552', count: 1 },
  ],
  ...over,
})

const held = (over: Partial<HeldNewsletterIssue> = {}): HeldNewsletterIssue => ({
  postId: POST_ID,
  slug: 'bai-cho-duyet',
  title: 'A post waiting for approval',
  excerpt: 'Its summary',
  language: 'vi',
  authorName: 'Ada Author',
  heldAt: '2026-10-20T08:00:00Z',
  published: true,
  recipients: 4,
  version: 'version-of-the-text',
  ...over,
})

async function renderPage() {
  return render(await AdminNewsletterPage())
}

afterEach(() => vi.clearAllMocks())

describe('Newsletter page (admin)', () => {
  it('not ADMIN: AUTHOR does not call the backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = await renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Newsletter' })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(getNewsletterStats).not.toHaveBeenCalled()
    expect(getHeldNewsletterIssues).not.toHaveBeenCalled()
    author.unmount()

    getNewsletterStats.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    await renderPage()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('counts by status, the sends table (title links to the post edit page), failures by code: Vietnamese labels, unknown codes shown verbatim', async () => {
    getNewsletterStats.mockResolvedValue(stats())
    await renderPage()

    const counts = within(screen.getByRole('region', { name: msg('Admin.newsletter.subscribers.title') }))
    expect(counts.getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent])).toEqual([
      [msg('Admin.newsletter.subscribers.confirmed.label'), '1.250'],
      [msg('Admin.newsletter.subscribers.pending.label'), '3'],
      [msg('Admin.newsletter.subscribers.suppressed.label'), '7'],
    ])
    // Transport reminder: by default no email is sent.
    expect(screen.getByText(transportNote)).toBeInTheDocument()

    const issues = screen.getByRole('table', { name: msg('Admin.newsletter.issues.title') })
    expect(within(issues).getByRole('link', { name: msg('Admin.editor.titleNew') })).toHaveAttribute(
      'href',
      `/admin/posts/${POST_ID}/edit`,
    )
    const cells = within(issues)
      .getAllByRole('cell')
      .slice(1)
      .map((cell) => cell.textContent)
    expect(cells).toEqual(['9 thg 10, 2026', msg('Admin.newsletter.issues.issueStatus.EXPANDED'), '1.240', '2', '1', '7'])

    const failures = within(screen.getByRole('table', { name: msg('Admin.newsletter.failures.title') }))
    expect(
      failures
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual([`${msg('Admin.newsletter.failures.reason.TIMEOUT')}TIMEOUT2`, 'SMTP_5521'])
  })

  it('newsletters waiting for approval come first, with their own section; none, no section', async () => {
    getNewsletterStats.mockResolvedValue(stats())
    getHeldNewsletterIssues.mockResolvedValueOnce([held()])
    const withHeld = await renderPage()

    const section = screen.getByRole('region', { name: msg('Admin.newsletter.held.title') })
    expect(within(section).getByRole('article', { name: 'A post waiting for approval' })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: new RegExp(msg('Admin.newsletter.held.release')) })).toBeInTheDocument()
    expect(
      section.compareDocumentPosition(screen.getByRole('region', { name: msg('Admin.newsletter.subscribers.title') })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    withHeld.unmount()

    await renderPage()
    expect(screen.queryByRole('region', { name: msg('Admin.newsletter.held.title') })).toBeNull()
  })

  it('a full list (the backend lists 100) says that others may be waiting; a shorter one does not', async () => {
    getNewsletterStats.mockResolvedValue(stats())
    getHeldNewsletterIssues.mockResolvedValueOnce(
      Array.from({ length: 100 }, (_, index) => held({ postId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}` })),
    )
    const full = await renderPage()
    expect(screen.getByText(msg('Admin.newsletter.held.more', { count: 100 }))).toBeInTheDocument()
    full.unmount()

    getHeldNewsletterIssues.mockResolvedValueOnce([held()])
    await renderPage()
    expect(screen.queryByText(msg('Admin.newsletter.held.more', { count: 1 }))).toBeNull()
  })

  it('a send waiting for approval or refused is labelled in the table of sends', async () => {
    getNewsletterStats.mockResolvedValue(
      stats({
        issues: [
          { ...stats().issues[0], status: 'HELD' },
          { ...stats().issues[0], postId: '22222222-2222-2222-2222-222222222222', status: 'DISCARDED' },
        ],
      }),
    )
    await renderPage()

    const issues = screen.getByRole('table', { name: msg('Admin.newsletter.issues.title') })
    expect(within(issues).getByText(msg('Admin.newsletter.issues.issueStatus.HELD'))).toBeInTheDocument()
    expect(within(issues).getByText(msg('Admin.newsletter.issues.issueStatus.DISCARDED'))).toBeInTheDocument()
  })

  it('no post sent, no failure: the empty state says why', async () => {
    getNewsletterStats.mockResolvedValue(stats({ issues: [], failures: [] }))
    await renderPage()

    expect(screen.getByText(msg('Admin.newsletter.issues.emptyTitle'))).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.newsletter.failures.none'))).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('session expired → login; 4xx → local message; 5xx → rethrown for error.tsx', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    getNewsletterStats.mockRejectedValueOnce(new SessionExpiredError())
    await expect(AdminNewsletterPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    getNewsletterStats.mockRejectedValueOnce(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist'))
    await renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent(
      msg('Errors.admin.refusedDetail', { detail: 'The requested endpoint does not exist' }),
    )

    getNewsletterStats.mockRejectedValueOnce(new ApiError(503, undefined, 'down'))
    await expect(AdminNewsletterPage()).rejects.toThrow('down')
  })
})
