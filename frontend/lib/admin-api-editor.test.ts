import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import { ApiError } from './api'
import {
  deletePostImage,
  getPostRevision,
  listPostImages,
  listPostRevisions,
  restorePostRevision,
  uploadPostImage,
} from './admin-api'

/*
 * The editor's admin-api functions, in their own file next to admin-api.test.ts: same fetch mocking,
 * checking exactly the method, path and body that the backend (AdminPostImageController,
 * AdminPostRevisionController) reads.
 */

const ID = '11111111-1111-1111-1111-111111111111'
const MEDIA = {
  id: '22222222-2222-2222-2222-222222222222',
  fileName: '22222222-2222-2222-2222-222222222222.png',
  width: 1200,
  height: 800,
  altText: 'Diagram',
  dominantColor: '#334455',
}

function respond(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
}

function callOf(fetchSpy: ReturnType<typeof respond>) {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  return { method: init.method ?? 'GET', path: new URL(url).pathname, headers: new Headers(init.headers), body: init.body }
}

afterEach(() => {
  vi.restoreAllMocks()
  cookieStore.get.mockReset()
})

describe('admin-api: images in the post body', () => {
  it('uploadPostImage: multipart file + altText, NO hand-written content-type (the boundary would be lost), returns the image', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: MEDIA })
    const file = new File([new Uint8Array([1, 2, 3])], 'so-do.png', { type: 'image/png' })

    const image = await uploadPostImage(ID, file, 'Diagram')

    const call = callOf(fetchSpy)
    expect(call.method).toBe('POST')
    expect(call.path).toBe(`/api/v1/admin/posts/${ID}/images`)
    expect(call.headers.get('content-type')).toBeNull()
    expect(call.headers.get('authorization')).toBe('Bearer tok')
    const body = call.body as FormData
    expect((body.get('file') as File).name).toBe('so-do.png')
    expect(body.get('altText')).toBe('Diagram')
    expect(image).toEqual(MEDIA)
  })

  it('uploadPostImage without a description does not send altText', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: MEDIA })

    await uploadPostImage(ID, new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))

    expect((callOf(fetchSpy).body as FormData).has('altText')).toBe(false)
  })

  it('listPostImages: GET the list', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: [MEDIA] })

    await expect(listPostImages(ID)).resolves.toEqual([MEDIA])
    expect(callOf(fetchSpy)).toMatchObject({ method: 'GET', path: `/api/v1/admin/posts/${ID}/images` })
  })

  it('deletePostImage: DELETE on the image path, returns the remaining images', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: [] })

    await expect(deletePostImage(ID, MEDIA.id)).resolves.toEqual([])
    expect(callOf(fetchSpy)).toMatchObject({ method: 'DELETE', path: `/api/v1/admin/posts/${ID}/images/${MEDIA.id}` })
  })

  it('quota error → ApiError carrying the backend code', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    respond(422, { error: { code: 'MEDIA_QUOTA_EXCEEDED', message: 'Media storage quota exceeded' } })

    await expect(uploadPostImage(ID, new File([new Uint8Array([1])], 'a.png'))).rejects.toMatchObject({
      status: 422,
      code: 'MEDIA_QUOTA_EXCEEDED',
    })
  })

  it('backend without the endpoint: 404 ENDPOINT_NOT_FOUND is an ApiError, not a strange error', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    respond(404, { error: { code: 'ENDPOINT_NOT_FOUND', message: 'The requested endpoint does not exist' } })

    const failure = await listPostImages(ID).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 404, code: 'ENDPOINT_NOT_FOUND' })
  })
})

describe('admin-api: revisions', () => {
  const REVISION = '33333333-3333-3333-3333-333333333333'
  const SUMMARY = { id: REVISION, title: 'Old version', createdAt: '2026-10-09T03:00:00Z' }

  it('listPostRevisions: GET the history', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: [SUMMARY] })

    await expect(listPostRevisions(ID)).resolves.toEqual([SUMMARY])
    expect(callOf(fetchSpy)).toMatchObject({ method: 'GET', path: `/api/v1/admin/posts/${ID}/revisions` })
  })

  it('getPostRevision: GET one revision', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const revision = { ...SUMMARY, excerpt: null, content: 'old text' }
    const fetchSpy = respond(200, { data: revision })

    await expect(getPostRevision(ID, REVISION)).resolves.toEqual(revision)
    expect(callOf(fetchSpy)).toMatchObject({ method: 'GET', path: `/api/v1/admin/posts/${ID}/revisions/${REVISION}` })
  })

  it('restorePostRevision: POST …/restore, returns the post', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: { id: ID, slug: 'bai' } })

    await expect(restorePostRevision(ID, REVISION)).resolves.toEqual({ id: ID, slug: 'bai' })
    expect(callOf(fetchSpy)).toMatchObject({ method: 'POST', path: `/api/v1/admin/posts/${ID}/revisions/${REVISION}/restore` })
  })

  it('REVISION_NOT_FOUND → ApiError 404 carrying the code', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    respond(404, { error: { code: 'REVISION_NOT_FOUND', message: 'Revision not found' } })

    await expect(getPostRevision(ID, REVISION)).rejects.toMatchObject({ status: 404, code: 'REVISION_NOT_FOUND' })
  })
})
