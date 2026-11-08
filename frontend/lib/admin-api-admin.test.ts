import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import { ApiError } from './api'
import {
  SessionExpiredError,
  getMediaUsage,
  getMfaStatus,
  listAdminComments,
  mergeCategory,
  mergeTag,
  resetAuthorMfa,
} from './admin-api'

/*
 * The admin-api part for the admin screens (the admin block at the end of lib/admin-api.ts): merging categories and
 * tags, media usage, filtering comments by post. Tested the same way as admin-api.test.ts:
 * fake fetch, read back exactly the request that went out.
 */

function respondFresh(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
}

function callOf(fetchSpy: ReturnType<typeof respondFresh>, n = 0) {
  const [url, init] = fetchSpy.mock.calls[n] as [string, RequestInit]
  return {
    method: init.method ?? 'GET',
    url: new URL(url),
    headers: new Headers(init.headers),
    body: init.body,
  }
}

const ID = '11111111-1111-1111-1111-111111111111'
const TARGET = '22222222-2222-2222-2222-222222222222'

afterEach(() => {
  vi.restoreAllMocks()
  cookieStore.get.mockReset()
})

describe('merging categories and tags', () => {
  it('merge tags: POST /tags/{id}/merge with a JSON body containing only targetId, returns the target and the number of posts moved', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const target = { id: TARGET, name: 'Amazon Web Services', slug: 'aws' }
    const fetchSpy = respondFresh(200, { data: { target, moved: 3 } })

    const result = await mergeTag(ID, TARGET)

    const call = callOf(fetchSpy)
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe(`/api/v1/admin/tags/${ID}/merge`)
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.headers.get('authorization')).toBe('Bearer token')
    expect(JSON.parse(call.body as string)).toEqual({ targetId: TARGET })
    expect(result).toEqual({ target, moved: 3 })
  })

  it('merge categories: same shape at /categories/{id}/merge', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const target = { id: TARGET, name: 'Backend', slug: 'backend', description: null }
    const fetchSpy = respondFresh(200, { data: { target, moved: 0 } })

    expect(await mergeCategory(ID, TARGET)).toEqual({ target, moved: 0 })
    expect(callOf(fetchSpy).url.pathname).toBe(`/api/v1/admin/categories/${ID}/merge`)
  })

  it('a backend error is an ApiError carrying the code, so the action translates it to Vietnamese', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(400, { error: { code: 'TAG_NOT_FOUND', message: 'Tag not found' } })

    await expect(mergeTag(ID, TARGET)).rejects.toMatchObject({ status: 400, code: 'TAG_NOT_FOUND' })
    await expect(mergeTag(ID, TARGET)).rejects.toBeInstanceOf(ApiError)
  })
})

describe('media usage', () => {
  it('GET /api/v1/admin/media/usage, no cache, returns exactly the three numbers', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = respondFresh(200, { data: { usedBytes: 7_000_000, maxBytes: 1_073_741_824, count: 8 } })

    expect(await getMediaUsage()).toEqual({ usedBytes: 7_000_000, maxBytes: 1_073_741_824, count: 8 })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(callOf(fetchSpy).url.pathname).toBe('/api/v1/admin/media/usage')
    expect(callOf(fetchSpy).method).toBe('GET')
    expect(init.cache).toBe('no-store')
  })

  it('old backend without the endpoint: 404 ENDPOINT_NOT_FOUND is an ApiError (the page hides the gauge by itself)', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(404, { error: { code: 'ENDPOINT_NOT_FOUND', message: 'The requested endpoint does not exist' } })

    await expect(getMediaUsage()).rejects.toMatchObject({ status: 404, code: 'ENDPOINT_NOT_FOUND' })
  })
})

describe('filtering comments by post', () => {
  it('postId goes along in the query string with the status, search box, page and size', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const meta = { page: 1, size: 20, totalElements: 21, totalPages: 2 }
    const fetchSpy = respondFresh(200, { data: [], pagination: meta })

    const page = await listAdminComments({ status: 'HIDDEN', q: 'spam', postId: ID, page: 1, size: 20 })

    const { url } = callOf(fetchSpy)
    expect(url.pathname).toBe('/api/v1/admin/comments')
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '1', size: '20', status: 'HIDDEN', q: 'spam', postId: ID })
    expect(page).toEqual({ items: [], meta })
  })

  it('with no filter no parameter is sent: the backend treats absence as "no filter"', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = respondFresh(200, { data: [], pagination: { page: 0, size: 20, totalElements: 0, totalPages: 0 } })

    await listAdminComments({ status: null, q: '', postId: null, page: 0, size: 20 })

    expect(Object.fromEntries(callOf(fetchSpy).url.searchParams)).toEqual({ page: '0', size: '20' })
  })
})

// View analytics — a separate block at the end of the file, like the analytics block in lib/admin-api.ts.
import { getAnalytics } from './admin-api'

describe('view statistics', () => {
  const report = {
    from: '2026-09-11',
    to: '2026-10-10',
    timeZone: 'Asia/Ho_Chi_Minh',
    since: '2026-10-01',
    totals: { views: 3, allTimeViews: 120 },
    daily: [{ day: '2026-10-10', views: 3 }],
    topPosts: [{ id: ID, slug: 'bai-dau', title: 'First post', status: 'PUBLISHED', views: 3 }],
    sources: [{ source: 'search', views: 3 }],
  }

  it('with no dates no parameter is sent (the backend picks 30 days itself); GET, no cache, with token', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = respondFresh(200, { data: report })

    expect(await getAnalytics()).toEqual(report)

    const call = callOf(fetchSpy)
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/api/v1/admin/analytics')
    expect(call.url.search).toBe('')
    expect(call.headers.get('authorization')).toBe('Bearer token')
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].cache).toBe('no-store')
  })

  it('only dates that are present are sent; an empty string counts as absent', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = respondFresh(200, { data: report })

    await getAnalytics({ from: '2026-10-01', to: '2026-10-10' })
    await getAnalytics({ to: '2026-10-10' })
    await getAnalytics({ from: '', to: undefined })

    expect(Object.fromEntries(callOf(fetchSpy, 0).url.searchParams)).toEqual({ from: '2026-10-01', to: '2026-10-10' })
    expect(Object.fromEntries(callOf(fetchSpy, 1).url.searchParams)).toEqual({ to: '2026-10-10' })
    expect(callOf(fetchSpy, 2).url.search).toBe('')
  })

  it('invalid date range: 400 VALIDATION_ERROR is an ApiError carrying the code, so the page translates it to Vietnamese', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(400, { error: { code: 'VALIDATION_ERROR', message: 'from must not be after to' } })

    await expect(getAnalytics({ from: '2026-10-10', to: '2026-10-01' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    })
  })
})

// Newsletter — a separate block at the end of the file, like the newsletter block in lib/admin-api.ts.
import { discardNewsletterIssue, getHeldNewsletterIssues, getNewsletterStats, releaseNewsletterIssue } from './admin-api'
import { msg } from '@/test/render-intl'

describe('newsletter', () => {
  it('GET /api/v1/admin/newsletter, no cache, with token; returns the counts unchanged', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const stats = {
      subscribers: { pending: 2, confirmed: 5 },
      suppressed: 1,
      issues: [
        {
          postId: ID,
          slug: 'bai-moi',
          title: msg('Admin.editor.titleNew'),
          createdAt: '2026-10-10T01:00:00Z',
          status: 'PENDING',
          sent: 4,
          retrying: 1,
          dead: 0,
          pending: 0,
        },
      ],
      failures: [{ reason: 'TIMEOUT', count: 1 }],
    }
    const fetchSpy = respondFresh(200, { data: stats })

    expect(await getNewsletterStats()).toEqual(stats)
    const call = callOf(fetchSpy)
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/api/v1/admin/newsletter')
    expect(call.url.search).toBe('')
    expect(call.headers.get('authorization')).toBe('Bearer token')
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].cache).toBe('no-store')
  })

  it('AUTHOR (or a token carrying the old role): 403 is an ApiError, so the page shows "for admins only"', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(403, { error: { code: 'FORBIDDEN', message: 'Access denied' } })

    await expect(getNewsletterStats()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })
})

describe('newsletter approval', () => {
  it('held list: GET /api/v1/admin/newsletter/held, no cache, with token; returns the items unchanged', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const items = [
      {
        postId: ID,
        slug: 'bai-cho-duyet',
        title: 'Waiting',
        excerpt: null,
        language: 'vi',
        authorName: 'Ada',
        heldAt: '2026-10-20T08:00:00Z',
        version: 'abc123',
        published: true,
        recipients: 3,
      },
    ]
    const fetchSpy = respondFresh(200, { data: items })

    expect(await getHeldNewsletterIssues()).toEqual(items)
    const call = callOf(fetchSpy)
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/api/v1/admin/newsletter/held')
    expect(call.headers.get('authorization')).toBe('Bearer token')
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].cache).toBe('no-store')
  })

  it('release and discard: POST to the issue of that post (id encoded), 204 becomes null', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = respondFresh(204, undefined)

    expect(await releaseNewsletterIssue(ID, 'v-seen')).toBeNull()
    expect(callOf(fetchSpy).method).toBe('POST')
    expect(callOf(fetchSpy).url.pathname).toBe(`/api/v1/admin/newsletter/issues/${ID}/release`)
    // The version the administrator read goes back with the release: the backend refuses a post that changed since.
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body).toBe(JSON.stringify({ version: 'v-seen' }))

    expect(await discardNewsletterIssue('a/b')).toBeNull()
    expect(callOf(fetchSpy, 1).method).toBe('POST')
    expect(callOf(fetchSpy, 1).url.pathname).toBe('/api/v1/admin/newsletter/issues/a%2Fb/discard')
  })

  it('a newsletter that is not waiting is an ApiError with its code', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(404, { error: { code: 'NEWSLETTER_ISSUE_NOT_FOUND', message: 'No held newsletter for this post' } })

    await expect(releaseNewsletterIssue(ID, 'v-seen')).rejects.toMatchObject({
      status: 404,
      code: 'NEWSLETTER_ISSUE_NOT_FOUND',
    })
  })

  it('a post that changed since the list was loaded is an ApiError with its code', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(409, { error: { code: 'NEWSLETTER_ISSUE_CHANGED', message: 'The post changed' } })

    await expect(releaseNewsletterIssue(ID, 'v-old')).rejects.toMatchObject({
      status: 409,
      code: 'NEWSLETTER_ISSUE_CHANGED',
    })
  })
})

// Contact inbox — a separate block at the end of the file, like the contact block in lib/admin-api.ts.
import { deleteContactMessage, getContactUnreadCount, listContactMessages, markContactMessageRead } from './admin-api'

describe('contact inbox', () => {
  it('list: GET /api/v1/admin/contact/messages with page and size, token, no cache; returns the items and the page meta', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const item = {
      id: ID,
      name: 'Jane Visitor',
      email: 'jane@example.com',
      subject: null,
      message: 'Hello there, this is a message.',
      locale: 'en',
      createdAt: '2026-10-14T09:30:00Z',
      readAt: null,
    }
    const pagination = { page: 1, size: 20, totalElements: 21, totalPages: 2 }
    const fetchSpy = respondFresh(200, { data: [item], pagination })

    expect(await listContactMessages(1, 20)).toEqual({ items: [item], meta: pagination })

    const call = callOf(fetchSpy)
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/api/v1/admin/contact/messages')
    expect(call.url.searchParams.get('page')).toBe('1')
    expect(call.url.searchParams.get('size')).toBe('20')
    expect(call.headers.get('authorization')).toBe('Bearer token')
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].cache).toBe('no-store')
  })

  it('unread count: GET /api/v1/admin/contact/unread-count, returns the number', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = respondFresh(200, { data: { count: 4 } })

    expect(await getContactUnreadCount()).toBe(4)
    expect(callOf(fetchSpy).url.pathname).toBe('/api/v1/admin/contact/unread-count')
  })

  it('mark as read: POST /messages/{id}/read, 204 returns null', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    await expect(markContactMessageRead(ID)).resolves.toBeNull()
    await expect(markContactMessageRead(TARGET)).resolves.toBeNull()

    expect(callOf(fetchSpy).method).toBe('POST')
    expect(callOf(fetchSpy).url.pathname).toBe(`/api/v1/admin/contact/messages/${ID}/read`)
    expect(callOf(fetchSpy, 1).url.pathname).toBe(`/api/v1/admin/contact/messages/${TARGET}/read`)
  })

  it('delete: DELETE /messages/{id}, 204 returns null; an unknown id is an ApiError with the backend code', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    await expect(deleteContactMessage(ID)).resolves.toBeNull()
    expect(callOf(fetchSpy).method).toBe('DELETE')
    expect(callOf(fetchSpy).url.pathname).toBe(`/api/v1/admin/contact/messages/${ID}`)

    respondFresh(404, { error: { code: 'CONTACT_MESSAGE_NOT_FOUND', message: 'Contact message not found' } })
    await expect(deleteContactMessage(ID)).rejects.toMatchObject({ status: 404, code: 'CONTACT_MESSAGE_NOT_FOUND' })
  })

  it('AUTHOR (or a token carrying the old role): 403 is an ApiError, so the page shows "for admins only"', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(403, { error: { code: 'FORBIDDEN', message: 'Access denied' } })

    await expect(listContactMessages(0, 20)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
  })
})

describe('two-step verification: the status and the reset of an author', () => {
  it('getMfaStatus: GET /me/mfa with the caller token, returns the status as the backend sent it', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const status = {
      enrolled: true,
      required: true,
      recoveryCodesRemaining: 8,
      hasPassword: true,
      passwordManagedByEnvironment: false,
    }
    const fetchSpy = respondFresh(200, { data: status })

    expect(await getMfaStatus()).toEqual(status)

    const call = callOf(fetchSpy)
    expect(call.method).toBe('GET')
    expect(call.url.pathname).toBe('/api/v1/me/mfa')
    expect(call.headers.get('authorization')).toBe('Bearer token')
  })

  it('resetAuthorMfa: POST /admin/users/{id}/mfa/reset with only the code in the body, 204 gives null', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))

    expect(await resetAuthorMfa(ID, '123456')).toBeNull()

    const call = callOf(fetchSpy)
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe(`/api/v1/admin/users/${ID}/mfa/reset`)
    expect(JSON.parse(call.body as string)).toEqual({ code: '123456' })
  })

  it.each([
    ['a wrong code', 'MFA_CODE_INVALID'],
    ['a wrong current password', 'INVALID_CREDENTIALS'],
    ['a sign-in that is too old', 'REAUTHENTICATION_REQUIRED'],
  ])('%s is an ApiError carrying the code, not an expired session: the cookies must stay', async (_name, code) => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(401, { error: { code, message: 'English text' } })

    const error = await resetAuthorMfa(ID, '000000').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(SessionExpiredError)
    expect((error as ApiError).status).toBe(401)
    expect((error as ApiError).code).toBe(code)
  })

  it('any other 401 is still an expired session', async () => {
    cookieStore.get.mockReturnValue({ value: 'token' })
    respondFresh(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } })

    await expect(getMfaStatus()).rejects.toBeInstanceOf(SessionExpiredError)
  })
})
