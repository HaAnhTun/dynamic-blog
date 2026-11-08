import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listAdminUsers, redirect, cookieStore, router, adminRole } = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  cookieStore: { get: vi.fn() },
  router: { refresh: vi.fn() },
  // Separate from the cookie below (only to read `sub`): the "cookie unreadable" test is still an ADMIN.
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAdminUsers,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => router,
}))
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))
vi.mock('./actions', () => ({ suspendUser: vi.fn(), unsuspendUser: vi.fn(), changeUserRole: vi.fn(), resetUserMfa: vi.fn() }))

import { ApiError } from '@/lib/api'
import type { AdminUser } from '@/lib/types'
import { changeUserRole, suspendUser, unsuspendUser } from './actions'
import AdminUsersPage from './page'
import { msg } from '@/test/render-intl'
import viCatalog from '@/messages/vi.json'

// Messages with rich tags keep them in the raw catalog: drop the tags and fill the handle to get the plain text.
const plain = (raw: string, handle: string) => raw.replace(/<[^>]+>/g, '').replace('{handle}', handle)
const tableCaption = (role: string, status: string, page: number, totalPages: number, query?: string) =>
  msg('Admin.users.caption', { role, status, searched: query ? 'yes' : 'no', query: query ?? '', page, totalPages })

const SELF = '99999999-9999-9999-9999-999999999999'

/** A token with a real payload (base64url) and a dropped signature: the page only reads the `sub` claim, it does not check the signature. */
function token(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256' })}.${part(payload)}.sig`
}

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: '22222222-2222-2222-2222-222222222222',
  displayName: 'Octo Cat',
  githubLogin: 'octocat',
  avatarUrl: null,
  role: 'USER',
  status: 'ACTIVE',
  createdAt: '2026-10-02T19:00:00Z',
  lastLoginAt: null,
  ...over,
})

function apiReturns(items: AdminUser[], meta: Partial<{ page: number; totalElements: number; totalPages: number }> = {}) {
  listAdminUsers.mockResolvedValue({
    items,
    meta: { page: 0, size: 20, totalElements: items.length, totalPages: items.length === 0 ? 0 : 1, ...meta },
  })
}

async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  return render(await AdminUsersPage({ searchParams: Promise.resolve(params) }))
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

describe('Users page', () => {
  it('top of the page, the accounts table; no filtering by default', async () => {
    apiReturns([user()])

    await renderPage()

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.users') })).toBeInTheDocument()
    expect(listAdminUsers).toHaveBeenCalledWith({ q: '', role: null, status: null, page: 0, size: 20 })
    expect(
      screen.getByRole('table', {
        name: tableCaption(
          msg('Admin.statuses.filter.anyRole').toLowerCase(),
          msg('Admin.statuses.filter.anyStatus').toLowerCase(),
          1,
          1,
        ),
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      `${msg('Admin.users.all')} ${msg('Admin.users.count', { count: 1 })}`,
    )
    expect(screen.getByRole('button', { name: `${msg('Admin.users.table.suspend')} @octocat` })).toBeInTheDocument()
  })

  it('reads search box, role, status and page from the URL; an unknown value is "any…"', async () => {
    apiReturns([user({ status: 'SUSPENDED' })], { page: 1, totalElements: 45, totalPages: 3 })

    await renderPage({ q: ' octo ', role: 'user', status: 'suspended', page: '1' })

    expect(listAdminUsers).toHaveBeenCalledWith({ q: 'octo', role: 'USER', status: 'SUSPENDED', page: 1, size: 20 })
    expect(
      screen.getByRole('table', {
        name: tableCaption(
          msg('Admin.statuses.role.USER').toLowerCase(),
          msg('Admin.statuses.user.SUSPENDED').toLowerCase(),
          2,
          3,
          'octo',
        ),
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      `${msg('Admin.users.results')} ${msg('Admin.users.count', { count: 45 })}`,
    )
    const pager = screen.getByRole('navigation', { name: msg('Site.pagination.label') })
    expect(within(pager).getByRole('link', { name: msg('Admin.common.pager.next') })).toHaveAttribute(
      'href',
      '/admin/users?q=octo&role=user&status=suspended&page=2',
    )

    vi.clearAllMocks()
    apiReturns([user()])
    await renderPage({ role: 'ROOT', status: 'banned' })
    expect(listAdminUsers).toHaveBeenCalledWith({ q: '', role: null, status: null, page: 0, size: 20 })
  })

  it('filter bar: a GET form role="search" with a search box, two labelled selects holding the URL values', async () => {
    apiReturns([user()])

    await renderPage({ q: 'octo', role: 'admin', status: 'active' })

    const search = screen.getByRole('search')
    expect(search).toHaveAttribute('action', '/admin/users')
    expect(search).toHaveAttribute('method', 'get')
    expect(within(search).getByRole('searchbox', { name: msg('Admin.users.searchLabel') })).toHaveValue('octo')
    expect(within(search).getByRole('combobox', { name: msg('Admin.users.roleLabel') })).toHaveValue('admin')
    expect(within(search).getByRole('combobox', { name: msg('Admin.dashboard.table.status') })).toHaveValue('active')
    expect(within(search).getByRole('button', { name: msg('Admin.dashboard.toolbar.filter') })).toHaveAttribute('type', 'submit')
  })

  it('no filtering: both selects stand at "Any…" (empty value), not relying on the browser picking the first entry', async () => {
    apiReturns([user()])

    await renderPage()

    const role = screen.getByRole('combobox', { name: msg('Admin.users.roleLabel') }) as HTMLSelectElement
    const status = screen.getByRole('combobox', { name: msg('Admin.dashboard.table.status') }) as HTMLSelectElement
    expect(role.selectedOptions[0]).toHaveTextContent(msg('Admin.statuses.filter.anyRole'))
    expect(role.selectedOptions[0]).toHaveAttribute('value', '')
    expect(status.selectedOptions[0]).toHaveTextContent(msg('Admin.statuses.filter.anyStatus'))
  })

  it('the row of the signed-in person itself (`sub` claim): the "You" label, no button at all, not even "Change role"', async () => {
    apiReturns([user({ id: SELF, displayName: 'Myself', githubLogin: 'me' })])

    await renderPage()

    expect(screen.getByText(msg('Admin.users.table.you'))).toBeInTheDocument()
    expect(within(screen.getByRole('table')).queryAllByRole('button')).toEqual([])
  })

  it('unreadable cookie: nobody is "You", every reader still has buttons (the backend is still the last gate)', async () => {
    cookieStore.get.mockReturnValue(undefined)
    apiReturns([user()])

    await renderPage()

    expect(screen.queryByText(msg('Admin.users.table.you'))).toBeNull()
    expect(screen.getByRole('button', { name: `${msg('Admin.users.table.suspend')} @octocat` })).toBeInTheDocument()
  })

  it('filtering with no result: says why, with a way back to every account', async () => {
    apiReturns([])

    await renderPage({ q: 'xyz', status: 'suspended' })

    expect(screen.getByText(msg('Admin.users.empty.noMatch'))).toBeInTheDocument()
    expect(
      screen.getByText(msg('Admin.users.empty.queryHint', { query: 'xyz', status: 'suspended', withFilters: 'yes' })),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.users.empty.viewAll') })).toHaveAttribute('href', '/admin/users')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('session expired → login; 4xx → local message, filter bar remains; 5xx → rethrown for error.tsx', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAdminUsers.mockRejectedValueOnce(new SessionExpiredError())
    await expect(AdminUsersPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    listAdminUsers.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'bad role'))
    await renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.invalidDetail', { detail: 'bad role' }))
    expect(screen.getByRole('search')).toBeInTheDocument()

    listAdminUsers.mockRejectedValueOnce(new ApiError(503, undefined, 'down'))
    await expect(AdminUsersPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('down')
  })

  it('not ADMIN: AUTHOR does not call the backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = await renderPage()
    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.users') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(listAdminUsers).not.toHaveBeenCalled()
    author.unmount()

    listAdminUsers.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    await renderPage()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('search')).toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('?page= beyond the last page: redirects to the last page, keeping the filter', async () => {
    listAdminUsers.mockResolvedValue({ items: [], meta: { page: 9, size: 20, totalElements: 21, totalPages: 2 } })

    await expect(AdminUsersPage({ searchParams: Promise.resolve({ role: 'user', page: '9' }) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/users?role=user&page=1')
  })
})

describe('Users page: row buttons call the exact Server Action', () => {
  const OTHER = '33333333-3333-3333-3333-333333333333'

  it('"Suspend" (after confirmation) calls suspendUser, "Unsuspend" calls unsuspendUser, each with the exact id', async () => {
    const active = user()
    const suspended = user({ id: OTHER, displayName: 'Blocked Person', githubLogin: 'blocked-one', status: 'SUSPENDED' })
    apiReturns([active, suspended])
    vi.mocked(suspendUser).mockResolvedValue({ ...active, status: 'SUSPENDED' })
    vi.mocked(unsuspendUser).mockResolvedValue({ ...suspended, status: 'ACTIVE' })
    await renderPage()

    await click(screen.getByRole('button', { name: `${msg('Admin.users.table.suspend')} @octocat` }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspend') }))
    await click(screen.getByRole('button', { name: `${msg('Admin.users.table.unsuspend')} @blocked-one` }))

    // Swapping the onSuspend/onUnsuspend props would make confirming "Suspend" call unsuspendUser.
    expect(suspendUser).toHaveBeenCalledExactlyOnceWith(active.id)
    expect(unsuspendUser).toHaveBeenCalledExactlyOnceWith(OTHER)
  })

  it('"Change role" (after typing the login) calls changeUserRole; the URL role filter reaches the table', async () => {
    vi.mocked(changeUserRole).mockResolvedValue(user({ role: 'AUTHOR' }))
    apiReturns([user()])
    await renderPage({ role: 'user' })

    await click(screen.getByRole('button', { name: `${msg('Admin.users.roleChange.change')} @octocat` }))
    const panel = screen.getByRole('group', { name: plain(viCatalog.Admin.users.roleChange.title, '@octocat') })
    await click(within(panel).getByRole('radio', { name: msg('Site.authorBox.eyebrow') }))
    fireEvent.change(
      within(panel).getByRole('textbox', { name: plain(viCatalog.Admin.users.roleChange.confirmLogin, '@octocat') }),
      {
        target: { value: 'octocat' },
      },
    )
    // A reader becoming an author asks for the administrator's own code.
    fireEvent.change(within(panel).getByRole('textbox', { name: msg('Admin.stepUp.codeLabel') }), {
      target: { value: '482913' },
    })
    await click(
      within(panel).getByRole('button', {
        name: msg('Admin.users.roleChange.changeTo', { role: msg('Admin.statuses.role.AUTHOR') }),
      }),
    )

    expect(changeUserRole).toHaveBeenCalledExactlyOnceWith(user().id, 'AUTHOR', '482913')
    expect(suspendUser).not.toHaveBeenCalled()
    // Filtering "Reader" while the row just became an author: the reload notice is present only when the page passes the role filter down.
    expect(screen.getByRole('button', { name: msg('Admin.common.staleList.reload') })).toBeInTheDocument()
  })

  it('the URL status filter reaches the table: suspending under "Active" gives a reload notice', async () => {
    vi.mocked(suspendUser).mockResolvedValue(user({ status: 'SUSPENDED' }))
    apiReturns([user()])
    await renderPage({ status: 'active' })

    await click(screen.getByRole('button', { name: `${msg('Admin.users.table.suspend')} @octocat` }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.users.table.suspend') }))
    await click(screen.getByRole('button', { name: msg('Admin.common.staleList.reload') }))

    expect(router.refresh).toHaveBeenCalledTimes(1)
  })
})
