import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { absoluteUrl, siteUrl } from '@/lib/site'
import { routeMap } from '@/test/routes'
import { BreadcrumbJsonLd, CollectionPageJsonLd, JsonLd, ProfilePageJsonLd, WebSiteJsonLd } from './JsonLd'
import { msg } from '@/test/render-intl'

const { site, profile } = defaultSiteContent('vi')
const GITHUB = 'https://github.com/example-user'
const ABOUT = { name: profile.name, role: profile.role, github: GITHUB }

/**
 * Renders to a STRING and reads the JSON back out of it, rather than rendering into jsdom
 * and reading `textContent`.
 *
 * That is the whole point of the `</script>` test: `textContent` on a node React built with
 * `dangerouslySetInnerHTML` gives back whatever string was handed to it, escaped or not, so
 * a jsdom-only assertion would pass against the broken version. The HTML string is what a
 * browser's tokenizer actually sees.
 */
function emit(element: React.ReactElement) {
  const html = renderToStaticMarkup(element)
  const body = html.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')
  return { html, data: JSON.parse(body) as Record<string, unknown> }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('JsonLd', () => {
  it('cannot be ended early by a string inside it', () => {
    // The guard moved here with the serialiser, because the serialiser is the thing it
    // guards. The failure is not a wrong value — it is the SCRIPT ELEMENT ENDING EARLY: the
    // HTML tokenizer does not parse script contents as JSON, it scans for the literal
    // `</script` and stops, so the rest of the JSON lands in the page as text and whatever
    // follows is parsed as markup. JSON.stringify escapes quotes and backslashes but never
    // `<` or `/`, so it does not help at all.
    const hostile = 'Read carefully </script><img src=x> before pasting'
    const { html, data } = emit(<JsonLd data={{ headline: hostile }} />)

    expect(html.match(/<\/script/gi)).toHaveLength(1)
    expect(html).not.toContain('<img')
    // `<!--` inside script data drives the tokenizer into its double-escaped states, which
    // is why `>` and `&` are escaped too and not only `<`.
    expect(html).not.toContain('<!--')
    // Lossless: a crawler must still read the real string back.
    expect(data.headline).toBe(hostile)

    // Through a real HTML parser, which is the assertion that cannot be faked. On the
    // unescaped version the parser closes <script> at the first `</script>` and this
    // JSON.parse throws on a truncated document.
    const host = document.createElement('div')
    host.innerHTML = html
    const scripts = host.querySelectorAll('script[type="application/ld+json"]')
    expect(scripts).toHaveLength(1)
    expect(JSON.parse(scripts[0]!.textContent ?? '')).toEqual(data)
    expect(host.querySelector('img')).toBeNull()
  })
})

describe('WebSiteJsonLd', () => {
  it('names the site at the one URL the rest of the site already uses for it', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(<WebSiteJsonLd name={site.name} />)

    expect(data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: site.name,
      url: 'https://blog.example.com',
      inLanguage: 'vi',
    })

    // No trailing slash, and that is the assertion with teeth. `absoluteUrl('/')` — the
    // obvious thing to write — returns `${siteUrl()}/`, while the home page's canonical tag
    // and the sitemap's root <loc> are both the bare origin. A third spelling of the home
    // page, living in structured data where nothing on the site would show it, is exactly
    // the drift the note at the top of ArticleJsonLd.tsx exists to prevent.
    expect(data.url).toBe(siteUrl())
    expect(data.url).not.toBe(absoluteUrl('/'))
    expect(String(data.url)).not.toMatch(/\/$/)
  })

  it('offers no SearchAction', () => {
    // The audit asks for `potentialAction: { SearchAction }` to get the sitelinks search
    // box. Google retired that feature globally in November 2024, so the markup would be a
    // claim made for a consumer that no longer exists. This pins the decision rather than
    // leaving it to be re-litigated by whoever reads the audit next.
    const { data } = emit(<WebSiteJsonLd name={site.name} />)
    expect(Object.keys(data)).not.toContain('potentialAction')
  })
})

describe('ProfilePageJsonLd', () => {
  it('describes the person with what the page actually carries', () => {
    const { data } = emit(<ProfilePageJsonLd {...ABOUT} />)

    expect(data['@type']).toBe('ProfilePage')
    expect(data.mainEntity).toEqual({
      '@type': 'Person',
      name: profile.name,
      url: absoluteUrl('/about'),
      // `profile.role` describes the PERSON. `site.positioning` describes the SITE and
      // is already this page's meta description; using it here would make a person out of
      // a sentence about a blog.
      description: profile.role,
      // The fifth key, added on purpose once the site owner filled in GitHub; see the sameAs test below.
      sameAs: [GITHUB],
    })
  })

  it('claims nothing the content leaves empty', () => {
    const entity = emit(<ProfilePageJsonLd {...ABOUT} />).data.mainEntity as Record<string, unknown>

    for (const key of ['jobTitle', 'image', 'address', 'worksFor']) {
      expect(Object.keys(entity), `${key} has no backing data on this page`).not.toContain(key)
    }
  })

  it('links the GitHub profile via sameAs', () => {
    // The machine-readable version of the very `rel="me"` link that Hero and the contact section already print from the same data
    // field: it asserts nothing the page has not already asserted.
    const entity = emit(<ProfilePageJsonLd {...ABOUT} />).data.mainEntity as Record<string, unknown>

    expect(entity.sameAs).toEqual([GITHUB])
  })

  it('normalizes a username into a URL, because sameAs must be a URL', () => {
    const entity = emit(<ProfilePageJsonLd {...ABOUT} github="@octocat" />).data.mainEntity as Record<string, unknown>

    expect(entity.sameAs).toEqual(['https://github.com/octocat'])
  })

  it('has no sameAs key when there is no profile yet', () => {
    // Absent entirely, not `sameAs: []`: an empty array is the claim "this person has
    // no profile anywhere". An empty string is absence in another disguise, treated like null.
    for (const github of [null, '']) {
      const entity = emit(<ProfilePageJsonLd {...ABOUT} github={github} />).data.mainEntity as Record<string, unknown>
      expect(Object.keys(entity), `github=${JSON.stringify(github)}`).not.toContain('sameAs')
    }
  })

  it('points at a URL this app serves', () => {
    const entity = emit(<ProfilePageJsonLd {...ABOUT} />).data.mainEntity as { url: string }
    const routes = routeMap(join(process.cwd(), 'app'))

    expect(routes.size, 'route map looks empty').toBeGreaterThan(5)
    // Fails the day /about is renamed or moved, which is the only way the claim could stop
    // being true and the only failure with no symptom on the site.
    expect(routes.has(new URL(entity.url).pathname)).toBe(true)
  })
})

describe('BreadcrumbJsonLd', () => {
  it('numbers from 1 in the exact order passed in, each item one absolute URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(
      <BreadcrumbJsonLd
        items={[
          { name: msg('Site.footer.links.writing'), url: '/writing' },
          { name: 'Series', url: '/series' },
          { name: 'Series A', url: '/series/series-a' },
        ]}
      />,
    )

    expect(data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: msg('Site.footer.links.writing'), item: 'https://blog.example.com/writing' },
        { '@type': 'ListItem', position: 2, name: 'Series', item: 'https://blog.example.com/series' },
        {
          '@type': 'ListItem',
          position: 3,
          name: 'Series A',
          item: 'https://blog.example.com/series/series-a',
        },
      ],
    })
  })

  it('the home page is the bare origin, written the same way as the canonical and the sitemap', () => {
    // Like WebSiteJsonLd: absoluteUrl('/') has a trailing "/", while the home page's canonical and the sitemap's
    // root <loc> do not. Three ways of writing the home page is exactly the drift that the header
    // note of ArticleJsonLd.tsx exists to prevent.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(
      <BreadcrumbJsonLd
        items={[
          { name: 'Home', url: '/' },
          { name: msg('Site.footer.links.writing'), url: '/writing' },
        ]}
      />,
    )
    const [home, writing] = data.itemListElement as { item: string }[]

    expect(home!.item).toBe(siteUrl())
    expect(home!.item).not.toBe(absoluteUrl('/'))
    // The "present" pair: other pages are still full absolute URLs.
    expect(writing!.item).toBe('https://blog.example.com/writing')
  })

  it('with no items it renders nothing, not an empty BreadcrumbList', () => {
    expect(renderToStaticMarkup(<BreadcrumbJsonLd items={[]} />)).toBe('')
    // The "present" pair: one item is enough to get the script tag.
    expect(
      renderToStaticMarkup(<BreadcrumbJsonLd items={[{ name: msg('Site.footer.links.writing'), url: '/writing' }]} />),
    ).toContain('application/ld+json')
  })
})

describe('CollectionPageJsonLd', () => {
  it('is a CollectionPage whose mainEntity is an ItemList of posts, in the exact order passed in', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(
      <CollectionPageJsonLd
        name={msg('Site.footer.links.startHere')}
        url="/start-here"
        items={[
          {
            name: 'Read this one first',
            url: '/posts/doc-truoc',
          },
          { name: 'Read later', url: '/posts/doc-sau' },
        ]}
      />,
    )

    expect(data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: msg('Site.footer.links.startHere'),
      url: 'https://blog.example.com/start-here',
      inLanguage: 'vi',
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Read this one first',
            url: 'https://blog.example.com/posts/doc-truoc',
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: 'Read later',
            url: 'https://blog.example.com/posts/doc-sau',
          },
        ],
      },
    })
  })

  it('description is present when the page passes it, absent when not passed or empty', () => {
    // Exactly the string the page gives pageMetadata({ description }): the meta description and the JSON-LD are
    // one sentence. When absent the key is absent, not `"description": ""`: an empty string is the claim
    // that the page has nothing to describe.
    const items = [{ name: 'A', url: '/posts/a' }]
    const described = emit(
      <CollectionPageJsonLd
        name={msg('Site.footer.links.writing')}
        description="Notes about programming."
        url="/writing"
        items={items}
      />,
    ).data
    expect(described.description).toBe('Notes about programming.')

    for (const description of [undefined, '']) {
      const { data } = emit(
        <CollectionPageJsonLd name={msg('Site.footer.links.writing')} description={description} url="/writing" items={items} />,
      )
      expect(Object.keys(data), `description=${JSON.stringify(description)}`).not.toContain('description')
    }
  })

  it('offset: a paginated page continues numbering after the earlier pages, still counting from 1', () => {
    // ?page=2 with 10 posts per page shows posts 21 to 30 of the whole list. Restarting from 1 would make
    // the first page and this page both declare "position 1" for two different posts.
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(
      <CollectionPageJsonLd
        name={msg('Site.footer.links.writing')}
        url="/writing?page=2"
        offset={20}
        items={[
          { name: 'Post 21', url: '/posts/post-21' },
          { name: 'Post 22', url: '/posts/post-22' },
        ]}
      />,
    )
    const list = (data.mainEntity as { itemListElement: { position: number; url: string }[] }).itemListElement

    expect(list.map((item) => item.position)).toEqual([21, 22])
    // The page's own URL keeps the query: it is the canonical, and the canonical keeps the page number.
    expect(data.url).toBe('https://blog.example.com/writing?page=2')
  })

  it('with no items it renders nothing', () => {
    // An empty ItemList is the claim "this page lists nothing": an empty page stays
    // silent, like ArticleJsonLd with a draft post.
    expect(renderToStaticMarkup(<CollectionPageJsonLd name="Series" url="/series" items={[]} />)).toBe('')
    expect(
      renderToStaticMarkup(<CollectionPageJsonLd name="Series" url="/series" items={[{ name: 'A', url: '/posts/a' }]} />),
    ).toContain('application/ld+json')
  })

  it('a post title containing </script> does not close the tag early', () => {
    // Goes through the same serializer as every other block, does not build its own <script>.
    const hostile = 'Read carefully </script><img src=x> before pasting'
    const { html, data } = emit(
      <CollectionPageJsonLd
        name={msg('Site.footer.links.startHere')}
        url="/start-here"
        items={[{ name: hostile, url: '/posts/x' }]}
      />,
    )

    expect(html.match(/<\/script/gi)).toHaveLength(1)
    const list = (data.mainEntity as { itemListElement: { name: string }[] }).itemListElement
    expect(list[0]!.name).toBe(hostile)
  })
})

describe('JSON-LD per locale', () => {
  it('names the site at the locale home and in the locale language', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(<WebSiteJsonLd name={site.name} locale="en" />)
    expect(data).toMatchObject({ url: 'https://blog.example.com/en', inLanguage: 'en' })
  })

  it('points the profile page at the locale about page', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(<ProfilePageJsonLd {...ABOUT} locale="en" />)
    expect(data.inLanguage).toBe('en')
    expect((data.mainEntity as { url: string }).url).toBe('https://blog.example.com/en/about')
  })

  it('writes the collection and its items at the locale URLs, an item with its own locale at that one', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(
      <CollectionPageJsonLd
        name="Writing"
        url="/writing"
        locale="en"
        items={[
          { name: 'A', url: '/categories/a' },
          { name: 'B', url: '/posts/b', locale: 'vi' },
        ]}
      />,
    )
    expect(data).toMatchObject({ url: 'https://blog.example.com/en/writing', inLanguage: 'en' })
    const list = (data.mainEntity as { itemListElement: { url: string }[] }).itemListElement
    expect(list.map((item) => item.url)).toEqual(['https://blog.example.com/en/categories/a', 'https://blog.example.com/posts/b'])
  })

  it('writes the breadcrumb of the home page under the locale as /en', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
    const { data } = emit(<BreadcrumbJsonLd locale="en" items={[{ name: 'Home', url: '/' }]} />)
    expect((data.itemListElement as { item: string }[])[0]!.item).toBe('https://blog.example.com/en')
  })
})
