import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { listContactMessages, getContactUnreadCount, redirect, router, adminRole } = vi.hoisted(() => ({
  listContactMessages: vi.fn(),
  getContactUnreadCount: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
  router: { refresh: vi.fn() },
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listContactMessages,
  getContactUnreadCount,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => router,
}))
// The action file is 'use server'; the page only forwards the two actions to ContactInbox.
vi.mock('./actions', () => ({ markContactRead: vi.fn(async () => null), removeContactMessage: vi.fn(async () => null) }))

import { ApiError } from '@/lib/api'
import type { ContactMessage } from '@/lib/types'
import { markContactRead, removeContactMessage } from './actions'
import AdminContactPage from './page'
import { msg } from '@/test/render-intl'
import viCatalog from '@/messages/vi.json'

const ID = '11111111-1111-1111-1111-111111111111'
const NAME = 'Jane Visitor'
const EMAIL = 'jane@example.com'
const TEXT = 'Hello there.\nSecond line of the message.'

const message = (over: Partial<ContactMessage> = {}): ContactMessage => ({
  id: ID,
  name: NAME,
  email: EMAIL,
  subject: 'A question',
  message: TEXT,
  locale: 'en',
  createdAt: '2026-10-14T09:30:00Z',
  readAt: null,
  ...over,
})

function apiReturns(
  items: ContactMessage[],
  {
    unread = items.filter((item) => item.readAt === null).length,
    ...meta
  }: Partial<{ unread: number; page: number; totalElements: number; totalPages: number }> = {},
) {
  listContactMessages.mockResolvedValue({
    items,
    meta: { page: 0, size: 20, totalElements: items.length, totalPages: items.length === 0 ? 0 : 1, ...meta },
  })
  getContactUnreadCount.mockResolvedValue(unread)
}

async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  return render(await AdminContactPage({ searchParams: Promise.resolve(params) }))
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

/** The accessible name of a card button: its visible word and the target message. */
/** The announced sentence: the catalog line with its rich <bdi> tag around the name left out. */
const notice = (kind: 'read' | 'delete') => viCatalog.Admin.contact.notice[kind].replace('{name}', NAME).replace(/<\/?bdi>/g, '')

const action = (key: string, name = NAME) => `${msg(`Admin.contact.${key}`)} ${msg('Admin.contact.target', { name })}`

afterEach(() => vi.clearAllMocks())

describe('Contact inbox page', () => {
  it('not ADMIN: AUTHOR does not call the backend; a 403 from a stale token is also the admin-only page', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')
    const author = await renderPage()
    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.contact.title') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(listContactMessages).not.toHaveBeenCalled()
    expect(getContactUnreadCount).not.toHaveBeenCalled()
    author.unmount()

    listContactMessages.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    getContactUnreadCount.mockResolvedValue(0)
    await renderPage()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('asks for the first page of 20 and the unread count, and shows both numbers', async () => {
    apiReturns([message(), message({ id: '2', readAt: '2026-10-14T10:00:00Z' })], { unread: 7, totalElements: 9 })

    await renderPage()

    expect(listContactMessages).toHaveBeenCalledWith(0, 20)
    expect(getContactUnreadCount).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      `${msg('Admin.contact.count', { count: 9 })} ${msg('Admin.contact.unreadCount', { count: 7 })}`,
    )
  })

  it('a message card: name, email as a mailto link, subject, date and time with the zone, the page language, the unread badge', async () => {
    apiReturns([message()])

    await renderPage()

    const card = screen.getByRole('article', { name: NAME })
    expect(within(card).getByRole('link', { name: EMAIL })).toHaveAttribute('href', `mailto:${EMAIL}`)
    expect(within(card).getByText('A question')).toBeInTheDocument()
    const time = card.querySelector('time')
    expect(time).toHaveAttribute('datetime', '2026-10-14T09:30:00Z')
    // Locale-aware and zone-explicit: the UTC clock, never the machine's.
    expect(time?.textContent).toMatch(/2026/)
    expect(time?.textContent).toMatch(/09:30/)
    expect(time?.textContent).toMatch(/UTC/)
    expect(within(card).getByText(msg('Admin.contact.pageLanguage', { locale: 'EN' }))).toBeInTheDocument()
    expect(within(card).getByText(msg('Admin.contact.unreadBadge'))).toBeInTheDocument()
  })

  it('a missing or blank subject shows the fallback label; a read message has no badge and no "Mark as read"', async () => {
    apiReturns([message({ subject: null, readAt: '2026-10-14T10:00:00Z' }), message({ id: '2', name: 'Bob', subject: '   ' })])

    await renderPage()

    expect(screen.getAllByText(msg('Admin.contact.noSubject'))).toHaveLength(2)
    const read = screen.getByRole('article', { name: NAME })
    expect(within(read).queryByText(msg('Admin.contact.unreadBadge'))).toBeNull()
    expect(within(read).queryByRole('button', { name: action('markRead') })).toBeNull()
    expect(within(read).getByRole('button', { name: action('delete') })).toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: 'Bob' })).getByText(msg('Admin.contact.unreadBadge'))).toBeInTheDocument()
  })

  it('the text is plain escaped text with its line breaks kept, never HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>\nthird'
    apiReturns([message({ name: '<b>Bold</b>', subject: '<i>sub</i>', message: hostile })])

    const { container } = await renderPage()

    const body = screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === hostile)
    expect(body).toHaveClass('whitespace-pre-wrap')
    expect(container.querySelector('script, img, b, i')).toBeNull()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('<b>Bold</b>')
    expect(screen.getByText('<i>sub</i>')).toBeInTheDocument()
  })

  it('an address with a query character cannot add a mail header to the mailto link', async () => {
    apiReturns([message({ email: 'a?cc=x@example.com' })])

    await renderPage()

    expect(screen.getByRole('link', { name: 'a?cc=x@example.com' })).toHaveAttribute('href', 'mailto:a%3Fcc%3Dx@example.com')
  })

  it('"Mark as read" calls the action with the id, drops the badge and the button, says so, and keeps the delete button', async () => {
    apiReturns([message()])
    await renderPage()

    await click(screen.getByRole('button', { name: action('markRead') }))

    expect(markContactRead).toHaveBeenCalledWith(ID)
    const card = screen.getByRole('article', { name: NAME })
    expect(within(card).queryByText(msg('Admin.contact.unreadBadge'))).toBeNull()
    expect(within(card).queryByRole('button', { name: action('markRead') })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(notice('read'))
    expect(card).toHaveFocus()
  })

  it('"Mark as read" failing shows the sentence on the card and keeps the message unread', async () => {
    apiReturns([message()])
    vi.mocked(markContactRead).mockResolvedValueOnce({ error: 'Not now.' })
    await renderPage()

    await click(screen.getByRole('button', { name: action('markRead') }))

    expect(screen.getByRole('alert')).toHaveTextContent('Not now.')
    expect(screen.getByText(msg('Admin.contact.unreadBadge'))).toBeInTheDocument()
  })

  it('"Delete" asks first (focus on Cancel); Cancel deletes nothing; Escape also cancels', async () => {
    apiReturns([message()])
    await renderPage()

    await click(screen.getByRole('button', { name: action('delete') }))
    const group = screen.getByRole('group')
    expect(within(group).getByRole('button', { name: msg('Admin.contact.cancel') })).toHaveFocus()
    expect(removeContactMessage).not.toHaveBeenCalled()

    await click(within(group).getByRole('button', { name: msg('Admin.contact.cancel') }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: action('delete') })).toHaveFocus()

    await click(screen.getByRole('button', { name: action('delete') }))
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' })
    expect(screen.queryByRole('group')).toBeNull()
    expect(removeContactMessage).not.toHaveBeenCalled()
    expect(screen.getByRole('article', { name: NAME })).toBeInTheDocument()
  })

  it('confirming the delete calls the action with the id, removes the card and announces it', async () => {
    apiReturns([message(), message({ id: '2', name: 'Bob' })])
    await renderPage()

    await click(within(screen.getByRole('article', { name: NAME })).getByRole('button', { name: action('delete') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.contact.delete') }))

    expect(removeContactMessage).toHaveBeenCalledWith(ID)
    expect(screen.queryByRole('article', { name: NAME })).toBeNull()
    expect(screen.getByRole('article', { name: 'Bob' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(notice('delete'))
    expect(screen.getByRole('status')).toHaveFocus()
  })

  it('a failed delete keeps the card and shows the sentence inside the confirmation', async () => {
    apiReturns([message()])
    vi.mocked(removeContactMessage).mockResolvedValueOnce({ error: 'Cannot delete.' })
    await renderPage()

    await click(screen.getByRole('button', { name: action('delete') }))
    await click(within(screen.getByRole('group')).getByRole('button', { name: msg('Admin.contact.delete') }))

    expect(within(screen.getByRole('group')).getByRole('alert')).toHaveTextContent('Cannot delete.')
    expect(screen.getByRole('article', { name: NAME })).toBeInTheDocument()
  })

  it('empty inbox: the empty state, no list', async () => {
    apiReturns([], { unread: 0 })

    await renderPage()

    expect(screen.getByText(msg('Admin.contact.empty.title'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: msg('Admin.contact.listLabel') })).toBeNull()
    expect(screen.queryByRole('navigation', { name: msg('Admin.contact.pager.label') })).toBeNull()
  })

  it('reads the page from the URL and links the pager to its neighbours; a hostile ?page= is the first page', async () => {
    apiReturns([message()], { page: 1, totalElements: 45, totalPages: 3 })

    await renderPage({ page: '1' })

    expect(listContactMessages).toHaveBeenCalledWith(1, 20)
    const pager = screen.getByRole('navigation', { name: msg('Admin.contact.pager.label') })
    expect(pager).toHaveTextContent(msg('Admin.contact.pager.summary', { from: 21, to: 40, total: 45, page: 2, totalPages: 3 }))
    expect(within(pager).getByRole('link', { name: msg('Admin.contact.pager.previous') })).toHaveAttribute(
      'href',
      '/admin/contact',
    )
    expect(within(pager).getByRole('link', { name: msg('Admin.contact.pager.next') })).toHaveAttribute(
      'href',
      '/admin/contact?page=2',
    )

    listContactMessages.mockClear()
    await renderPage({ page: '-1e9' })
    expect(listContactMessages).toHaveBeenCalledWith(0, 20)
  })

  it('a page beyond the last one goes to the last page', async () => {
    apiReturns([], { page: 9, totalElements: 45, totalPages: 3 })

    await expect(renderPage({ page: '9' })).rejects.toThrow('NEXT_REDIRECT')

    expect(redirect).toHaveBeenCalledWith('/admin/contact?page=2')
  })

  it('session expired → login; 4xx → local message; 5xx → rethrown for error.tsx', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    getContactUnreadCount.mockResolvedValue(0)
    listContactMessages.mockRejectedValueOnce(new SessionExpiredError())
    await expect(AdminContactPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')

    listContactMessages.mockRejectedValueOnce(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist'))
    await renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent(
      msg('Errors.admin.refusedDetail', { detail: 'The requested endpoint does not exist' }),
    )

    listContactMessages.mockRejectedValueOnce(new ApiError(503, undefined, 'down'))
    await expect(AdminContactPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('down')
  })
})
