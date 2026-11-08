// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PostSummary, SeriesAdmin, SeriesRef } from '@/lib/types'
// everyAdminPost moved to ../every-admin-post.ts (shared with "Featured posts"), together with its test.
import { candidatesFor, isSeriesId, toPart } from './series'

const SERIES_ID = '5f0c2a1e-3b4d-4c6e-8f7a-9b0c1d2e3f40'
const OTHER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const ref = (id: string, title: string): SeriesRef => ({
  id,
  slug: `series-${id.slice(0, 4)}`,
  title,
  position: 2,
  partNumber: null,
  partCount: null,
})

const post = (id: string, over: Partial<PostSummary> = {}): PostSummary => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  featured: false,
  readingMinutes: 3,
  publishedAt: '2026-10-03T02:00:00Z',
  series: null,
  ...over,
})

const series = (over: Partial<SeriesAdmin> = {}): SeriesAdmin => ({
  id: SERIES_ID,
  title: 'A test series',
  slug: 'mot-series-thu',
  description: null,
  posts: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

describe('toPart', () => {
  it('keeps exactly the part the screen needs; a part already in this series carries no other series label', () => {
    expect(toPart({ id: 'a', title: 'Post a', slug: 'post-a', status: 'DRAFT', position: 3 })).toEqual({
      id: 'a',
      title: 'Post a',
      status: 'DRAFT',
      otherSeries: null,
    })
  })
})

describe('candidatesFor', () => {
  it('every post not yet in this series, any status, keeps arrival order; a post in another series carries that series name', () => {
    const current = series({ posts: [{ id: 'm', title: 'Post m', slug: 'post-m', status: 'PUBLISHED', position: 1 }] })

    const result = candidatesFor(current, [
      post('moi'),
      post('m', { series: ref(SERIES_ID, 'A test series') }),
      post('nhap', { status: 'DRAFT', publishedAt: null }),
      post('khac', { series: ref(OTHER_ID, 'Neighbor series') }),
    ])

    // Drafts are present (unlike "Featured posts"): a series is planned before its parts are
    // finished, and the public page counts "Part n/m" over the published parts itself.
    expect(result).toEqual([
      { id: 'moi', title: 'Post moi', status: 'PUBLISHED', otherSeries: null },
      { id: 'nhap', title: 'Post nhap', status: 'DRAFT', otherSeries: null },
      { id: 'khac', title: 'Post khac', status: 'PUBLISHED', otherSeries: 'Neighbor series' },
    ])
  })
})

describe('isSeriesId', () => {
  it('accepts only a UUID: any other path at the backend is 400, not 404', () => {
    expect(isSeriesId(SERIES_ID)).toBe(true)
    expect(isSeriesId(SERIES_ID.toUpperCase())).toBe(true)
    expect(isSeriesId('mot-series-thu')).toBe(false)
    expect(isSeriesId(`${SERIES_ID}0`)).toBe(false)
    expect(isSeriesId('')).toBe(false)
  })
})
