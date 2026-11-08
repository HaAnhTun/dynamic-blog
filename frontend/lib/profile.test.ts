import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError, getPosts, getUserProfile, userTag } from './api'
import { formatJoinedMonth, isProfileSlug, profileHref, profilePath } from './profile'
import { msg } from '@/test/render-intl'
import { translatorFor } from '@/test/intl'
import { A_HOOK } from '@/test/fixtures/vi/accented-text'

const joinedT = translatorFor('vi', 'Meta.profile')

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('profile slug and link', () => {
  it('accepts exactly the shape the backend issues, rejects the rest', () => {
    for (const slug of ['alice', 'alice-nguyen', 'a1-b2-c3', 'a'.repeat(64)]) expect(isProfileSlug(slug), slug).toBe(true)
    for (const slug of ['', 'Alice', 'alice_n', '-a', 'a-', 'a--b', 'a b', A_HOOK, '../x', 'a'.repeat(65), 42, null, undefined]) {
      expect(isProfileSlug(slug), String(slug)).toBe(false)
    }
  })

  it('the site owner goes to /about, others to /u/<slug>; a missing person, a missing or invalid slug gives no link', () => {
    expect(profileHref({ siteOwner: true, profileSlug: 'chu-blog' })).toBe('/about')
    // An old backend sends no slug for anybody: no link at all, the site owner included.
    expect(profileHref({ siteOwner: true })).toBeNull()
    expect(profileHref({ siteOwner: false, profileSlug: 'alice-nguyen' })).toBe('/u/alice-nguyen')
    expect(profilePath('alice-nguyen')).toBe('/u/alice-nguyen')
    expect(profileHref({ siteOwner: false })).toBeNull()
    // A person who is locked: the backend returns a null slug.
    expect(profileHref({ siteOwner: false, profileSlug: null })).toBeNull()
    expect(profileHref({ siteOwner: false, profileSlug: 'javascript:alert(1)' })).toBeNull()
    expect(profileHref(null)).toBeNull()
    expect(profileHref(undefined)).toBeNull()
  })

  it('joined month in UTC, null when unreadable', () => {
    // The suite runs in Asia/Ho_Chi_Minh: 20:00Z on 31/12 is already the next year in the machine's local time.
    expect(formatJoinedMonth('2025-12-31T20:00:00Z', joinedT)).toBe(
      msg('Meta.profile.joinedMonth', { month: '12', year: '2025' }),
    )
    expect(formatJoinedMonth('2026-03-01T00:00:00Z', joinedT)).toBe(msg('Meta.profile.joinedMonth', { month: '3', year: '2026' }))
    for (const bad of ['', 'not a date', null, undefined]) expect(formatJoinedMonth(bad, joinedT)).toBeNull()
  })
})

describe('getUserProfile', () => {
  const PROFILE = {
    slug: 'alice-nguyen',
    displayName: 'Alice Nguyen',
    githubLogin: 'alice',
    avatarUrl: null,
    siteOwner: false,
    joinedAt: '2026-10-01T08:00:00Z',
    publishedPosts: 0,
  }

  it("GET /api/v1/users/{slug} with a 300 second cache under the users tag and the person's own tag", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: PROFILE })))
    vi.stubGlobal('fetch', fetchMock)

    expect(await getUserProfile('alice-nguyen')).toEqual(PROFILE)

    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe('/api/v1/users/alice-nguyen')
    expect(fetchMock.mock.calls[0][1]).toEqual({ next: { revalidate: 300, tags: ['users', 'posts', 'user-alice-nguyen'] } })
  })

  it('keeps the slug in the users path and the tag at no more than 256 characters', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ data: PROFILE })))
    vi.stubGlobal('fetch', fetchMock)

    await getUserProfile('../admin')

    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe('/api/v1/users/..%2Fadmin')
    expect(userTag('a'.repeat(2000))).toHaveLength(256)
  })

  it('returns only the contract fields: email, role, backend id sent by mistake are dropped', async () => {
    const leaky = { ...PROFILE, id: 'u-1', email: 'alice@example.com', role: 'USER', status: 'ACTIVE' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: leaky })))

    const profile = await getUserProfile('alice-nguyen')

    expect(Object.keys(profile).sort()).toEqual(Object.keys(PROFILE).sort())
  })

  it('404 USER_NOT_FOUND is a NotFoundError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }, 404)),
    )

    await expect(getUserProfile('khong-co')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('getPosts author', () => {
  it('sends author after the older filters, and sends nothing when there is none', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: [], pagination: { page: 0, size: 10, totalElements: 0, totalPages: 0 } })),
      )
    vi.stubGlobal('fetch', fetchMock)

    await getPosts({ page: 1, size: 10, tag: 'aws', author: 'tran-bich' })
    await getPosts({ page: 0, size: 10 })

    expect(new URL(fetchMock.mock.calls[0][0] as string).search).toBe('?page=1&size=10&tag=aws&author=tran-bich')
    expect(new URL(fetchMock.mock.calls[1][0] as string).search).toBe('?page=0&size=10')
    expect(fetchMock.mock.calls[0][1]).toEqual({ next: { revalidate: 300, tags: ['posts'] } })
  })
})
