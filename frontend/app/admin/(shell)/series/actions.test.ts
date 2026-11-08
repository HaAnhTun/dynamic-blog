// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same mould as curated/actions.test.ts: spies via vi.hoisted, SessionExpiredError is a subclass
// of the real ApiError, the real runAdminAction.
const { createSeries, updateSeries, setSeriesPosts, deleteSeries, redirect } = vi.hoisted(() => ({
  createSeries: vi.fn(),
  updateSeries: vi.fn(),
  setSeriesPosts: vi.fn(),
  deleteSeries: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;push;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-api', async () => {
  const actual = await import('@/lib/api')
  return {
    createSeries,
    updateSeries,
    setSeriesPosts,
    deleteSeries,
    SessionExpiredError: class SessionExpiredError extends actual.ApiError {
      constructor() {
        super(401, 'UNAUTHENTICATED', 'expired')
      }
    },
  }
})
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidateTag: vi.fn(), revalidatePath: vi.fn() }))

import { updateTag } from 'next/cache'
import { ApiError } from '@/lib/api'
import { SessionExpiredError } from '@/lib/admin-api'
import type { SeriesAdmin } from '@/lib/types'
import { addSeries, removeSeries, saveSeries, saveSeriesParts } from './actions'
import { msg } from '@/test/render-intl'

const ID = '5f0c2a1e-3b4d-4c6e-8f7a-9b0c1d2e3f40'

const saved = (over: Partial<SeriesAdmin> = {}): SeriesAdmin => ({
  id: ID,
  title: 'A test series',
  slug: 'mot-series-thu',
  description: null,
  posts: [],
  createdAt: '2026-10-06T01:00:00Z',
  updatedAt: '2026-10-06T01:00:00Z',
  ...over,
})

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.append(name, value)
  return data
}

/**
 * Three tags for every series write: the series page, the kicker/series block on
 * every post, and the same kicker on the search result rows.
 */
function expectSeriesAndPostsInvalidated() {
  expect(updateTag).toHaveBeenCalledWith('series')
  expect(updateTag).toHaveBeenCalledWith('posts')
  expect(updateTag).toHaveBeenCalledWith('search')
  expect(updateTag).toHaveBeenCalledTimes(3)
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('addSeries', () => {
  it('after creating → clears the "series" + "posts" cache then redirects to the edit page of the new series', async () => {
    createSeries.mockResolvedValue(saved())

    await expect(
      addSeries(form({ title: '  A test series ', slug: '', description: 'A few introduction lines.' })),
    ).rejects.toThrow('NEXT_REDIRECT')

    // An empty slug is not sent: the backend generates it from the name. The description is sent verbatim, the backend trims it.
    expect(createSeries).toHaveBeenCalledWith({ title: 'A test series', description: 'A few introduction lines.' })
    expect(redirect).toHaveBeenCalledWith(`/admin/series/${ID}`)
    expectSeriesAndPostsInvalidated()
  })

  it('a typed slug is sent along', async () => {
    createSeries.mockResolvedValue(saved())

    await expect(addSeries(form({ title: 'A test series', slug: 'series-rieng', description: '' }))).rejects.toThrow(
      'NEXT_REDIRECT',
    )

    expect(createSeries).toHaveBeenCalledWith({ title: 'A test series', slug: 'series-rieng', description: '' })
  })

  it('the name is required: an empty or whitespace-only name → {error}, no backend call', async () => {
    await expect(addSeries(form({ title: '   ', slug: '', description: '' }))).resolves.toEqual({
      error: msg('Admin.series.titleRequired'),
    })
    await expect(addSeries(new FormData())).resolves.toEqual({ error: msg('Admin.series.titleRequired') })

    expect(createSeries).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('duplicate name (409 SERIES_ALREADY_EXISTS) → a localized message, no redirect, no cache clearing', async () => {
    createSeries.mockRejectedValue(new ApiError(409, 'SERIES_ALREADY_EXISTS', "Series 'A test series' already exists"))

    await expect(addSeries(form({ title: 'A test series' }))).resolves.toEqual({
      error: msg('Errors.admin.codes.SERIES_ALREADY_EXISTS'),
    })

    expect(redirect).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → the login page', async () => {
    createSeries.mockRejectedValue(new SessionExpiredError())

    await expect(addSeries(form({ title: 'A test series' }))).rejects.toThrow('NEXT_REDIRECT')

    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('saveSeries', () => {
  it('sends name, slug, description; clears the cache; returns exactly the values the backend stored (normalised)', async () => {
    updateSeries.mockResolvedValue(saved({ title: 'New name', slug: 'new-name', description: null }))

    const result = await saveSeries(ID, form({ title: 'New name', slug: 'New Name', description: '   ' }))

    expect(updateSeries).toHaveBeenCalledWith(ID, { title: 'New name', slug: 'New Name', description: '   ' })
    expectSeriesAndPostsInvalidated()
    expect(result).toEqual({ title: 'New name', slug: 'new-name', description: null })
  })

  it('an empty slug is not sent: the backend keeps the old slug instead of regenerating from the name', async () => {
    updateSeries.mockResolvedValue(saved())

    await saveSeries(ID, form({ title: 'A test series', slug: ' ', description: '' }))

    expect(updateSeries).toHaveBeenCalledWith(ID, { title: 'A test series', description: '' })
  })

  it('empty name → {error}, no backend call; duplicate name → a localized message', async () => {
    await expect(saveSeries(ID, form({ title: '' }))).resolves.toEqual({ error: msg('Admin.series.titleRequired') })
    expect(updateSeries).not.toHaveBeenCalled()

    updateSeries.mockRejectedValue(new ApiError(409, 'SERIES_ALREADY_EXISTS', 'exists'))
    await expect(saveSeries(ID, form({ title: 'Duplicate' }))).resolves.toEqual({
      error: msg('Errors.admin.codes.SERIES_ALREADY_EXISTS'),
    })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → the login page', async () => {
    updateSeries.mockRejectedValue(new SessionExpiredError())

    await expect(saveSeries(ID, form({ title: 'A test series' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})

describe('saveSeriesParts', () => {
  it('sends the exact id array in order, clears the cache, returns the parts the backend stored in slim form', async () => {
    setSeriesPosts.mockResolvedValue(
      saved({
        posts: [
          { id: 'b', title: 'Post b', slug: 'post-b', status: 'PUBLISHED', position: 1 },
          { id: 'a', title: 'Post a', slug: 'post-a', status: 'DRAFT', position: 2 },
        ],
      }),
    )

    const result = await saveSeriesParts(ID, ['b', 'a'])

    expect(setSeriesPosts).toHaveBeenCalledWith(ID, ['b', 'a'])
    expectSeriesAndPostsInvalidated()
    expect(result).toEqual([
      { id: 'b', title: 'Post b', status: 'PUBLISHED', otherSeries: null },
      { id: 'a', title: 'Post a', status: 'DRAFT', otherSeries: null },
    ])
  })

  it('400 (a post just deleted in another tab: POST_NOT_FOUND) → tells to reload the page', async () => {
    setSeriesPosts.mockRejectedValue(new ApiError(400, 'POST_NOT_FOUND', 'Post not found: 6f1c…'))

    await expect(saveSeriesParts(ID, ['a', 'xoa-roi'])).resolves.toEqual({
      error: msg('Errors.admin.staleList'),
    })
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR (duplicate ids in the list: broken screen state) → also tells to reload the page', async () => {
    setSeriesPosts.mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'postIds must not contain duplicates'))

    await expect(saveSeriesParts(ID, ['a', 'a'])).resolves.toEqual({
      error: msg('Errors.admin.staleList'),
    })
  })

  it('series already deleted (404) → says the exact reason, does not say reload (reloading is a 404 page)', async () => {
    setSeriesPosts.mockRejectedValue(new ApiError(404, 'SERIES_NOT_FOUND', `Series not found: ${ID}`))

    await expect(saveSeriesParts(ID, ['a'])).resolves.toEqual({
      error: msg('Errors.admin.codes.SERIES_NOT_FOUND'),
    })
  })

  it('session expired → the login page, no cache clearing', async () => {
    setSeriesPosts.mockRejectedValue(new SessionExpiredError())

    await expect(saveSeriesParts(ID, ['a'])).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
    expect(updateTag).not.toHaveBeenCalled()
  })
})

describe('removeSeries', () => {
  it('after deleting → clears the cache then goes to the series list', async () => {
    deleteSeries.mockResolvedValue(null)

    await expect(removeSeries(ID)).rejects.toThrow('NEXT_REDIRECT')

    expect(deleteSeries).toHaveBeenCalledWith(ID)
    // Before redirect: redirect() throws, so an updateTag placed after it never runs.
    expectSeriesAndPostsInvalidated()
    expect(redirect).toHaveBeenCalledWith('/admin/series')
  })

  it('error (series already deleted in another tab) → {error} in place, no redirect, no cache clearing', async () => {
    deleteSeries.mockRejectedValue(new ApiError(404, 'SERIES_NOT_FOUND', `Series not found: ${ID}`))

    await expect(removeSeries(ID)).resolves.toEqual({ error: msg('Errors.admin.codes.SERIES_NOT_FOUND') })
    expect(redirect).not.toHaveBeenCalled()
    expect(updateTag).not.toHaveBeenCalled()
  })

  it('session expired → the login page, not the series list', async () => {
    deleteSeries.mockRejectedValue(new SessionExpiredError())

    await expect(removeSeries(ID)).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})
