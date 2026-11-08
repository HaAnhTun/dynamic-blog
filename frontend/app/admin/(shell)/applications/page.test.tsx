import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listAuthorApplications, redirect, cookieStore, adminRole } = vi.hoisted(() => ({
  listAuthorApplications: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  cookieStore: { get: vi.fn() },
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAuthorApplications,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => ({ refresh: vi.fn() }),
}))
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))
vi.mock('./actions', () => ({ approveApplication: vi.fn(), rejectApplication: vi.fn() }))

import { ApiError } from '@/lib/api'
import type { AdminAuthorApplication } from '@/lib/types'
import { approveApplication, rejectApplication } from './actions'
import AdminApplicationsPage from './page'
import { msg } from '@/test/render-intl'

/** A catalog message with its rich tags unwrapped to their content. */
const plain = (key: string, args: Record<string, unknown> = {}): string =>
  msg(key, { ...args, strong: (c: string) => c, bdi: (c: string) => c, b: (c: string) => c } as never)

/** The accessible name of the approve button of an application. */
const approveName = (handle: string): string =>
  `${msg('Admin.applications.list.approve')} ${msg('Admin.applications.list.ofApplicant', { handle })}`

const SELF = '99999999-9999-9999-9999-999999999999'

/** A token with a real payload (base64url) and a dropped signature: the page only reads the `sub` claim, it does not check the signature. */
function token(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256' })}.${part(payload)}.sig`
}

const application = (over: Partial<AdminAuthorApplication> = {}): AdminAuthorApplication => ({
  id: '11111111-1111-1111-1111-111111111111',
  status: 'PENDING',
  motivation: 'Writing Go',
  createdAt: '2026-10-02T19:00:00Z',
  decidedAt: null,
  applicant: {
    id: '22222222-2222-2222-2222-222222222222',
    displayName: 'Octo Cat',
    githubLogin: 'octocat',
    avatarUrl: null,
    role: 'USER',
    status: 'ACTIVE',
  },
  ...over,
})

function apiReturns(
  items: AdminAuthorApplication[],
  meta: Partial<{ page: number; totalElements: number; totalPages: number }> = {},
) {
  listAuthorApplications.mockResolvedValue({
    items,
    meta: { page: 0, size: 20, totalElements: items.length, totalPages: items.length === 0 ? 0 : 1, ...meta },
  })
}

async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  return render(await AdminApplicationsPage({ searchParams: Promise.resolve(params) }))
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

beforeEach(() => {
  cookieStore.get.mockReturnValue({ value: token({ sub: SELF, role: 'ADMIN' }) })
})
afterEach(() => vi.clearAllMocks())

describe('Author applications page', () => {
  it('not ADMIN: AUTHOR does not call the backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = await renderPage()
    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.applications') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(listAuthorApplications).not.toHaveBeenCalled()
    author.unmount()

    listAuthorApplications.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    await renderPage()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: new RegExp(`^${msg('Admin.applications.title')}`) })).toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('default "Pending", first page; the tab has aria-current; the list has a name; the application count in the heading', async () => {
    apiReturns([application()])

    await renderPage()

    expect(listAuthorApplications).toHaveBeenCalledWith({ status: 'PENDING', page: 0, size: 20 })
    const tabs = screen.getByRole('navigation', { name: msg('Admin.comments.statusNav') })
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      [msg('Admin.statuses.application.PENDING'), '/admin/applications'],
      [msg('Admin.statuses.application.APPROVED'), '/admin/applications?status=approved'],
      [msg('Site.profile.author.status.rejected.title'), '/admin/applications?status=rejected'],
    ])
    expect(within(tabs).getByRole('link', { name: msg('Admin.statuses.application.PENDING') })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      `${msg('Admin.statuses.application.PENDING')} ${msg('Admin.applications.count', { count: 1 })}`,
    )
    expect(
      screen.getByRole('list', {
        name: msg('Admin.applications.listLabel', {
          status: msg('Admin.statuses.application.PENDING').toLowerCase(),
          page: '1',
          totalPages: '1',
        }),
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Writing Go')).toBeInTheDocument()
  })

  it('reads entry and page from the URL; an unknown value is "Pending"; past the last page goes to the last page', async () => {
    apiReturns([application({ status: 'REJECTED', decidedAt: '2026-10-05T00:00:00Z' })], {
      page: 1,
      totalElements: 25,
      totalPages: 2,
    })
    await renderPage({ status: 'rejected', page: '1' })
    expect(listAuthorApplications).toHaveBeenCalledWith({ status: 'REJECTED', page: 1, size: 20 })
    // The "Rejected" entry has no button at all: a decided application cannot be decided again.
    const list = screen.getByRole('list', {
      name: msg('Admin.applications.listLabel', {
        status: msg('Admin.statuses.application.REJECTED').toLowerCase(),
        page: '2',
        totalPages: '2',
      }),
    })
    expect(within(list).queryAllByRole('button')).toEqual([])
    expect(
      within(screen.getByRole('navigation', { name: msg('Site.pagination.label') })).getByRole('link', {
        name: msg('Admin.common.pager.previous'),
      }),
    ).toHaveAttribute('href', '/admin/applications?status=rejected')

    vi.clearAllMocks()
    apiReturns([])
    await renderPage({ status: 'CANCELLED' })
    expect(listAuthorApplications).toHaveBeenCalledWith({ status: 'PENDING', page: 0, size: 20 })
    expect(screen.getByText(msg('Admin.applications.empty.pending.title'))).toBeInTheDocument()

    listAuthorApplications.mockResolvedValue({ items: [], meta: { page: 9, size: 20, totalElements: 21, totalPages: 2 } })
    await expect(AdminApplicationsPage({ searchParams: Promise.resolve({ status: 'approved', page: '9' }) })).rejects.toThrow(
      'NEXT_REDIRECT',
    )
    expect(redirect).toHaveBeenCalledWith('/admin/applications?status=approved&page=1')
  })

  it('session expired → login; 4xx → local message; 5xx → rethrown for error.tsx', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAuthorApplications.mockRejectedValueOnce(new SessionExpiredError())
    await expect(AdminApplicationsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    listAuthorApplications.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'bad status'))
    await renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.invalidDetail', { detail: 'bad status' }))

    listAuthorApplications.mockRejectedValueOnce(new ApiError(503, undefined, 'down'))
    await expect(AdminApplicationsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('down')
  })

  it('the row buttons call the exact Server Action with the exact id; the application of the signed-in person (`sub` claim) has no button', async () => {
    const other = application({
      id: '44444444-4444-4444-4444-444444444444',
      applicant: { ...application().applicant, id: '55555555-5555-5555-5555-555555555555', githubLogin: 'hubot' },
    })
    const mine = application({
      id: '33333333-3333-3333-3333-333333333333',
      applicant: { ...application().applicant, id: SELF, displayName: 'Myself', githubLogin: 'me' },
    })
    apiReturns([application(), other, mine])
    vi.mocked(approveApplication).mockResolvedValue(application({ status: 'APPROVED', decidedAt: '2026-10-10T00:00:00Z' }))
    vi.mocked(rejectApplication).mockResolvedValue({ ...other, status: 'REJECTED', decidedAt: '2026-10-10T00:00:00Z' })
    await renderPage()

    expect(screen.queryByRole('button', { name: approveName('@me') })).toBeNull()
    await click(screen.getByRole('button', { name: approveName('@octocat') }))
    const panel = screen.getByRole('group', { name: plain('Admin.applications.list.confirmApprove', { handle: '@octocat' }) })
    fireEvent.change(
      within(panel).getByRole('textbox', { name: plain('Admin.applications.list.confirmLogin', { handle: '@octocat' }) }),
      {
        target: { value: 'octocat' },
      },
    )
    // Making a reader an author asks for the administrator's own code (audit 111).
    fireEvent.change(within(panel).getByRole('textbox', { name: msg('Admin.stepUp.codeLabel') }), {
      target: { value: '482913' },
    })
    await click(within(panel).getByRole('button', { name: msg('Admin.applications.list.approveApplication') }))
    await click(
      screen.getByRole('button', {
        name: `${msg('Admin.applications.list.reject')} ${msg('Admin.applications.list.ofApplicant', { handle: '@hubot' })}`,
      }),
    )
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.applications.list.reject') }))

    // Swapping the onApprove/onReject props would make "Approve application" call rejectApplication.
    expect(approveApplication).toHaveBeenCalledExactlyOnceWith(application().id, '482913')
    expect(rejectApplication).toHaveBeenCalledExactlyOnceWith(other.id)
  })
})
