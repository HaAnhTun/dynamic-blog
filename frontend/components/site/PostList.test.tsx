import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PostSummary } from '@/lib/types'
import { PostList } from './PostList'
import { msg } from '@/test/render-intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'
import { PL_EXCERPT_A, PL_MARK_B, PL_MARKS, PL_TITLE_A, PL_TITLE_B } from '@/test/fixtures/vi/post-list-highlight'

const READING_SUFFIX = msg('Site.article.readingTime', { minutes: '9' }).replace(/^9 /, '')

/**
 * PostList is a synchronous component, so RTL renders it directly — no `await` dance
 * like the page tests need for their async Server Components.
 *
 * The fixtures below use the SHAPES MEASURED off the running backend, not invented
 * ones: `curl -s "localhost:8080/api/v1/posts?size=2"` returns a `publishedAt` like
 * "2026-10-03T18:23:29.838073Z" (six fractional digits), `readingMinutes` as a plain
 * number, a nullable `category`, and tags whose `name` and `slug` differ.
 *
 * Each row is now a ListRow; the row's layout and kicker are checked in
 * ListRow.test.tsx. Here is the list's own part: one <li> per post, h2, a hideable category.
 */

const post = (over: Partial<PostSummary> = {}): PostSummary => ({
  id: 'p1',
  title: 'Sample post 12',
  slug: 'sample-post-12',
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: '2026-10-03T18:23:29.838073Z',
  readingMinutes: 12,
  featured: false,
  ...over,
})

describe('PostList', () => {
  it('renders one row per post, each title linking to its post', () => {
    const { container } = render(
      <PostList
        posts={[
          post({ id: 'a', title: 'First post', slug: 'first-post' }),
          post({ id: 'b', title: 'Second post', slug: 'second-post' }),
        ]}
      />,
    )

    expect(container.querySelectorAll('li > article')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'First post' })).toHaveAttribute('href', '/posts/first-post')
    expect(screen.getByRole('link', { name: 'Second post' })).toHaveAttribute('href', '/posts/second-post')
    // The row title must be an h2: the page owns the only h1, and a row rendered as an
    // h3 or a plain <div> would skip or lose a heading level with nothing else noticing.
    expect(screen.getByRole('heading', { level: 2, name: 'First post' })).toBeInTheDocument()
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()

    // Pinned again now that the row has a thumbnail: each post has TWO <a> in the DOM (title and thumbnail),
    // but only one link in the accessibility tree. The `getByRole` above skips aria-hidden links by itself,
    // so it stays green whether or not the thumbnail link is exposed; the two lines below do not.
    expect(container.querySelectorAll('a[href="/posts/first-post"]')).toHaveLength(2)
    expect(container.querySelectorAll('a[href="/posts/first-post"][aria-hidden="true"][tabindex="-1"]')).toHaveLength(1)
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/posts/first-post')).toHaveLength(1)
  })

  it('each row has a thumbnail: cover art when the post has no cover image', () => {
    const { container } = render(
      <PostList
        posts={[
          post({ id: 'a', title: 'First post', slug: 'first-post' }),
          post({ id: 'b', title: 'Second post', slug: 'second-post' }),
        ]}
      />,
    )

    const rows = container.querySelectorAll('li > article')
    for (const row of rows) {
      expect(row.querySelectorAll('svg.cover-art')).toHaveLength(1)
    }
    expect(container.querySelector('img')).toBeNull()
  })

  it('formats the date in vi-VN, long, and in UTC', () => {
    render(<PostList posts={[post()]} />)

    // Every part of this string is a separate guard, and the suite's TZ is pinned to
    // Asia/Ho_Chi_Minh (vitest.config.ts) so each one can actually fail:
    //   drop timeZone: 'UTC'  → the 4th of October 2026 in the vi-VN format  (18:23Z is already the 4th in +07)
    //   'vi-VN' → 'en-US'     → "October 3, 2026"
    //   dateStyle long→short  → "3/10/26"
    expect(screen.getByText(LONG_DATE_VI(3, 10, 2026))).toBeInTheDocument()
    // The machine-readable attribute, which is what a crawler and a screen reader use.
    expect(screen.getByText(LONG_DATE_VI(3, 10, 2026)).tagName).toBe('TIME')
    expect(screen.getByText(LONG_DATE_VI(3, 10, 2026))).toHaveAttribute('datetime', '2026-10-03T18:23:29.838073Z')
  })

  it('omits the date entirely when publishedAt is null', () => {
    const { container } = render(<PostList posts={[post({ publishedAt: null })]} />)

    // A draft has no publishedAt. Rendering `new Date(null)` would print
    // the 1st of January 1970 in the vi-VN format; rendering the raw value would print "null".
    expect(container.querySelector('time')).toBeNull()
    expect(container.textContent).not.toContain('1970')
    expect(container.textContent).not.toContain('null')
  })

  it('shows the reading time as "N min read"', () => {
    render(<PostList posts={[post({ readingMinutes: 12 })]} />)

    expect(screen.getByText(msg('Site.article.readingTime', { minutes: '12' }))).toBeInTheDocument()
  })

  it('shows no reading time at all when the API did not send one', () => {
    // All three absent-ish shapes. `lib/types.ts` now declares `readingMinutes: number`,
    // so two of these are no longer constructible through the type — and the cast below
    // is deliberate rather than a workaround.
    //
    // A TypeScript type is a claim about a wire format, not a guarantee from it. The
    // backend computes this field in a mapper; an older deployment, a cached response or
    // a hand-built object can all produce a payload the type says is impossible, and
    // `{post.readingMinutes}` followed by the reading-time suffix would then print the word null to a reader.
    // 0 is the one a truthiness check would silently conflate with missing, which is why
    // the guard is `typeof === 'number' && > 0`.
    for (const readingMinutes of [null, undefined, 0] as const) {
      const bad = { ...post(), readingMinutes } as unknown as PostSummary
      const { container, unmount } = render(<PostList posts={[bad]} />)

      expect(container.textContent, `readingMinutes=${readingMinutes}`).not.toContain(READING_SUFFIX)
      expect(container.textContent).not.toContain('null')
      expect(container.textContent).not.toContain('undefined')
      unmount()
    }
  })

  it('links the category to its archive, by slug, labelled by its name', () => {
    render(
      <PostList
        posts={[
          post({
            category: {
              id: 'c1',
              name: 'Architecture',
              slug: 'architecture',
              description: null,
            },
          }),
        ]}
      />,
    )

    const link = screen.getByRole('link', { name: 'Architecture' })
    // Name on the label, slug in the href. Building the href from `category.name` would
    // produce /categories/Architecture, which is a 404 by design — the
    // archive matches the route param against `category.slug`.
    expect(link).toHaveAttribute('href', '/categories/architecture')
  })

  it('showCategory={false} drops the category link from every row (category page)', () => {
    const architecture = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }
    const { container } = render(
      <PostList
        showCategory={false}
        posts={[
          post({ id: 'a', title: 'First post', slug: 'first-post', category: architecture }),
          post({ id: 'b', title: 'Second post', slug: 'second-post', category: architecture }),
        ]}
      />,
    )

    // On /categories/architecture the h1 is already the category name: adding a link back to that same page
    // on each row is ten links that lead nowhere.
    expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument()
    expect(container.querySelector('a[href^="/categories/"]')).toBeNull()
    // The "present" pair: the rest of each row is still complete (the test above is the default pair with the link).
    expect(screen.getByRole('link', { name: 'First post' })).toBeInTheDocument()
    expect(container.querySelectorAll('time')).toHaveLength(2)
  })

  it('builds every tag href from the slug and never from the name', () => {
    // The two differ for most real tags. These three are straight out of
    // `curl -s localhost:8080/api/v1/tags`, chosen because each breaks a different
    // naive transformation: diacritics, a slash, and a space.
    render(
      <PostList
        posts={[
          post({
            tags: [
              { id: 't1', name: 'Lessons', slug: 'lessons' },
              { id: 't2', name: 'CI/CD', slug: 'ci-cd' },
              { id: 't3', name: 'Spring Boot', slug: 'spring-boot' },
            ],
          }),
        ]}
      />,
    )

    expect(screen.getByRole('link', { name: 'Lessons' })).toHaveAttribute('href', '/tags/lessons')
    expect(screen.getByRole('link', { name: 'CI/CD' })).toHaveAttribute('href', '/tags/ci-cd')
    expect(screen.getByRole('link', { name: 'Spring Boot' })).toHaveAttribute('href', '/tags/spring-boot')

    // The discriminating half: an href built from `tag.name` would still carry the
    // right accessible name above, so the assertions alone cannot tell the two apart.
    // `/tags/CI%2FCD` is the one that matters most — a slash in a path segment would
    // also change the route shape, not just the value.
    //
    // Pinned again: walks every <a> in the DOM, not only links in the accessibility tree, because a row now
    // has a hidden link (the thumbnail). Exactly three tag links, no more: no hidden copy points at a tag.
    const tagHrefs = Array.from(document.querySelectorAll('a'))
      .map((link) => link.getAttribute('href') ?? '')
      .filter((href) => href.startsWith('/tags/'))
    expect(tagHrefs).toHaveLength(3)
    for (const href of tagHrefs) {
      expect(href, 'a tag href was built from tag.name').toMatch(/^\/tags\/[a-z0-9-]+$/)
    }
  })

  it('renders the excerpt when there is one and nothing when there is not', () => {
    const text = 'The partner ticketing system has no public API.'

    const withExcerpt = render(<PostList posts={[post({ excerpt: text })]} />)
    expect(screen.getByText(text)).toBeInTheDocument()
    withExcerpt.unmount()

    const { container } = render(<PostList posts={[post({ excerpt: null })]} />)
    // Pinned again now that the row has a thumbnail and kicker: cover art has no <p>/<text>, and the series
    // kicker is a <div>, so "no excerpt means no <p>" is still an assert about the excerpt and
    // does not accidentally catch decoration. The second post belongs to a series so the kicker is present.
    expect(container.querySelector('p')).toBeNull()
    const inSeries = render(
      <PostList
        posts={[
          post({
            excerpt: null,
            series: {
              id: 's1',
              slug: 'series-a',
              title: 'Series A',
              position: 1,
              partNumber: 1,
              partCount: 4,
            },
          }),
        ]}
      />,
    )
    expect(inSeries.getByText(msg('Site.listing.partLabel', { number: '1', total: '4' }))).toBeInTheDocument()
    expect(inSeries.container.querySelector('p')).toBeNull()
  })

  it('`query` (passed only by the search page) highlights the keyword on every row; when not passed nothing is highlighted', () => {
    const posts = [
      post({ id: 'a', title: PL_TITLE_A, slug: 'hoc-java', excerpt: PL_EXCERPT_A }),
      post({ id: 'b', title: PL_TITLE_B, slug: 'duong-ong' }),
    ]

    const searched = render(<PostList posts={posts} query="hoc duong" />)
    expect(Array.from(searched.container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(PL_MARKS)
    // Each row receives exactly that query: highlighted on the second row too, not only the first.
    expect(searched.getByRole('link', { name: PL_TITLE_B }).querySelector('mark')?.textContent).toBe(PL_MARK_B)
    searched.unmount()

    // /writing, category, tag: the same PostList, no query, no <mark>.
    const { container } = render(<PostList posts={posts} />)
    expect(container.querySelector('mark')).toBeNull()
  })

  it('renders no list element at all when there are no posts', () => {
    const { container } = render(<PostList posts={[]} />)

    expect(screen.getByText(msg('Site.home.empty'))).toBeInTheDocument()
    // Element, not text: an `items.map` over an empty array still renders a <ul>, and a
    // text-absence assertion would be satisfied by an empty <article>.
    expect(container.querySelector('ul')).toBeNull()
    expect(container.querySelector('article')).toBeNull()
  })

  it('lets the archives say which archive is empty', () => {
    render(<PostList posts={[]} emptyMessage={msg('Site.taxonomy.categoryEmpty')} />)

    expect(screen.getByText(msg('Site.taxonomy.categoryEmpty'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Site.home.empty'))).not.toBeInTheDocument()
  })
})
