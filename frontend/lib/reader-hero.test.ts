import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import type { Adjacent, SeriesNeighbours } from '@/components/site/PostNav'
import { TEST_LOCALE } from '@/test/intl'
import { authorIdentity, heroSeries, nextReading, partBadge } from './reader-hero'
import type { LeftRailModel } from './reader-rail'
import type { PostAuthor, PostSummary, SeriesRef } from './types'

const post = (slug: string): PostSummary => ({
  id: slug,
  title: `Title of ${slug}`,
  slug,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: '2026-09-01T00:00:00Z',
  featured: false,
  readingMinutes: 4,
})

const NO_ADJACENT: Adjacent = { previous: null, next: null }
const series = (previous: string | null, next: string | null): SeriesNeighbours => ({
  title: 'A series',
  previous: previous ? post(previous) : null,
  next: next ? post(next) : null,
})

describe('nextReading', () => {
  it('follows the next part of the series', () => {
    const result = nextReading({ series: series('p1', 'p3'), adjacent: { previous: post('older'), next: post('newer') } })
    expect(result?.kind).toBe('part')
    expect(result?.post.slug).toBe('p3')
  })

  it('is null at the last part: it does not fall back to time', () => {
    expect(nextReading({ series: series('p1', null), adjacent: { previous: post('older'), next: post('newer') } })).toBeNull()
  })

  it('goes to the next part from the first part, whatever the adjacent post is', () => {
    expect(nextReading({ series: series(null, 'p2'), adjacent: { previous: null, next: post('newer') } })?.post.slug).toBe('p2')
  })

  it('falls back to the adjacent next post when the series has no usable neighbour', () => {
    const result = nextReading({ series: series(null, null), adjacent: { previous: null, next: post('newer') } })
    expect(result?.kind).toBe('post')
    expect(result?.post.slug).toBe('newer')
  })

  it('uses the adjacent next post for a post that is in no series', () => {
    expect(nextReading({ series: null, adjacent: { previous: null, next: post('newer') } })).toEqual({
      kind: 'post',
      post: post('newer'),
    })
  })

  it('is null when there is nothing after the post', () => {
    expect(nextReading({ series: null, adjacent: NO_ADJACENT })).toBeNull()
    expect(nextReading({ series: series(null, null), adjacent: { previous: post('older'), next: null } })).toBeNull()
  })
})

describe('authorIdentity', () => {
  const profile = { ...defaultSiteContent(TEST_LOCALE).profile, name: 'Site Owner', avatar: null }
  const GITHUB = 'https://avatars.githubusercontent.com/u/1?v=4'
  const owner = (extra: Partial<PostAuthor> = {}): PostAuthor => ({
    displayName: 'Ignored Name',
    githubLogin: 'owner',
    avatarUrl: null,
    siteOwner: true,
    ...extra,
  })
  const other = (extra: Partial<PostAuthor> = {}): PostAuthor => ({
    displayName: 'Mary Example',
    githubLogin: 'mary',
    avatarUrl: GITHUB,
    siteOwner: false,
    profileSlug: 'mary-example',
    ...extra,
  })

  it('the owner: the profile name, /about, and the profile avatar first', () => {
    const result = authorIdentity(owner({ avatarUrl: GITHUB }), { ...profile, avatar: '/media/me.jpg' })
    expect(result).toEqual({ name: 'Site Owner', avatar: { kind: 'image', src: '/media/me.jpg' }, href: '/about' })
  })

  it('the owner without a profile avatar: the GitHub picture of the linked account', () => {
    expect(authorIdentity(owner({ avatarUrl: GITHUB }), profile).avatar).toEqual({ kind: 'github', src: GITHUB })
  })

  it('the owner with no picture at all: no avatar (no fake face), the name still links to /about', () => {
    expect(authorIdentity(owner(), profile)).toEqual({ name: 'Site Owner', avatar: null, href: '/about' })
  })

  it('the owner: a picture from a foreign host is not used', () => {
    expect(authorIdentity(owner({ avatarUrl: 'https://tracker.example/x.png' }), profile).avatar).toBeNull()
  })

  it('an old backend that sends no author is the site owner', () => {
    expect(authorIdentity(undefined, profile)).toEqual({ name: 'Site Owner', avatar: null, href: '/about' })
  })

  it('another author with a slug: display name, GitHub picture, /u/<slug>', () => {
    expect(authorIdentity(other(), profile)).toEqual({
      name: 'Mary Example',
      avatar: { kind: 'github', src: GITHUB },
      href: '/u/mary-example',
    })
  })

  it('another author without a slug: plain text (no link)', () => {
    expect(authorIdentity(other({ profileSlug: null }), profile).href).toBeNull()
    expect(authorIdentity(other({ profileSlug: undefined }), profile).href).toBeNull()
  })

  it('another author without a picture: an empty src, which Avatar draws as an initial letter', () => {
    expect(authorIdentity(other({ avatarUrl: null }), profile).avatar).toEqual({ kind: 'github', src: '' })
  })
})

describe('heroSeries', () => {
  const ref: SeriesRef = { id: 's', slug: 'ref-slug', title: 'Ref title', position: 9, partNumber: null, partCount: null }
  const primary: LeftRailModel['primary'] = {
    kind: 'series',
    slug: 'rail-slug',
    title: 'Rail title',
    current: 3,
    total: 7,
    rows: [],
    parts: [],
    windowed: false,
  }

  it('a loaded series gives title, slug and the position among the published parts', () => {
    expect(heroSeries(primary, ref)).toEqual({ title: 'Rail title', slug: 'rail-slug', badge: { current: 3, total: 7 } })
  })

  it('a series that failed to load falls back to the post reference, without a badge', () => {
    expect(heroSeries(null, ref)).toEqual({ title: 'Ref title', slug: 'ref-slug', badge: null })
    expect(heroSeries({ kind: 'latest', posts: [] }, ref)).toEqual({ title: 'Ref title', slug: 'ref-slug', badge: null })
  })

  it('a post in no series has none', () => {
    expect(heroSeries(null, null)).toBeNull()
    expect(heroSeries(null, undefined)).toBeNull()
  })
})

describe('partBadge', () => {
  it('pads both numbers to two digits', () => {
    expect(partBadge(3, 7)).toBe('03 / 07')
    expect(partBadge(12, 20)).toBe('12 / 20')
  })

  it('does not cut a wider number', () => {
    expect(partBadge(7, 120)).toBe('07 / 120')
  })
})
