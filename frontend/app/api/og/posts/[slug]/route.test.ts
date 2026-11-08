// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareCard } from '@/components/og/ShareCard'
import { NotFoundError, getPost, getPostRedirect } from '@/lib/api'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { ART_INKS, TILE_VIEWBOX, composeCover, coverElements, coverInputOf } from '@/lib/cover-art'
import { forgetMemoizedPng } from '@/lib/png-memo'
import { READ_LIMITS } from '@/lib/read-limit'
import type { MediaRef, Post } from '@/lib/types'
import { GET } from './route'
import { ACCENTED_SLUG_OG } from '@/test/fixtures/vi/apiUnit-routes'

const { site, profile } = defaultSiteContent(DEFAULT_LOCALE)

/**
 * These actually render the PNG. `ImageResponse` runs in-process here, so no browser and no
 * dev server is needed — which matters, because the failure this guards is a Satori throw,
 * and Satori throws for things a type checker cannot see: a node with more than one child
 * and no explicit `display`, an unsupported CSS property, a value it cannot lay out. A
 * source-text assertion would not notice any of them; a 1200x630 PNG coming back proves the
 * whole path ran.
 *
 * What is NOT asserted here is what the card LOOKS like. No test can tell a readable card
 * from an unreadable one, so the layout was verified by rendering the three real cases —
 * the shortest title, a middling one, and the longest Vietnamese title in the corpus — and
 * looking at the images. What these tests pin is that the path keeps working and that the
 * card belongs to the article that was asked for.
 */
vi.mock('@/lib/api', () => ({
  getPost: vi.fn(),
  getPostRedirect: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
}))

// By default there is no old path: a test that needs one sets it itself.
beforeEach(() => {
  vi.mocked(getPostRedirect).mockReset().mockResolvedValue(null)
  // The site-wide card is kept in memory between requests; each test draws it again, so it can read the props the card gets.
  forgetMemoizedPng()
})

// Wrapped rather than replaced: the real card is still drawn into a PNG, and the test can read the props it receives.
vi.mock('@/components/og/ShareCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/og/ShareCard')>()
  return { ...actual, ShareCard: vi.fn(actual.ShareCard) }
})

function post(over: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    title: 'Sample post 05',
    slug: 'sample-post-05-cedar',
    excerpt: 'A short summary.',
    status: 'PUBLISHED',
    category: { id: 'c1', name: 'Architecture', slug: 'kien-truc', description: null },
    tags: [],
    featured: false,
    readingMinutes: 5,
    publishedAt: '2026-10-03T18:23:29Z',
    content: '# x',
    createdAt: '2026-10-03T18:23:29Z',
    updatedAt: '2026-10-04T05:54:39Z',
    ...over,
  }
}

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) })
const get = (slug: string) => GET(new Request(`http://localhost/api/og/posts/${slug}`), ctx(slug))

async function png(slug: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const res = await get(slug)
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') }
}

/** Width and height straight out of the PNG's IHDR chunk, which starts at byte 16. */
function dimensions(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the article share card', () => {
  it('renders a real 1200x630 PNG', async () => {
    vi.mocked(getPost).mockResolvedValue(post())

    const { bytes, contentType: ct } = await png('sample-post-05-cedar')

    expect(ct).toContain('image/png')
    // `summary_large_image` expects this ratio; anything else is letterboxed by every
    // consumer. Read off the image itself, so a card
    // whose element tree disagrees with the declared 1200x630 fails here.
    expect(dimensions(bytes)).toEqual({ width: 1200, height: 630 })
  })

  it('draws the article that was asked for, not a fixed picture', async () => {
    // The failure this catches: a route that ignores `params` and renders the site-wide
    // card for every slug. It passes every other assertion in this file.
    vi.mocked(getPost).mockResolvedValue(post({ title: 'Sample post 05' }))
    const a = (await png('sample-post-05-cedar')).bytes

    vi.mocked(getPost).mockResolvedValue(post({ title: 'Sample post 04' }))
    const b = (await png('sample-post-04')).bytes

    expect(a.equals(b), 'two different articles produced the same card').toBe(false)

    // And the same slug twice gives the same bytes — a card that varied per request would
    // break every cache between here and the reader.
    vi.mocked(getPost).mockResolvedValue(post({ title: 'Sample post 05' }))
    expect((await png('sample-post-05-cedar')).bytes.equals(a)).toBe(true)
  })

  it('asks for the slug the backend stores, not the one in the URL', async () => {
    // Same normalisation as the page and its generateMetadata. A reader can arrive on a
    // decomposed (NFD) spelling of a Vietnamese slug; without this the article would render
    // perfectly and its share card would silently fall back to the site-wide one.
    const NFC = 'be-tac'.normalize('NFC')
    const NFD = ACCENTED_SLUG_OG.normalize('NFD')
    vi.mocked(getPost).mockResolvedValue(post())

    await get(NFD)

    expect(getPost).toHaveBeenCalledWith(NFD.normalize('NFC'))
    expect(NFC).toBeTruthy()
  })

  it('still answers with an image when the post is gone', async () => {
    vi.mocked(getPost).mockRejectedValue(new NotFoundError('NOT_FOUND', 'no'))

    const { bytes, contentType: ct } = await png('khong-ton-tai')

    // NOT a throw. This URL is fetched by crawlers and link unfurlers, never by a reader,
    // so an error here would show up only as a broken preview somewhere else — which is
    // the failure the whole file exists to fix.
    expect(ct).toContain('image/png')
    expect(dimensions(bytes)).toEqual({ width: 1200, height: 630 })
  })

  describe('cover art cell', () => {
    const PREFIX = 'data:image/svg+xml;base64,'
    const SERIES = {
      id: 's1',
      slug: 'series-c',
      title: 'Series C',
      position: 1,
      partNumber: 1,
      partCount: 3,
    }
    const COVER: MediaRef = {
      id: '0b9f6a52-7c43-4e0c-9a51-3f2d1c0e8b7a',
      fileName: '0b9f6a52-7c43-4e0c-9a51-3f2d1c0e8b7a.jpg',
      width: 1600,
      height: 900,
      altText: 'Diagram',
      dominantColor: '#33475b',
    }
    const lastArt = () => vi.mocked(ShareCard).mock.calls.at(-1)?.[0].art

    it('post without a cover image: the card carries the dark square of exactly the cover shown in the list', async () => {
      const article = post({ series: SERIES })
      vi.mocked(getPost).mockResolvedValue(article)
      vi.mocked(ShareCard).mockClear()

      const { bytes } = await png('sample-post-05-cedar')

      // Still a real 1200x630 PNG: Satori can draw an embedded SVG image.
      expect(dimensions(bytes)).toEqual({ width: 1200, height: 630 })
      const art = lastArt()
      expect(art, 'the card did not receive the art cell').toMatch(/^data:image\/svg\+xml;base64,/)

      const svg = Buffer.from(art!.slice(PREFIX.length), 'base64').toString('utf8')
      // The same cover as the thumbnail: same input, so the ink of the series and not of the
      // category, same recipe, same flip direction.
      const spec = composeCover(coverInputOf(article))
      const categoryInk = composeCover(coverInputOf({ ...article, series: null })).ink
      expect(categoryInk, 'fixture must have a series ink different from the category ink').not.toBe(spec.ink)
      expect(svg).toContain(`fill="${ART_INKS[spec.ink].dark.ink}"`)
      expect(svg).not.toContain(`fill="${ART_INKS[categoryInk].dark.ink}"`)
      for (const el of coverElements(spec)) if (el.tag === 'path') expect(svg).toContain(`d="${el.d}"`)
      expect(svg.includes('matrix(-1 0 0 1 480 0)')).toBe(spec.mirror)
      // The square (columns 2-5), a dark palette because the card background is #0a0a0a, colors written directly because Satori has no CSS.
      expect(svg).toContain(`viewBox="${TILE_VIEWBOX}"`)
      expect(svg).not.toContain(ART_INKS[spec.ink].light.ink)
      expect(svg).not.toContain('var(')
      expect(svg).not.toContain('vector-effect')
    })

    it('post with a cover image: text card without an art cell (the og:image of the post is the cover image itself)', async () => {
      vi.mocked(getPost).mockResolvedValue(post({ series: SERIES, cover: COVER }))
      vi.mocked(ShareCard).mockClear()

      const { bytes } = await png('sample-post-05-cedar')

      expect(dimensions(bytes)).toEqual({ width: 1200, height: 630 })
      expect(vi.mocked(ShareCard)).toHaveBeenCalled()
      expect(lastArt()).toBeUndefined()
    })

    it('fallback card (the post could not be loaded) is the site-wide card, with no art cell', async () => {
      vi.mocked(getPost).mockRejectedValue(new NotFoundError('NOT_FOUND', 'no'))
      vi.mocked(ShareCard).mockClear()

      await png('khong-ton-tai')

      expect(vi.mocked(ShareCard)).toHaveBeenCalled()
      expect(lastArt()).toBeUndefined()
    })
  })

  describe('old path of a post whose slug changed', () => {
    const lastTitle = () => vi.mocked(ShareCard).mock.calls.at(-1)?.[0].title

    it('draws the card of the post that the old path now points to, not the site-wide card', async () => {
      // The page of the old path redirects with 308; a preview still holding the old image link
      // deserves to see exactly that post.
      vi.mocked(getPost).mockImplementation(async (slug) => {
        if (slug === 'duong-dan-moi') return post({ slug, title: 'Title after the slug change' })
        throw new NotFoundError('POST_NOT_FOUND', 'no')
      })
      vi.mocked(getPostRedirect).mockResolvedValue('duong-dan-moi')
      vi.mocked(ShareCard).mockClear()

      const { bytes } = await png('duong-dan-cu')

      expect(dimensions(bytes)).toEqual({ width: 1200, height: 630 })
      expect(getPostRedirect).toHaveBeenCalledWith('duong-dan-cu')
      expect(getPost).toHaveBeenCalledWith('duong-dan-moi')
      expect(lastTitle()).toBe('Title after the slug change')
    })

    it('no target, a target equal to the asked slug, or a failed lookup: site-wide card, no throw', async () => {
      vi.mocked(getPost).mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no'))

      for (const lookup of [
        () => vi.mocked(getPostRedirect).mockResolvedValue(null),
        () => vi.mocked(getPostRedirect).mockResolvedValue('duong-dan-cu'),
        () => vi.mocked(getPostRedirect).mockRejectedValue(new Error('backend down')),
      ]) {
        lookup()
        vi.mocked(getPost).mockClear()
        vi.mocked(ShareCard).mockClear()
        // The site-wide card is drawn once and kept: forget it so that each case draws it and the props can be read.
        forgetMemoizedPng()

        const { bytes } = await png('duong-dan-cu')

        expect(dimensions(bytes)).toEqual({ width: 1200, height: 630 })
        expect(lastTitle()).toBe(site.name)
        // Do not ask again for the slug that just 404ed: a target equal to it is not a different post.
        expect(getPost).toHaveBeenCalledTimes(1)
      }
    })

    it('error other than 404: no old path lookup', async () => {
      vi.mocked(getPost).mockRejectedValue(new Error('503 from the API'))

      await png('sample-post-05-cedar')

      expect(getPostRedirect).not.toHaveBeenCalled()
    })
  })

  it('card footer is the real author of the post; a post by the site owner is still profile.name', async () => {
    const lastFooter = () => vi.mocked(ShareCard).mock.calls.at(-1)?.[0].footer
    const other = { displayName: 'Beth Walker', githubLogin: 'tranthibich', avatarUrl: null, siteOwner: false }

    vi.mocked(getPost).mockResolvedValue(post({ author: other }))
    await png('sample-post-05-cedar')
    expect(lastFooter()).toBe('Beth Walker')

    vi.mocked(getPost).mockResolvedValue(post({ author: { ...other, displayName: 'admin', siteOwner: true } }))
    await png('sample-post-05-cedar')
    expect(lastFooter()).toBe(profile.name)
  })
})

/**
 * The card is the most expensive anonymous read of the site (Satori and resvg draw a 1200x630 PNG), and the address is the caller's
 * (audit issue 18). The allowance is per address, a value no post can have never reaches the backend, and every address that is not a
 * post gets one picture, drawn once.
 */
describe('the share card as an expensive anonymous read', () => {
  const asked = (slug: string, ip?: string) =>
    GET(new Request(`http://localhost/api/og/posts/${slug}`, ip ? { headers: { 'x-forwarded-for': ip } } : undefined), ctx(slug))

  it('one address may ask 60 times a minute; the next is a 429 with Retry-After and costs the backend nothing', async () => {
    vi.mocked(getPost).mockReset().mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no'))
    for (let i = 0; i < READ_LIMITS.og.limit; i++) expect((await asked('a-slug', '203.0.113.201')).status).toBe(200)
    vi.mocked(getPost).mockClear()

    const refused = await asked('a-slug', '203.0.113.201')

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(getPost).not.toHaveBeenCalled()
    expect((await asked('a-slug', '203.0.113.202')).status).toBe(200)
  }, 60_000)

  it('draws the site-wide card once for any number of addresses that are not a post', async () => {
    vi.mocked(getPost).mockReset().mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no'))
    vi.mocked(ShareCard).mockClear()

    const first = await png('made-up-one')
    const second = await png('made-up-two')

    expect(vi.mocked(ShareCard)).toHaveBeenCalledTimes(1)
    expect(second.bytes.equals(first.bytes)).toBe(true)
    expect(first.contentType).toBe('image/png')
    expect(first.bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('may be cached for five minutes, no longer: a post may be published at that address later', async () => {
    vi.mocked(getPost).mockReset().mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no'))

    const res = await get('made-up-three')

    expect(res.headers.get('cache-control')).toBe('public, max-age=300, no-transform')
  })

  it.each([
    ['a slash', 'a%2Fb'],
    ['a backslash', 'a%5Cb'],
    ['a control character', 'a%00b'],
    ['more than 255 characters', 'x'.repeat(256)],
  ])('an address with %s is answered with the site-wide card and never reaches the backend', async (_name, slug) => {
    vi.mocked(getPost).mockReset().mockResolvedValue(post())

    const res = await get(slug)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(getPost).not.toHaveBeenCalled()
    expect(getPostRedirect).not.toHaveBeenCalled()
  })

  it('redraws the site-wide card when the text on it changes', async () => {
    vi.mocked(getPost).mockReset().mockRejectedValue(new NotFoundError('POST_NOT_FOUND', 'no'))
    vi.mocked(ShareCard).mockClear()
    await png('made-up-four')

    // Another version of the site content: the key of the memo changes.
    const { getDefaultSiteContent } = await import('@/lib/site-content')
    vi.spyOn(await import('@/lib/site-content'), 'getDefaultSiteContent').mockResolvedValueOnce({
      ...(await getDefaultSiteContent()),
      site: { ...site, name: 'Another name' },
    })
    await png('made-up-five')

    expect(vi.mocked(ShareCard)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(ShareCard).mock.calls.at(-1)?.[0].title).toBe('Another name')
  })
})
