import { afterEach, describe, expect, it, vi } from 'vitest'

const cookieStore = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))

import { ApiError } from './api'
import {
  createCategory,
  createPost,
  createPostTranslation,
  createSeries,
  createTag,
  linkPostTranslation,
  listPostTranslations,
  renameTag,
  unlinkPostTranslation,
  updateCategory,
  updatePost,
} from './admin-api'

/* The translation groups of a post and the per-language texts of categories, tags and series: method, path and body of each call. */

const ID = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

function respond(status: number, body?: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
    )
}

function callOf(fetchSpy: ReturnType<typeof respond>) {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  return { method: init.method ?? 'GET', path: new URL(url).pathname, body: init.body }
}

afterEach(() => {
  vi.restoreAllMocks()
  cookieStore.get.mockReset()
})

describe('admin-api: post translations', () => {
  it('listPostTranslations reads GET /translations and returns the siblings', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const sibling = { id: OTHER, language: 'en', slug: 'hello', title: 'Hello', status: 'DRAFT' }
    const fetchSpy = respond(200, { data: [sibling] })

    expect(await listPostTranslations(ID)).toEqual([sibling])
    expect(callOf(fetchSpy)).toMatchObject({ method: 'GET', path: `/api/v1/admin/posts/${ID}/translations` })
  })

  it('createPostTranslation posts the language and the optional slug', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(201, { data: { id: OTHER } })

    await createPostTranslation(ID, { language: 'en', slug: 'hello' })

    const call = callOf(fetchSpy)
    expect(call).toMatchObject({ method: 'POST', path: `/api/v1/admin/posts/${ID}/translations` })
    expect(JSON.parse(call.body as string)).toEqual({ language: 'en', slug: 'hello' })
  })

  it('createPostTranslation without a slug does not send one', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(201, { data: { id: OTHER } })

    await createPostTranslation(ID, { language: 'en' })

    expect(JSON.parse(callOf(fetchSpy).body as string)).toEqual({ language: 'en' })
  })

  it('linkPostTranslation puts the other id in the path, with no body', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: { id: ID } })

    await linkPostTranslation(ID, OTHER)

    const call = callOf(fetchSpy)
    expect(call).toMatchObject({ method: 'PUT', path: `/api/v1/admin/posts/${ID}/translations/${OTHER}` })
    expect(call.body).toBeUndefined()
  })

  it('unlinkPostTranslation deletes /translations and returns null on 204', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(204)

    expect(await unlinkPostTranslation(ID)).toBeNull()
    expect(callOf(fetchSpy)).toMatchObject({ method: 'DELETE', path: `/api/v1/admin/posts/${ID}/translations` })
  })

  it('a 409 conflict reaches the caller as an ApiError with its code', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    respond(409, { error: { code: 'TRANSLATION_CONFLICT', message: 'already has en' } })

    await expect(createPostTranslation(ID, { language: 'en' })).rejects.toMatchObject({
      status: 409,
      code: 'TRANSLATION_CONFLICT',
    })
    await expect(createPostTranslation(ID, { language: 'en' })).rejects.toBeInstanceOf(ApiError)
  })

  it('createPost and updatePost carry the language', async () => {
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: { id: ID } })
    await createPost({ title: 'T', content: 'c', language: 'en' })
    await updatePost(ID, { title: 'T', content: 'c', language: 'vi' })

    const bodies = fetchSpy.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string))
    expect(bodies[0].language).toBe('en')
    expect(bodies[1].language).toBe('vi')
  })
})

describe('admin-api: taxonomy translations', () => {
  const translations = { en: { name: 'Backend', description: 'Server side' } }

  async function bodyOf(call: () => Promise<unknown>) {
    vi.restoreAllMocks()
    cookieStore.get.mockReturnValue({ value: 'tok' })
    const fetchSpy = respond(200, { data: {} })
    await call()
    return JSON.parse(callOf(fetchSpy).body as string)
  }

  it('updateCategory, createCategory, renameTag, createTag and createSeries send translations when given', async () => {
    expect(await bodyOf(() => updateCategory(ID, { name: 'C', description: null, translations }))).toEqual({
      name: 'C',
      description: null,
      translations,
    })
    expect(await bodyOf(() => createCategory('C', null, translations))).toEqual({ name: 'C', description: null, translations })
    expect(await bodyOf(() => renameTag(ID, 'T', translations))).toEqual({ name: 'T', translations })
    expect(await bodyOf(() => createTag('T', translations))).toEqual({ name: 'T', translations })
    expect(await bodyOf(() => createSeries({ title: 'S', translations }))).toEqual({ title: 'S', translations })
  })

  it('without translations the key is absent, so the backend keeps the stored map', async () => {
    expect(await bodyOf(() => updateCategory(ID, { name: 'C', description: null }))).toEqual({ name: 'C', description: null })
    expect(await bodyOf(() => renameTag(ID, 'T'))).toEqual({ name: 'T' })
    expect(await bodyOf(() => createTag('T'))).toEqual({ name: 'T' })
    expect(await bodyOf(() => createCategory('C'))).toEqual({ name: 'C' })
  })
})
