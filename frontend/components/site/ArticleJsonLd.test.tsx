import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import type { Post } from '@/lib/types'
import { join } from 'node:path'
import { routeMap } from '@/test/routes'
import { absoluteUrl } from '@/lib/site'
import { ArticleJsonLd, authorName, postAlternates, postLanguage, postPath, postUrl } from './ArticleJsonLd'
import { ACCENTED_LETTER, ACCENTED_SLUG } from '@/test/fixtures/vi/article-json-ld'

const { profile } = defaultSiteContent('vi')

describe('authorName', () => {
  it('is the owner name for the site owner and for a missing author, the display name for anyone else', () => {
    const other = { displayName: 'Mary Example', githubLogin: null, avatarUrl: null, siteOwner: false }
    expect(authorName(undefined, profile.name)).toBe(profile.name)
    expect(authorName({ ...other, displayName: 'admin', siteOwner: true }, profile.name)).toBe(profile.name)
    expect(authorName(other, profile.name)).toBe('Mary Example')
  })
})

const post: Post = {
  id: '1',
  title: 'Framing the performance question',
  slug: 'dat-van-de',
  excerpt: 'A short set of notes.',
  status: 'PUBLISHED',
  category: { id: 'c1', name: 'Technology', slug: 'technology', description: null },
  tags: [],
  publishedAt: '2026-09-28T17:30:00Z',
  featured: false,
  readingMinutes: 1,
  content: 'A single paragraph.',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
}

/**
 * Renders to a STRING and reads the JSON back out of it, rather than rendering into
 * jsdom and reading `textContent`.
 *
 * That is the whole point of the `</script>` test below: `textContent` on a node React
 * built with `dangerouslySetInnerHTML` gives back whatever string was handed to it,
 * escaped or not, so a jsdom-only assertion would pass against the broken version.
 * The HTML string is what a browser's tokenizer actually sees.
 */
function emit(p: Post) {
  const html = renderToStaticMarkup(<ArticleJsonLd post={p} ownerName={profile.name} />)
  const body = html.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')
  return { html, body, data: JSON.parse(body) as Record<string, unknown> }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('postPath / postUrl', () => {
  it('builds the canonical path for a slug', () => {
    expect(postPath('dat-van-de')).toBe('/posts/dat-van-de')
  })

  it('percent-encodes a slug so the path is a legal URL', () => {
    expect(postPath(ACCENTED_SLUG)).toBe(`/posts/${encodeURIComponent(ACCENTED_SLUG)}`)
    expect(postPath(ACCENTED_SLUG)).not.toContain(ACCENTED_LETTER)
  })

  it('prefixes the configured origin and never doubles the slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com/')

    // A trailing slash in the env var is the obvious way for someone to write it, and
    // `${origin}${path}` without the trim gives `https://example.com//posts/x` — a
    // different URL to every crawler and cache than the one the canonical tag claims.
    expect(postUrl('dat-van-de')).toBe('https://example.com/posts/dat-van-de')
  })

  it('falls back to the same origin app/layout.tsx falls back to when unset', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined)

    // Two different dev fallbacks would make the copy button produce a URL that the
    // canonical tag on the same page contradicts.
    expect(postUrl('x')).toBe('http://localhost:3000/posts/x')
  })

  it('treats a present-but-empty env var as unset rather than as an origin', () => {
    // `NEXT_PUBLIC_SITE_URL=` with nothing after it is a real way to write a .env
    // line. With `??` instead of `||` this returns '/posts/x' — a relative string
    // handed to JSON-LD and to the clipboard as though it were absolute.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(postUrl('x')).toBe('http://localhost:3000/posts/x')

    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '   ')
    expect(postUrl('x')).toBe('http://localhost:3000/posts/x')
  })
})

describe('ArticleJsonLd', () => {
  it('emits a BlogPosting script carrying the fields a crawler reads', () => {
    const { html, data } = emit(post)

    expect(html.startsWith('<script type="application/ld+json">')).toBe(true)
    expect(data).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'Framing the performance question',
      datePublished: '2026-09-28T17:30:00Z',
      dateModified: '2026-09-02T00:00:00Z',
      description: 'A short set of notes.',
      url: 'http://localhost:3000/posts/dat-van-de',
    })
    // The owner name of the site content, not a hardcoded string here: an author
    // field that drifts from the site's own byline is a structured-data mismatch.
    //
    // `url` is the author page, and `toEqual` pins the whole object so a fourth key cannot
    // be added without a decision. It is the SAME string the ProfilePage node on /about
    // claims for the same person (components/site/JsonLd.tsx), which is what makes the two
    // nodes describe one author rather than two people who happen to share a name.
    //
    // Pinned on purpose: a fixture without `author` (backend before multi-author support) is a post by the site owner, and a post
    // with `author.siteOwner` is too — the name is still profile.name, not the account's display name.
    const owner = { '@type': 'Person', name: profile.name, url: absoluteUrl('/about') }
    expect(data.author).toEqual(owner)
    const byOwner = emit({ ...post, author: { displayName: 'admin', githubLogin: 'admin', avatarUrl: null, siteOwner: true } })
    expect(byOwner.data.author).toEqual(owner)
    expect(profile.name).not.toBe('')
  })

  it('another author: the Person carries their name and GitHub page when present, never /about', () => {
    const other = { displayName: 'Mary Example', githubLogin: 'maryexample', avatarUrl: null, siteOwner: false }

    expect(emit({ ...post, author: other }).data.author).toEqual({
      '@type': 'Person',
      name: 'Mary Example',
      url: 'https://github.com/maryexample',
    })
    // No login means no url: absent rather than null, and it does not borrow the site owner's page.
    const { html, data } = emit({ ...post, author: { ...other, githubLogin: null } })
    expect(data.author).toEqual({ '@type': 'Person', name: 'Mary Example' })
    expect(html).not.toContain('/about')
  })

  it('another author with a profile (T-003): url is an absolute /u/<slug>, GitHub becomes sameAs; that route really exists', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const other = {
      displayName: 'Mary Example',
      githubLogin: 'maryexample',
      avatarUrl: null,
      siteOwner: false,
      profileSlug: 'mary-example',
    }

    expect(emit({ ...post, author: other }).data.author).toEqual({
      '@type': 'Person',
      name: 'Mary Example',
      url: 'https://blog.example.com/u/mary-example',
      sameAs: 'https://github.com/maryexample',
    })
    expect(emit({ ...post, author: { ...other, githubLogin: null } }).data.author).toEqual({
      '@type': 'Person',
      name: 'Mary Example',
      url: 'https://blog.example.com/u/mary-example',
    })
    // A site owner with a profileSlug is still /about.
    const owner = emit({ ...post, author: { ...other, siteOwner: true } }).data.author as { url: string }
    expect(owner.url).toBe('https://blog.example.com/about')
    expect(routeMap(join(process.cwd(), 'app')).has('/u/[slug]')).toBe(true)
  })

  it('a locked author (profileSlug null): no profile url, like the old backend (GitHub when present)', () => {
    const suspended = {
      displayName: 'Mary Example',
      githubLogin: 'maryexample',
      avatarUrl: null,
      siteOwner: false,
      profileSlug: null,
    }

    const { html, data } = emit({ ...post, author: suspended })
    expect(data.author).toEqual({ '@type': 'Person', name: 'Mary Example', url: 'https://github.com/maryexample' })
    expect(html).not.toContain('/u/')
    expect(emit({ ...post, author: { ...suspended, githubLogin: null } }).data.author).toEqual({
      '@type': 'Person',
      name: 'Mary Example',
    })
  })

  it('claims only URLs this app actually serves', () => {
    // The mechanical half of "truthful". A structured-data URL that 404s is a Search
    // Console error with no symptom anywhere on the site, so nothing else would catch
    // /about being renamed or moved — and the author URL would quietly start pointing at
    // nothing.
    const { data } = emit(post)
    const routes = routeMap(join(process.cwd(), 'app'))
    expect(routes.size, 'route map looks empty').toBeGreaterThan(5)

    for (const url of [data.url as string, (data.author as { url: string }).url]) {
      expect(routes.has(new URL(url).pathname.replace(/\/posts\/.+$/, '/posts/[slug]')), url).toBe(true)
    }
  })

  it('an English post states inLanguage en and its /en URL', () => {
    const { data } = emit({ ...post, language: 'en' })

    expect(data.inLanguage).toBe('en')
    expect(data.url).toBe(postUrl(post.slug, 'en'))
  })

  it('names the section and keywords the page itself shows, or neither', () => {
    // Google's structured-data policy is that markup must describe content visible on the
    // page. These two come from the category and tag objects the article page renders as
    // links under the title, so they are compared against the fixture rather than against
    // a literal — a test with the category name written in it would keep passing if the
    // component started emitting the slug, or a hardcoded string, instead.
    const { data } = emit({ ...post, tags: [{ id: 't1', name: 'Architecture', slug: 'architecture' }] })

    expect(data.articleSection).toBe(post.category?.name)
    expect(data.keywords).toEqual(['Architecture'])
    // `vi`, the same language `<html lang="vi">` declares in app/layout.tsx.
    expect(data.inLanguage).toBe('vi')

    // And the negative half: absent, not empty. `"keywords": ""` claims the article has no
    // subject; a missing key claims nothing.
    const bare = emit({ ...post, category: null, tags: [] }).data
    expect(Object.keys(bare)).not.toContain('articleSection')
    expect(Object.keys(bare)).not.toContain('keywords')
  })

  it('claims no image without a cover, and never a publisher', () => {
    // Pinned again for cover images: `image` is now real for posts WITH a cover image (test below). A post without
    // a cover image still has no `image`: the only other thing is the generated share card, whose URL
    // carries the route-group hash and a content hash that Next builds at build time — a string this component cannot
    // build, and a handwritten one would 404 silently. `publisher` would be an organisation
    // that does not exist: this is one person's blog, and the content
    // carries `org: null` wherever there is no employer to name. `mainEntityOfPage` would be a
    // second spelling of `url`.
    const { data } = emit({ ...post, cover: null })

    for (const key of ['image', 'publisher', 'mainEntityOfPage']) {
      expect(Object.keys(data), `${key} must be backed by real data before it is claimed`).not.toContain(key)
    }
  })

  it('a post with a cover image: image is an absolute URL to that very image under /media/', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    const cover = {
      id: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f',
      fileName: '6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg',
      width: 1600,
      height: 1067,
      altText: null,
      dominantColor: '#5a6b7c',
    }

    const { data } = emit({ ...post, cover })

    // Absolute: JSON-LD has no metadataBase to lean on. The same image the post page shows and og:image.
    expect(data.image).toBe('https://example.com/media/6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f.jpg')
    // Having an image does not mean having a publisher.
    expect(Object.keys(data)).not.toContain('publisher')
  })

  it('survives a title containing </script>', () => {
    // The failure this guards is not a wrong value — it is the SCRIPT ELEMENT ENDING
    // EARLY. The HTML tokenizer does not parse script contents as JSON; it scans for
    // the literal `</script` and stops there, so the rest of the JSON lands in the
    // page as text and whatever follows is parsed as markup. JSON.stringify escapes
    // quotes and backslashes but never `<` or `/`, so it does not help at all.
    const hostile = { ...post, title: 'Read carefully </script><img src=x> before pasting' }
    const { html, data } = emit(hostile)

    // Exactly one closing tag in the whole output: the element's own.
    expect(html.match(/<\/script/gi)).toHaveLength(1)
    // And nothing that could start an HTML comment inside script data either.
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<!--')
    // The escape has to be lossless — a crawler must still read the real title.
    expect(data.headline).toBe('Read carefully </script><img src=x> before pasting')

    // Through a real HTML parser, which is the assertion that cannot be faked: feed
    // the emitted markup to the tokenizer and check the script still holds the whole
    // document. On the unescaped version the parser closes <script> at the title's
    // `</script>`, so the JSON is truncated and this JSON.parse throws.
    const host = document.createElement('div')
    host.innerHTML = html
    const scripts = host.querySelectorAll('script[type="application/ld+json"]')
    expect(scripts).toHaveLength(1)
    expect(JSON.parse(scripts[0].textContent ?? '')).toEqual(data)
    // Nothing escaped the element.
    expect(host.querySelector('img')).toBeNull()
  })

  it('renders nothing for a post that is not published', () => {
    // A BlogPosting node for a draft advertises a URL that answers 404 to the
    // aggregator that followed it.
    expect(renderToStaticMarkup(<ArticleJsonLd post={{ ...post, status: 'DRAFT' }} ownerName={profile.name} />)).toBe('')
    // Positive control: the same post published does emit something, so the assertion
    // above is not passing because the component is broken.
    expect(renderToStaticMarkup(<ArticleJsonLd post={post} ownerName={profile.name} />)).not.toBe('')
  })

  it('omits description and datePublished rather than emitting null', () => {
    const { data } = emit({ ...post, excerpt: null, publishedAt: null })

    // `"description": null` makes a validator reject the node; a missing key is fine.
    // `toBeUndefined` would pass on an explicit null, so assert on the key set.
    expect(Object.keys(data)).not.toContain('description')
    expect(Object.keys(data)).not.toContain('datePublished')
    expect(data.dateModified).toBe('2026-09-02T00:00:00Z')
  })
})

describe('postUrl in a language and postAlternates', () => {
  it('postUrl(slug, language) is the URL of the post in its own language', () => {
    expect(postUrl('x', 'en')).toBe('http://localhost:3000/en/posts/x')
    expect(postUrl('x', 'vi')).toBe('http://localhost:3000/posts/x')
  })

  it('postLanguage falls back to the default locale for a missing or unknown language', () => {
    expect(postLanguage({})).toBe('vi')
    expect(postLanguage({ language: 'fr' })).toBe('vi')
    expect(postLanguage({ language: 'en' })).toBe('en')
  })

  it('has no alternates without a translation', () => {
    expect(postAlternates({ slug: 'a', language: 'en' })).toBeUndefined()
    expect(postAlternates({ slug: 'a', language: 'en', translations: [] })).toBeUndefined()
  })

  it('lists the post and its translations plus x-default when the default language has a member; skips unknown languages', () => {
    const translations = [
      { language: 'vi', slug: 'b', title: 'B', status: 'PUBLISHED' },
      { language: 'fr', slug: 'c', title: 'C', status: 'PUBLISHED' },
    ]
    expect(postAlternates({ slug: 'a', language: 'en', translations })).toEqual({
      en: '/en/posts/a',
      vi: '/posts/b',
      'x-default': '/posts/b',
    })
  })
})
