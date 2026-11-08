import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import { ApiError } from './api'
import {
  SessionExpiredError,
  approveAuthorApplication,
  createPost,
  createSeries,
  deleteAdminComment,
  deleteGalleryPhoto,
  deletePostCover,
  deleteCategory,
  deletePost,
  deleteSeries,
  deleteTag,
  featurePost,
  fetchAdminPostExport,
  getAdminSeries,
  listAdminComments,
  listAdminGallery,
  listAdminPosts,
  listAdminSeries,
  listAdminUsers,
  listAuthorApplications,
  rejectAuthorApplication,
  renameTag,
  reorderGallery,
  setCommentStatus,
  setFeaturedOrder,
  setSeriesPosts,
  setUserRole,
  setUserStatus,
  unfeaturePost,
  unpublishPost,
  updateCategory,
  updateGalleryPhoto,
  updatePostCoverAlt,
  updateSeries,
  uploadGalleryPhoto,
  uploadPostCover,
} from './admin-api'
import { msg } from '@/test/render-intl'

function respondWith(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

/** A fresh Response on every call: a Response body can only be read once. */
function respondFresh(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: status === 204 ? {} : { 'content-type': 'application/json' },
      }),
  )
}

/** The `n`th fetch call in an easily comparable form: method, pathname, headers and body. */
function callOf(fetchSpy: ReturnType<typeof respondFresh>, n = 0) {
  const [url, init] = fetchSpy.mock.calls[n] as [string, RequestInit]
  return {
    method: init.method ?? 'GET',
    path: new URL(url).pathname,
    headers: new Headers(init.headers),
    body: init.body,
    init: init,
    url,
  }
}

const ID = '11111111-1111-1111-1111-111111111111'

describe('admin-api', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    cookieStore.get.mockReset()
  })

  it('sends the access token as a bearer header', async () => {
    cookieStore.get.mockReturnValue({ value: 'the.access.token' })
    const fetchSpy = respondWith(200, { data: [], pagination: { page: 0, size: 20, totalElements: 0, totalPages: 0 } })

    await listAdminPosts({ page: 0, size: 20 })

    const [, init] = fetchSpy.mock.calls[0]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer the.access.token')
  })

  it('never caches an admin response', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondWith(200, { data: [], pagination: { page: 0, size: 20, totalElements: 0, totalPages: 0 } })

    await listAdminPosts({ page: 0, size: 20 })

    const [, init] = fetchSpy.mock.calls[0]
    // A cached draft list is one author's unpublished work served to the next request.
    expect(init?.cache).toBe('no-store')
    expect(init).not.toHaveProperty('next')
  })

  it('turns a 401 into SessionExpiredError so a page can redirect instead of crashing', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondWith(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })

    // The honest gap the spec accepts: middleware cannot help if the token dies between
    // its check and this call, because a Server Component cannot set a cookie. The page
    // needs a distinguishable error to turn into a redirect.
    await expect(listAdminPosts({ page: 0, size: 20 })).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('raises SessionExpiredError when there is no cookie at all, without calling the API', async () => {
    cookieStore.get.mockReturnValue(undefined)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(listAdminPosts({ page: 0, size: 20 })).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // proxy.ts deletes the cookie of a rejected refresh and then lets the Server Action call continue, and
  // the action's cookies() reads the deleted cookie as an entry with no value (measured in proxy.test.ts:
  // `{ name }`, value undefined). That entry, or an empty string, must count as "session ended" just like a missing one:
  // sending `Bearer ` or `Bearer undefined` to the backend would make the error coming back different.
  it('treats a cleared cookie as no session, without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    for (const cleared of [{ name: 'access_token' }, { name: 'access_token', value: '' }]) {
      cookieStore.get.mockReturnValue(cleared)
      await expect(createPost({ title: 't', content: 'c' })).rejects.toBeInstanceOf(SessionExpiredError)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps a 403 as an ApiError, because it is not a session problem', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondWith(403, { error: { code: 'FORBIDDEN', message: 'You do not have permission to do that' } })

    // Redirecting an AUTHOR to login because they lack a role would loop: they log in
    // successfully and are refused again.
    const error = await unpublishPost('11111111-1111-1111-1111-111111111111').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(SessionExpiredError)
    expect(error.code).toBe('FORBIDDEN')
  })

  it('surfaces a validation message so the editor can show it', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondWith(422, { error: { code: 'POST_NOT_PUBLISHABLE', message: 'Post must have a category before publishing' } })

    const error = await createPost({ title: 't', content: 'c' }).catch((e) => e)
    expect(error.code).toBe('POST_NOT_PUBLISHABLE')
    expect(error.message).toBe('Post must have a category before publishing')
  })

  it('the public client sends no authorization header even with a cookie present', async () => {
    cookieStore.get.mockReturnValue({ value: 'the.access.token' })
    const fetchSpy = respondWith(200, { data: [], pagination: { page: 0, size: 10, totalElements: 0, totalPages: 0 } })
    const { getPosts } = await import('./api')

    await getPosts({ page: 0, size: 10 })

    const [, init] = fetchSpy.mock.calls[0]
    // The absence that matters, and it is paired: the test above asserts the SAME
    // token IS sent by the admin client with the same stubbed cookie store, so this is
    // not passing merely because no cookie existed.
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
  })
})

describe('admin-api: multipart, 204 and the new endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    cookieStore.get.mockReset()
  })

  it('does not set content-type for FormData, so fetch writes the multipart boundary itself', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: { id: ID, slug: 's' } })
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'bia.jpg', { type: 'image/jpeg' })

    await uploadPostCover(ID, file, 'Description')

    const call = callOf(fetchSpy)
    // A fixed `content-type: application/json` header overrides the boundary: the backend receives a
    // multipart body without knowing where the parts are separated, and returns 415/400 for EVERY upload.
    expect(call.headers.get('content-type')).toBeNull()
    expect(call.body).toBeInstanceOf(FormData)
    // The "positive" pair of the assert above: building a Request from exactly that init makes fetch generate the
    // multipart header with a boundary. This assert is the one that really goes red if the JSON header comes back.
    const request = new Request(call.url, call.init)
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    // The token still goes along: dropping content-type must not drop the remaining headers.
    expect(call.headers.get('authorization')).toBe('Bearer t')
  })

  it('still sets the JSON content-type when the body is a string', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: { id: ID, slug: 's' } })

    await updatePostCoverAlt(ID, 'New alt')

    // Spring returns 415 for a @RequestBody without a JSON content-type.
    expect(callOf(fetchSpy).headers.get('content-type')).toBe('application/json')
  })

  it('does not set content-type when there is no body', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: { id: ID, slug: 's' } })

    await featurePost(ID)

    expect(callOf(fetchSpy).headers.get('content-type')).toBeNull()
  })

  it('returns null for 204 instead of throwing when reading an empty body', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondFresh(204, null)

    // `res.json()` on an empty body throws SyntaxError: a successful delete would show up as an error in the UI.
    await expect(deleteSeries(ID)).resolves.toBeNull()
    await expect(deleteGalleryPhoto(ID)).resolves.toBeNull()
  })

  it('treats 204 on an endpoint that must have a body as an API error, not as empty data', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondFresh(204, null)

    // Pair of the test above: null is only valid on delete endpoints. On an endpoint that returns a series, a 204
    // that slips out as `undefined` would blow up with a TypeError far from where it was caused.
    const error = await getAdminSeries(ID).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBeGreaterThanOrEqual(500)
  })

  it('still turns an error from the new endpoints into an ApiError carrying the backend code', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondFresh(413, { error: { code: 'MEDIA_TOO_LARGE', message: 'Image is too large' } })
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })

    const error = await uploadGalleryPhoto(file, {}).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('MEDIA_TOO_LARGE')
  })

  it.each([
    [
      'uploadPostCover',
      'POST',
      `/api/v1/admin/posts/${ID}/cover`,
      () => uploadPostCover(ID, new File(['x'], 'a.jpg', { type: 'image/jpeg' })),
    ],
    ['updatePostCoverAlt', 'PUT', `/api/v1/admin/posts/${ID}/cover`, () => updatePostCoverAlt(ID, null)],
    ['deletePostCover', 'DELETE', `/api/v1/admin/posts/${ID}/cover`, () => deletePostCover(ID)],
    ['setFeaturedOrder', 'PUT', '/api/v1/admin/posts/featured-order', () => setFeaturedOrder([ID])],
    ['featurePost', 'POST', `/api/v1/admin/posts/${ID}/feature`, () => featurePost(ID)],
    ['unfeaturePost', 'POST', `/api/v1/admin/posts/${ID}/unfeature`, () => unfeaturePost(ID)],
    ['listAdminSeries', 'GET', '/api/v1/admin/series', () => listAdminSeries()],
    ['createSeries', 'POST', '/api/v1/admin/series', () => createSeries({ title: 'T' })],
    ['getAdminSeries', 'GET', `/api/v1/admin/series/${ID}`, () => getAdminSeries(ID)],
    ['updateSeries', 'PUT', `/api/v1/admin/series/${ID}`, () => updateSeries(ID, { title: 'T' })],
    ['setSeriesPosts', 'PUT', `/api/v1/admin/series/${ID}/posts`, () => setSeriesPosts(ID, [ID])],
    ['deleteSeries', 'DELETE', `/api/v1/admin/series/${ID}`, () => deleteSeries(ID)],
    ['listAdminGallery', 'GET', '/api/v1/admin/gallery', () => listAdminGallery()],
    [
      'uploadGalleryPhoto',
      'POST',
      '/api/v1/admin/gallery',
      () => uploadGalleryPhoto(new File(['x'], 'a.jpg', { type: 'image/jpeg' }), {}),
    ],
    [
      'updateGalleryPhoto',
      'PUT',
      `/api/v1/admin/gallery/${ID}`,
      () => updateGalleryPhoto(ID, { caption: null, altText: 'a', takenOn: null, published: true }),
    ],
    ['deleteGalleryPhoto', 'DELETE', `/api/v1/admin/gallery/${ID}`, () => deleteGalleryPhoto(ID)],
    ['reorderGallery', 'PUT', '/api/v1/admin/gallery/order', () => reorderGallery([ID])],
    ['deletePost', 'DELETE', `/api/v1/admin/posts/${ID}`, () => deletePost(ID)],
    ['updateCategory', 'PUT', `/api/v1/admin/categories/${ID}`, () => updateCategory(ID, { name: 'C', description: null })],
    ['deleteCategory', 'DELETE', `/api/v1/admin/categories/${ID}`, () => deleteCategory(ID)],
    ['renameTag', 'PUT', `/api/v1/admin/tags/${ID}`, () => renameTag(ID, 'T')],
    ['deleteTag', 'DELETE', `/api/v1/admin/tags/${ID}`, () => deleteTag(ID)],
    ['listAdminComments', 'GET', '/api/v1/admin/comments', () => listAdminComments({ status: null, q: '', page: 0, size: 20 })],
    ['setCommentStatus', 'PATCH', `/api/v1/admin/comments/${ID}/status`, () => setCommentStatus(ID, 'HIDDEN')],
    ['deleteAdminComment', 'DELETE', `/api/v1/admin/comments/${ID}`, () => deleteAdminComment(ID)],
    [
      'listAdminUsers',
      'GET',
      '/api/v1/admin/users',
      () => listAdminUsers({ q: '', role: null, status: null, page: 0, size: 20 }),
    ],
    ['setUserStatus', 'PATCH', `/api/v1/admin/users/${ID}/status`, () => setUserStatus(ID, 'SUSPENDED')],
    ['setUserRole', 'PATCH', `/api/v1/admin/users/${ID}/role`, () => setUserRole(ID, 'AUTHOR')],
    [
      'listAuthorApplications',
      'GET',
      '/api/v1/admin/author-applications',
      () => listAuthorApplications({ status: 'PENDING', page: 0, size: 20 }),
    ],
    ['approveAuthorApplication', 'POST', `/api/v1/admin/author-applications/${ID}/approve`, () => approveAuthorApplication(ID)],
    ['rejectAuthorApplication', 'POST', `/api/v1/admin/author-applications/${ID}/reject`, () => rejectAuthorApplication(ID)],
  ] as const)('%s calls %s %s, no cache, with token', async (_name, method, path, run) => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(method === 'DELETE' && !path.endsWith('/cover') ? 204 : 200, { data: [] })

    await run()

    const call = callOf(fetchSpy)
    expect(call.method).toBe(method)
    expect(call.path).toBe(path)
    expect(call.init.cache).toBe('no-store')
    expect(call.headers.get('authorization')).toBe('Bearer t')
  })

  it('puts only a UUID in the path: an id that could change the path is refused before any request', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: {} })

    await expect(getAdminSeries('a/b?c')).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    await expect(getAdminSeries('..')).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    expect(fetchSpy).not.toHaveBeenCalled()

    await getAdminSeries(ID)
    expect(callOf(fetchSpy).path).toBe(`/api/v1/admin/series/${ID}`)
  })

  it('sends the list of ids in the right order and with the field name the backend reads', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: [] })

    await setFeaturedOrder(['b', 'a', 'c'])
    await setSeriesPosts(ID, ['z', 'y'])
    await reorderGallery(['p2', 'p1'])

    expect(JSON.parse(callOf(fetchSpy, 0).body as string)).toEqual({ postIds: ['b', 'a', 'c'] })
    expect(JSON.parse(callOf(fetchSpy, 1).body as string)).toEqual({ postIds: ['z', 'y'] })
    expect(JSON.parse(callOf(fetchSpy, 2).body as string)).toEqual({ photoIds: ['p2', 'p1'] })
  })

  it('cover image: the `file` part is exactly the file, `altText` is only sent when present', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: {} })
    const file = new File([new Uint8Array([0x89, 0x50])], 'bia.png', { type: 'image/png' })

    await uploadPostCover(ID, file, 'Pipeline diagram')
    await uploadPostCover(ID, file)

    const withAlt = callOf(fetchSpy, 0).body as FormData
    expect((withAlt.get('file') as File).name).toBe('bia.png')
    expect((withAlt.get('file') as File).size).toBe(2)
    expect(withAlt.get('altText')).toBe('Pipeline diagram')
    const withoutAlt = callOf(fetchSpy, 1).body as FormData
    expect(withoutAlt.get('file')).not.toBeNull()
    expect(withoutAlt.has('altText')).toBe(false)
  })

  it('changing the cover image description sends JSON altText, null to clear', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: {} })

    await updatePostCoverAlt(ID, msg('Admin.topics.manager.descriptionLabel'))
    await updatePostCoverAlt(ID, null)

    expect(JSON.parse(callOf(fetchSpy, 0).body as string)).toEqual({ altText: msg('Admin.topics.manager.descriptionLabel') })
    expect(JSON.parse(callOf(fetchSpy, 1).body as string)).toEqual({ altText: null })
  })

  it('gallery photo: sends the fields that were filled in, drops blank fields, published becomes a string', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(201, { data: {} })
    const file = new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })

    await uploadGalleryPhoto(file, { caption: 'Sunset Bay', altText: 'Sea', takenOn: '2026-09-14', published: false })
    await uploadGalleryPhoto(file, { caption: '', altText: 'Sea', takenOn: '  ' })

    const full = callOf(fetchSpy, 0).body as FormData
    expect(full.get('file')).toBeInstanceOf(File)
    expect(full.get('caption')).toBe('Sunset Bay')
    expect(full.get('altText')).toBe('Sea')
    expect(full.get('takenOn')).toBe('2026-09-14')
    expect(full.get('published')).toBe('false')
    // Blank means "take the shot date from EXIF", so nothing is sent. The backend also
    // treats an empty `takenOn=` as not sent (GalleryIT); not sending makes that meaning explicit in the request.
    const partial = callOf(fetchSpy, 1).body as FormData
    expect(partial.has('caption')).toBe(false)
    expect(partial.has('takenOn')).toBe(false)
    expect(partial.has('published')).toBe(false)
    expect(partial.get('altText')).toBe('Sea')
  })

  it('series and gallery photo send the right JSON body', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: {} })

    await createSeries({
      title: 'Series A',
      slug: 'series-a',
      description: msg('Admin.topics.manager.descriptionLabel'),
    })
    await updateSeries(ID, { title: 'New name', description: null })
    await updateGalleryPhoto(ID, { caption: 'C', altText: 'A', takenOn: '2026-01-02', published: true })

    expect(JSON.parse(callOf(fetchSpy, 0).body as string)).toEqual({
      title: 'Series A',
      slug: 'series-a',
      description: msg('Admin.topics.manager.descriptionLabel'),
    })
    expect(JSON.parse(callOf(fetchSpy, 1).body as string)).toEqual({ title: 'New name', description: null })
    expect(JSON.parse(callOf(fetchSpy, 2).body as string)).toEqual({
      caption: 'C',
      altText: 'A',
      takenOn: '2026-01-02',
      published: true,
    })
  })

  it('returns the `data` of the envelope', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondFresh(200, { data: [{ id: 's1', title: 'A', slug: 'a', description: null, posts: [] }] })

    await expect(listAdminSeries()).resolves.toEqual([{ id: 's1', title: 'A', slug: 'a', description: null, posts: [] }])
  })
})

describe('admin-api: comment moderation and users', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    cookieStore.get.mockReset()
  })

  const pagination = { page: 2, size: 20, totalElements: 45, totalPages: 3 }

  it('comment list: page, size, status and search box go in the query string; returns items + meta', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: [{ id: 'c1' }], pagination })

    const page = await listAdminComments({ status: 'HIDDEN', q: 'spam & 100%', page: 2, size: 20 })

    const url = new URL(callOf(fetchSpy).url)
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', size: '20', status: 'HIDDEN', q: 'spam & 100%' })
    expect(page).toEqual({ items: [{ id: 'c1' }], meta: pagination })
  })

  it('"all" and an empty search box send no parameter: the backend treats absence as no filter', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: [], pagination: { page: 0, size: 20, totalElements: 0, totalPages: 0 } })

    await listAdminComments({ status: null, q: '', page: 0, size: 20 })
    await listAdminUsers({ q: '', role: null, status: null, page: 0, size: 20 })

    // An empty `status=` is read by Spring as null, but an unknown value is a 400: sending nothing is the safest.
    expect([...new URL(callOf(fetchSpy, 0).url).searchParams.keys()]).toEqual(['page', 'size'])
    expect([...new URL(callOf(fetchSpy, 1).url).searchParams.keys()]).toEqual(['page', 'size'])
  })

  it('user list: search box, role, status with the parameter names the backend reads', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: [{ id: 'u1' }], pagination })

    const page = await listAdminUsers({ q: 'octo', role: 'USER', status: 'SUSPENDED', page: 2, size: 20 })

    const url = new URL(callOf(fetchSpy).url)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      size: '20',
      q: 'octo',
      role: 'USER',
      status: 'SUSPENDED',
    })
    expect(page).toEqual({ items: [{ id: 'u1' }], meta: pagination })
  })

  it('changing status: PATCH with a JSON body containing only `status`, returns the record the backend saved', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: { id: ID, status: 'HIDDEN' } })

    await expect(setCommentStatus(ID, 'HIDDEN')).resolves.toEqual({ id: ID, status: 'HIDDEN' })
    await setCommentStatus(ID, 'VISIBLE')
    await setUserStatus(ID, 'SUSPENDED')
    await setUserStatus(ID, 'ACTIVE')

    // Spring returns 415 for a @RequestBody without a JSON content-type.
    expect(callOf(fetchSpy, 0).headers.get('content-type')).toBe('application/json')
    expect([0, 1, 2, 3].map((n) => JSON.parse(callOf(fetchSpy, n).body as string))).toEqual([
      { status: 'HIDDEN' },
      { status: 'VISIBLE' },
      { status: 'SUSPENDED' },
      { status: 'ACTIVE' },
    ])
  })

  it('author applications: status, page, size go in the query; approve/reject are POST without a body', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: [{ id: 'a1' }], pagination })

    const page = await listAuthorApplications({ status: 'REJECTED', page: 2, size: 20 })
    await approveAuthorApplication(ID)
    await rejectAuthorApplication(ID)

    expect(Object.fromEntries(new URL(callOf(fetchSpy, 0).url).searchParams)).toEqual({
      status: 'REJECTED',
      page: '2',
      size: '20',
    })
    expect(page).toEqual({ items: [{ id: 'a1' }], meta: pagination })
    expect(callOf(fetchSpy, 1).path).toBe(`/api/v1/admin/author-applications/${ID}/approve`)
    for (const n of [1, 2]) {
      expect(callOf(fetchSpy, n).method).toBe('POST')
      expect(callOf(fetchSpy, n).body).toBeUndefined()
    }
  })

  it('changing role: JSON body containing only `role`, returns the record the backend saved', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: { id: ID, role: 'ADMIN' } })

    await expect(setUserRole(ID, 'ADMIN')).resolves.toEqual({ id: ID, role: 'ADMIN' })

    expect(callOf(fetchSpy).headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(callOf(fetchSpy).body as string)).toEqual({ role: 'ADMIN' })
  })

  it('changing role with the administrator code: the code is in the JSON body next to the role (audit 111)', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(200, { data: { id: ID, role: 'ADMIN' } })

    await setUserRole(ID, 'ADMIN', '482913')

    expect(JSON.parse(callOf(fetchSpy).body as string)).toEqual({ role: 'ADMIN', code: '482913' })
  })

  it('approving an application carries the administrator code in the body, and none when there is none', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const withCode = respondFresh(200, { data: { id: ID } })
    await approveAuthorApplication(ID, '482913')
    expect(callOf(withCode).method).toBe('POST')
    expect(JSON.parse(callOf(withCode).body as string)).toEqual({ code: '482913' })
    vi.restoreAllMocks()

    const without = respondFresh(200, { data: { id: ID } })
    await approveAuthorApplication(ID)
    expect(callOf(without).body ?? undefined).toBeUndefined()
  })

  it('deleting a comment: 204 becomes null, DELETE on the comment path', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    const fetchSpy = respondFresh(204, null)

    await expect(deleteAdminComment(ID)).resolves.toBeNull()
    expect(callOf(fetchSpy).method).toBe('DELETE')
    expect(callOf(fetchSpy).path).toBe(`/api/v1/admin/comments/${ID}`)
  })

  it('a backend error is still an ApiError carrying the code, so the action translates it to Vietnamese', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondFresh(409, { error: { code: 'USER_NOT_SUSPENDABLE', message: 'Only reader accounts can be suspended' } })

    const error = await setUserStatus(ID, 'SUSPENDED').catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('USER_NOT_SUSPENDABLE')
  })
})

describe('fetchAdminPostExport (the post as a ZIP package)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    cookieStore.get.mockReset()
  })

  it('returns the raw response, binary body intact, from the export endpoint with the bearer token and no cache', async () => {
    cookieStore.get.mockReturnValue({ value: 'the.access.token' })
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(zip, {
          status: 200,
          headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="a-post.zip"' },
        }),
    )

    const res = await fetchAdminPostExport(ID)

    const call = callOf(fetchSpy)
    expect(call.method).toBe('GET')
    expect(call.path).toBe(`/api/v1/admin/posts/${ID}/export`)
    expect(call.headers.get('authorization')).toBe('Bearer the.access.token')
    // An author's draft: never reuse a cached response.
    expect(call.init.cache).toBe('no-store')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a-post.zip"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(zip)
  })

  it('no cookie: SessionExpiredError without calling the API', async () => {
    cookieStore.get.mockReturnValue(undefined)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(fetchAdminPostExport(ID)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('401 is SessionExpiredError; 403, 404 and 413 stay ApiError with their status', async () => {
    cookieStore.get.mockReturnValue({ value: 't' })
    respondFresh(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
    await expect(fetchAdminPostExport(ID)).rejects.toBeInstanceOf(SessionExpiredError)

    for (const status of [403, 404, 413]) {
      respondFresh(status, { error: { code: 'SOME_CODE', message: 'fixed sentence' } })
      const error = await fetchAdminPostExport(ID).catch((e) => e)
      expect(error).toBeInstanceOf(ApiError)
      expect(error).not.toBeInstanceOf(SessionExpiredError)
      expect(error.status).toBe(status)
    }
  })
})
