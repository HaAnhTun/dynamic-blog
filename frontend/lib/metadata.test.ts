// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { coverOgImage, feedTitle, pageMetadata, postCardOgImage, siteOgImage } from '@/lib/metadata'
import { FEED_PATH, OG_IMAGE, categoryFeedPath } from '@/lib/site'
import { routeMap } from '@/test/routes'
import { msg } from '@/test/render-intl'
import { SLUG_BE_TAC } from '@/test/fixtures/vi/accented-text'

const { site } = defaultSiteContent('vi')

describe('pageMetadata per locale', () => {
  const base = { title: msg('Site.footer.links.writing'), description: 'x', canonical: '/writing?page=1' }

  it('the default locale keeps the unprefixed canonical and declares both languages plus x-default', async () => {
    const meta = await pageMetadata(base)
    expect(meta.alternates?.canonical).toBe('/writing?page=1')
    expect(meta.alternates?.languages).toEqual({
      vi: '/writing?page=1',
      en: '/en/writing?page=1',
      'x-default': '/writing?page=1',
    })
    expect(meta.openGraph).toMatchObject({ locale: 'vi_VN' })
  })

  it('the other locale is self-canonical, og:url follows it, and the feed link is that locale feed', async () => {
    const meta = await pageMetadata({ ...base, locale: 'en', feed: { path: categoryFeedPath('a'), title: 'A' } })
    expect(meta.alternates?.canonical).toBe('/en/writing?page=1')
    expect(meta.openGraph?.url).toBe('/en/writing?page=1')
    expect(meta.alternates?.languages).toMatchObject({ vi: '/writing?page=1', en: '/en/writing?page=1' })
    expect(meta.openGraph).toMatchObject({ locale: 'en_US' })
    expect(meta.alternates?.types).toEqual({
      'application/rss+xml': [
        { url: '/en/feed.xml', title: await feedTitle('en') },
        { url: '/en/categories/a/feed.xml', title: 'A' },
      ],
    })
  })

  it('the home page is /en under the other locale', async () => {
    expect((await pageMetadata({ title: 'x', canonical: '/', locale: 'en' })).alternates?.canonical).toBe('/en')
  })

  it('a page of content in the default language canonicalizes to its own URL under any locale and declares no alternates', async () => {
    const meta = await pageMetadata({ title: 'x', canonical: '/posts/a', locale: 'en', contentLanguage: 'vi' })
    expect(meta.alternates?.canonical).toBe('/posts/a')
    expect(meta.openGraph?.url).toBe('/posts/a')
    expect(meta.openGraph).toMatchObject({ locale: 'vi_VN' })
    expect(meta.alternates).not.toHaveProperty('languages')
  })

  it('a page of English content canonicalizes to the /en URL, has the English og:locale and the given hreflang map', async () => {
    const languages = { vi: '/posts/b', en: '/en/posts/a', 'x-default': '/posts/b' }
    const meta = await pageMetadata({ title: 'x', canonical: '/posts/a', locale: 'vi', contentLanguage: 'en', languages })
    expect(meta.alternates?.canonical).toBe('/en/posts/a')
    expect(meta.openGraph?.url).toBe('/en/posts/a')
    expect(meta.openGraph).toMatchObject({ locale: 'en_US' })
    expect(meta.alternates?.languages).toEqual(languages)
  })
})

/**
 * The defect these guard, in one line: five public routes were telling Facebook, Zalo and
 * LinkedIn that they were the homepage, and the two that were not were shipping a card with
 * no locale and no site name.
 *
 * Nothing here asserts a character count. The acceptance criteria are relational —
 * `og:url` equals the canonical, `og:title` is the page's own title — so they stay true
 * whatever the copy says, and they fail the moment the relationship breaks.
 */
describe('pageMetadata', () => {
  it('makes og:url the canonical URL, including the cases where the two could disagree', async () => {
    // The three routes whose canonical rule differs, which is the whole reason the helper
    // takes a decided canonical rather than deriving one.

    // /writing?page=1 — the page number is carried, not collapsed to page one.
    const paged = await pageMetadata({ title: msg('Site.footer.links.writing'), description: 'x', canonical: '/writing?page=1' })
    expect(paged.openGraph?.url).toBe(paged.alternates?.canonical)
    expect(paged.openGraph?.url).toBe('/writing?page=1')

    // /search?q=queue — the title is query-specific, the canonical is NOT. A helper that
    // derived og:url from the request would get this one wrong in the opposite direction.
    const searched = await pageMetadata({
      title: msg('Site.search.meta.titleWithQuery', { query: 'queue' }),
      description: 'x',
      canonical: '/search',
    })
    expect(searched.openGraph?.url).toBe('/search')
    expect(searched.openGraph?.title).toBe(msg('Site.search.meta.titleWithQuery', { query: 'queue' }))

    // The homepage, where the canonical is the bare root.
    const home = await pageMetadata({ title: { absolute: 'A · B' }, canonical: '/' })
    expect(home.openGraph?.url).toBe(home.alternates?.canonical)
  })

  it('carries the locale, the site name and the share image on every page', async () => {
    const m = await pageMetadata({ title: msg('Site.footer.links.writing'), description: 'x', canonical: '/writing' })

    // The half of the defect that failed the other way: /about and /posts/[slug] wrote their own
    // openGraph block and were measured emitting NO og:locale and NO og:site_name, because
    // a segment's openGraph replaces the inherited object whole rather than merging into it.
    expect(m.openGraph?.locale).toBe('vi_VN')
    expect(m.openGraph?.siteName).toBe(site.name)
    expect(m.openGraph?.images).toEqual([await siteOgImage('vi')])
  })

  it('the shared card carries width/height/alt, like the card of each post', async () => {
    // The earlier version was just the OG_IMAGE string: /, /writing, /start-here, /series… emitted og:image without
    // og:image:width/height/alt. Facebook needs the size pair to draw the image on the very first share.
    expect(await siteOgImage('vi')).toEqual({
      url: OG_IMAGE,
      width: 1200,
      height: 630,
      alt: `${site.name} — ${site.tagline}`,
    })
  })

  it('advertises the feed from every page rather than from the root layout', async () => {
    // `alternates` is replaced, not merged, and every public page states its own canonical
    // — so a `types` declared once on app/layout.tsx would be dropped by all of them and
    // survive only on /admin and the 404. Measured before this: no page emitted a
    // rel=alternate at all, and /feed.xml, /rss.xml, /feed and /atom.xml all 404'd.
    const m = await pageMetadata({ title: msg('Site.footer.links.writing'), canonical: '/writing' })

    expect(m.alternates?.types).toEqual({ 'application/rss+xml': FEED_PATH })
    expect(m.alternates?.canonical).toBe('/writing')
  })

  it('a page with its own feed advertises both feeds, the shared feed first, one title per feed', async () => {
    // Next replaces the whole `alternates` block, so the shared feed must be restated next to the own feed, or it is lost.
    const m = await pageMetadata({
      title: msg('Site.taxonomy.categoryTitle', { name: 'Architecture' }),
      canonical: '/categories/kien-truc?page=1',
      feed: { path: categoryFeedPath('kien-truc'), title: await feedTitle('vi', 'Architecture') },
    })

    expect(m.alternates?.types).toEqual({
      'application/rss+xml': [
        { url: FEED_PATH, title: site.name },
        { url: '/categories/kien-truc/feed.xml', title: `Architecture — ${site.name}` },
      ],
    })
    expect(m.alternates?.canonical).toBe('/categories/kien-truc?page=1')
  })

  it('titles the share card with the page, not the site', async () => {
    // A plain title goes through app/layout.tsx's `%s — <site name>` template for the
    // document title, but og:title must be the bare page title — which is what /about and
    // the article page already emitted before this helper existed.
    expect((await pageMetadata({ title: msg('Site.footer.links.about'), canonical: '/about' })).openGraph?.title).toBe(
      msg('Site.footer.links.about'),
    )
    expect((await pageMetadata({ title: msg('Site.footer.links.about'), canonical: '/about' })).twitter?.title).toBe(
      msg('Site.footer.links.about'),
    )

    // `{ absolute }` opts out of the template; og:title takes the same final string.
    const home = await pageMetadata({ title: { absolute: 'A · B' }, canonical: '/' })
    expect(home.openGraph?.title).toBe('A · B')
    expect(home.twitter?.title).toBe('A · B')
  })

  it('lets an article keep its type and timestamps', async () => {
    const m = await pageMetadata({
      title: 'Post',
      description: 'x',
      canonical: '/posts/bai',
      og: { type: 'article', publishedTime: '2026-01-01T00:00:00Z', modifiedTime: '2026-02-02T00:00:00Z' },
    })

    // The helper's own `type: 'website'` default must lose to the caller's, and its
    // trailing title/url/description writes must not clobber what `...og` contributed.
    // Mutation that proves this is not vacuous: move `...og` after `url` in lib/metadata.ts
    // and the first expectation fails.
    // Via toMatchObject rather than `m.openGraph?.type`: Next's `OpenGraph` is a union
    // and `type` is not a property of every member, so the direct read does not typecheck.
    expect(m.openGraph).toMatchObject({
      type: 'article',
      publishedTime: '2026-01-01T00:00:00Z',
      modifiedTime: '2026-02-02T00:00:00Z',
    })
    expect(m.openGraph?.url).toBe('/posts/bai')
    expect(m.openGraph?.title).toBe('Post')
  })

  it('never decides robots, so it cannot make the bare /search noindex', async () => {
    // `in`, not toBeUndefined(): Next's merge visits whatever keys are present, so a
    // present-but-undefined `robots` is a REPLACE rather than an omission. The bare /search
    // depends on there being no key at all.
    expect('robots' in (await pageMetadata({ title: msg('Site.search.heading'), canonical: '/search' }))).toBe(false)
  })

  it('always sets the description key, even when there is no description', async () => {
    // This is the one that looks like a style nit and is not. Read out of Next's source:
    // resolve-metadata.js:244 is `case 'description': metadata[key] ?? null`, so a
    // present-but-undefined key resolves to null and metadata.js:261 (`if
    // (metadata.description)`) emits no tag — the behaviour an article with no excerpt
    // wants. An ABSENT key is never visited by the `for (const key_ in metadata)` loop, so
    // the ROOT's description survives and inheritFromMetadata copies it into og and twitter
    // as well: a post without an excerpt would advertise the homepage's positioning line as
    // its own description, on all three tags, and `metadata.description` would still read
    // as undefined so nothing would notice.
    const m = await pageMetadata({ title: 'Post', canonical: '/posts/bai' })

    expect('description' in m).toBe(true)
    expect(m.description).toBeUndefined()
    expect('description' in (m.openGraph ?? {})).toBe(true)
    expect(m.openGraph?.description).toBeUndefined()
    expect('description' in (m.twitter ?? {})).toBe(true)
    expect(m.twitter?.description).toBeUndefined()
  })

  it('omits the images key entirely when the route owns its image', async () => {
    // `hasOwnProperty`, not a truthiness check, is what Next tests before letting a
    // colocated opengraph-image.tsx fill the images in — resolve-metadata.js:148-149. So
    // `images: undefined` would suppress the file just as effectively as a value, and the
    // article would end up with NO og:image at all.
    const m = await pageMetadata({ title: 'Post', canonical: '/posts/bai', image: 'colocated' })

    expect(Object.prototype.hasOwnProperty.call(m.openGraph ?? {}, 'images')).toBe(false)
  })

  it('og:image of a cover image is the ~1200px version via /_next/image, size taken from the downscaled version', async () => {
    const file = '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg'
    // The original is up to 2400px and 4 MiB; w=1200 is a default deviceSize, q=75 is the default quality.
    expect(coverOgImage({ fileName: file, width: 2400, height: 1800 }, 'Diagram')).toEqual({
      url: `/_next/image?url=%2Fmedia%2F${file}&w=1200&q=75`,
      width: 1200,
      height: 900,
      alt: 'Diagram',
    })
    // Portrait image: width 1200, height follows the aspect ratio.
    expect(coverOgImage({ fileName: file, width: 1800, height: 2400 }, 'x')).toMatchObject({ width: 1200, height: 1600 })
    // next/image does not upscale: an image narrower than 1200px keeps its own size.
    expect(coverOgImage({ fileName: file, width: 800, height: 533 }, 'x')).toMatchObject({ width: 800, height: 533 })
    // The `url` parameter is the encoded /media/ path: decoding it once gives exactly mediaPath.
    const url = new URL(coverOgImage({ fileName: file, width: 2400, height: 1800 }, 'x').url, 'http://localhost')
    expect(url.pathname).toBe('/_next/image')
    expect(url.searchParams.get('url')).toBe(`/media/${file}`)
  })

  it('the share card of a post without a cover image is its own route, versioned by the update time', async () => {
    expect(postCardOgImage('sample-post-05', 'Sample post 05', '2026-10-04T05:54:39Z')).toEqual({
      url: `/api/og/posts/sample-post-05?v=${Date.parse('2026-10-04T05:54:39Z')}`,
      width: 1200,
      height: 630,
      alt: 'Sample post 05',
    })
    // The slug is encoded once (Vietnamese slugs are percent-encoded in URLs); no version when the date is missing or unreadable.
    expect(postCardOgImage(SLUG_BE_TAC, 'x').url).toBe('/api/og/posts/b%E1%BA%BF-t%E1%BA%AFc')
    expect(postCardOgImage('a', 'x', 'not a date').url).toBe('/api/og/posts/a')
  })

  it('a specific image (a post cover): images is exactly that image, with size and alt', async () => {
    // The "present" counterpart of the test above: same post, and when there is a cover image it is the og:image —
    // the key is present, so the text card in opengraph-image.tsx must not be used.
    const image = {
      url: '/media/6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg',
      width: 1600,
      height: 1067,
      alt: 'Three queue diagram',
    }
    const m = await pageMetadata({ title: 'Post', canonical: '/posts/bai', image })

    expect(m.openGraph?.images).toEqual([image])
    // Relative like OG_IMAGE: metadataBase makes it absolute, the origin is configured in one place only.
    expect((m.openGraph?.images as { url: string }[])[0].url.startsWith('/media/')).toBe(true)
  })
})

/**
 * The guard that is worth more than all the assertions above: a public route added in six
 * months must not be able to reintroduce this defect by writing its metadata by hand.
 *
 * It is a source-text lint, so it cannot see a page that calls the helper and then
 * overwrites `openGraph` afterwards — the per-route assertions in each page.test.tsx cover
 * the routes that exist. The two together are what make this fix non-regressable.
 */
describe('every public page builds its metadata through the helper', () => {
  it('finds no page that writes its own metadata by hand', () => {
    const appDir = join(process.cwd(), 'app')
    const pages = [...routeMap(appDir).entries()]

    // Proved first: an empty map would make the loop pass while checking nothing.
    expect(pages.length, `resolved ${appDir}, which does not look like the app directory`).toBeGreaterThan(5)

    const offenders: string[] = []
    for (const [url, file] of pages) {
      // Admin pages are behind a login, are never shared, and are noindex by declaration
      // (app/admin/layout.tsx). Excluded deliberately rather than by accident.
      if (url === '/admin' || url.startsWith('/admin/')) continue
      // The first-run setup page has its own noindex layout and is a 404 once setup is done: it is not shared either.
      if (url === '/setup') continue

      const source = readFileSync(join(process.cwd(), file), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      if (!/\bpageMetadata\(/.test(code)) offenders.push(`${url} (${file})`)
    }

    expect(
      offenders,
      'these public pages do not build their metadata with pageMetadata() from ' +
        '@/lib/metadata. A page that writes `openGraph` by hand either inherits the ' +
        "homepage's og:title and og:url, or drops og:locale and og:site_name by restating " +
        'the block without them — both were measured on this site.',
    ).toEqual([])
  })

  it('the three new routes for Best posts and Series are in the route map and go through the helper', () => {
    // The "present" counterpart of the test above: an empty violation list only means something when the new routes
    // really are in the map. A page put in the wrong folder (outside app/, or behind a `_private`) would
    // be missing from the map and leave the test above green while checking nothing about it.
    const routes = routeMap(join(process.cwd(), 'app'))

    for (const url of ['/start-here', '/series', '/series/[slug]']) {
      const file = routes.get(url)
      expect(file, `no page serves ${url}`).toBeDefined()
      const code = readFileSync(join(process.cwd(), file as string), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(code, `${url} (${file})`).toMatch(/\bpageMetadata\(/)
    }
  })
})
