import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import type { PostSummary, SeriesRef, Tag } from '@/lib/types'
import { RELATED_COUNT, RelatedPosts, getRelatedPosts } from './RelatedPosts'
import { msg } from '@/test/render-intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'
import { DIACRITIC_SLUG } from '@/test/fixtures/vi/slug-diacritics'

/**
 * related posts read from `fetchAllPublishedPosts()` — the list of every published post that the post
 * page already pulled for "what to read next" (getDiscovery), the same cached request — instead of a separate
 * `getPosts({ category })`. Mock exactly that module: the real one calls the network, and it is the boundary this
 * function promises to use. `ApiError` is the real class from lib/api.ts, so the error test throws exactly what the backend throws.
 */
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))

const category = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }
const other = { id: 'c2', name: 'Debugging', slug: 'debugging', description: null }

const tag = (slug: string, name: string): Tag => ({ id: `t-${slug}`, name, slug })
const AWS = tag('aws', 'AWS')
const QUEUE = tag('queue', 'Queues')
const JAVA = tag('java', 'Java')
const CI = tag('ci-cd', 'CI/CD')

const summary = (slug: string, extra: Partial<PostSummary> = {}): PostSummary => ({
  id: `id-${slug}`,
  title: `Post ${slug}`,
  slug,
  excerpt: null,
  status: 'PUBLISHED',
  category,
  tags: [],
  publishedAt: '2026-09-28T17:30:00Z',
  featured: false,
  readingMinutes: 5,
  ...extra,
})

/** The `n`th publish date of September: a larger number is a newer post. */
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T08:00:00Z`

const series = (slug: string): SeriesRef => ({ id: `s-${slug}`, slug, title: slug, position: 1, partNumber: 1, partCount: 3 })

/** The post being read: the Architecture category, two tags. */
const current = { slug: 'hien-tai', category, tags: [AWS, QUEUE], series: null }

function stubAll(posts: PostSummary[]) {
  vi.mocked(fetchAllPublishedPosts).mockResolvedValue(posts)
}

const slugs = (posts: PostSummary[]) => posts.map((p) => p.slug)

afterEach(() => {
  vi.mocked(fetchAllPublishedPosts).mockReset()
})

describe('getRelatedPosts', () => {
  it('reads only the posts of the language it is given', async () => {
    stubAll([summary('cung-chuyen-muc', { tags: [], publishedAt: day(10) })])

    await getRelatedPosts(current, 'en')

    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('en')
  })

  it(
    msg('Admin.postImages.size', {
      width: 'score = 2 ',
      height: ' same category + number of shared tags; higher score first, nothing shared means it does not enter',
    }),
    async () => {
      stubAll([
        summary('chi-mot-the', { category: other, tags: [AWS], publishedAt: day(20) }),
        summary('khong-chung-gi', { category: other, tags: [JAVA], publishedAt: day(25) }),
        summary('cung-chuyen-muc', { tags: [], publishedAt: day(10) }),
        summary('chuyen-muc-va-the', { tags: [QUEUE], publishedAt: day(5) }),
      ])

      // 2 + 1 = 3, then 2, then 1. A post sharing nothing (score 0) does not enter, even if newest: "related" must
      // be a true claim, not a place to pad up to three.
      expect(slugs(await getRelatedPosts(current))).toEqual(['chuyen-muc-va-the', 'cung-chuyen-muc', 'chi-mot-the'])
    },
  )

  it('the same category weighs twice a tag: two shared tags in another category tie with the same category', async () => {
    const reading = { ...current, tags: [AWS, QUEUE, JAVA] }
    stubAll([
      summary('cung-chuyen-muc', { tags: [], publishedAt: day(9) }),
      summary('hai-the', { category: other, tags: [AWS, QUEUE], publishedAt: day(8) }),
      summary('ba-the', { category: other, tags: [AWS, QUEUE, JAVA], publishedAt: day(1) }),
    ])

    // three-tags: 3 (the oldest still comes first); same-category and two-tags: both 2, the newer post first.
    expect(slugs(await getRelatedPosts(reading))).toEqual(['ba-the', 'cung-chuyen-muc', 'hai-the'])
  })

  it('on equal score the newer post comes first, not trusting the list order', async () => {
    // The list oldest first: an implementation relying on the API order (newest first) would return it reversed.
    stubAll([
      summary('cu-nhat', { publishedAt: day(1) }),
      summary('khong-ngay', { publishedAt: null }),
      summary('giua', { publishedAt: day(15) }),
      summary('moi-nhat', { publishedAt: day(28) }),
    ])

    expect(slugs(await getRelatedPosts(current))).toEqual(['moi-nhat', 'giua', 'cu-nhat'])
  })

  it(`at most ${RELATED_COUNT} posts`, async () => {
    stubAll(['a', 'b', 'c', 'd', 'e'].map((slug, i) => summary(slug, { publishedAt: day(20 - i) })))

    expect(slugs(await getRelatedPosts(current))).toEqual(['a', 'b', 'c'])
  })

  it('never the post being read itself', async () => {
    stubAll([summary('hien-tai', { tags: [AWS, QUEUE], publishedAt: day(28) }), summary('a', { publishedAt: day(2) })])

    expect(slugs(await getRelatedPosts(current))).toEqual(['a'])
  })

  it('drops the parts of the same series as the post being read, keeps parts of another series', async () => {
    stubAll([
      summary('phan-1', { series: series('series-a'), tags: [AWS, QUEUE], publishedAt: day(20) }),
      summary('a', { publishedAt: day(10) }),
      summary('phan-3', { series: series('series-a'), tags: [AWS], publishedAt: day(25) }),
      summary('series-khac', { series: series('pipeline-aws'), publishedAt: day(5) }),
    ])

    // The series block and PostNav right above already lead to the series' own parts; "related" is something
    // else, even though they share the most categories and tags.
    expect(slugs(await getRelatedPosts({ ...current, series: series('series-a') }))).toEqual(['a', 'series-khac'])
  })

  it('compares category and tags by slug; a tag repeated on the same post counts once', async () => {
    stubAll([
      // The same category NAME, a different slug: not the same category.
      summary('trung-ten', { category: { ...other, name: 'Architecture' }, tags: [], publishedAt: day(27) }),
      // A repeated tag: score 1, not 2 — even though newer, it must come after the post with two truly shared tags.
      summary('the-lap', { category: other, tags: [AWS, { ...AWS, id: 't-aws-2' }], publishedAt: day(26) }),
      summary('hai-the-that', { category: other, tags: [AWS, QUEUE], publishedAt: day(3) }),
      // The same tag name, a different slug: not shared.
      summary('ten-the-trung', { category: other, tags: [{ ...JAVA, name: 'AWS' }], publishedAt: day(24) }),
    ])

    expect(slugs(await getRelatedPosts(current))).toEqual(['hai-the-that', 'the-lap'])
  })

  it('a post with no category: related by tags, and two posts both lacking a category do not count as the same', async () => {
    stubAll([
      summary('cung-thieu-chuyen-muc', { category: null, tags: [], publishedAt: day(20) }),
      summary('co-aws', { category: null, tags: [AWS], publishedAt: day(10) }),
    ])

    expect(slugs(await getRelatedPosts({ ...current, category: null, tags: [AWS] }))).toEqual(['co-aws'])
  })

  it('no category, no tags: returns empty without reading the list', async () => {
    stubAll([summary('a'), summary('b')])

    expect(await getRelatedPosts({ slug: 'hien-tai', category: null, tags: [] })).toEqual([])
    // With nothing to compare there is nothing related: no "every post" pretending to be related posts.
    expect(fetchAllPublishedPosts).not.toHaveBeenCalled()
  })

  it('no post shares anything: empty, not padded with the newest post', async () => {
    // Some posts can be in a category with only one post: previously they had no related
    // posts at all. Now shared tags can pull posts for them, but sharing nothing is still empty.
    stubAll([summary('a', { category: other, tags: [CI] }), summary('b', { category: other, tags: [JAVA] })])

    expect(await getRelatedPosts(current)).toEqual([])
  })

  it('reads the full cached list, once: no more per-category request', async () => {
    stubAll([summary('a', { category: other, tags: [AWS] })])

    await getRelatedPosts(current)

    // fetchAllPublishedPosts is the same request (same URL, same `posts` tag) that getDiscovery and PostNav
    // use on this page; Next merges them into one.
    expect(fetchAllPublishedPosts).toHaveBeenCalledTimes(1)
  })

  it('a broken list: returns empty instead of breaking an already loaded post page', async () => {
    // `getPost` already succeeded when this function runs: the reader already has the post. A 503 of the list is a reason
    // to have no related block, not a reason to replace the page with an error page.
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))

    await expect(getRelatedPosts(current)).resolves.toEqual([])
  })
})

describe('RelatedPosts', () => {
  it('links a post under its own language prefix even when the page is in the other language', () => {
    render(<RelatedPosts posts={[summary('a', { language: 'en' }), summary('b', { language: 'vi' })]} />)

    expect(screen.getAllByRole('link', { name: 'Post a' })[0]).toHaveAttribute('href', '/en/posts/a')
    expect(screen.getAllByRole('link', { name: 'Post b' })[0]).toHaveAttribute('href', '/posts/b')
  })

  it('renders nothing — not even a heading — when there is nothing related', () => {
    const { container } = render(<RelatedPosts posts={[]} />)

    // A section titled with the related-posts heading and with no list under it reads as a bug to a
    // sighted reader and announces as an empty region to a screen reader. Checking
    // the container is empty catches the bordered-empty-box version too, which a
    // `queryByRole('heading')` assertion would miss.
    expect(container).toBeEmptyDOMElement()
  })

  it('does not print: print is the post, not navigation to other posts', () => {
    render(<RelatedPosts posts={[summary('a')]} />)

    expect(screen.getByRole('region', { name: msg('Site.related.title') })).toHaveClass('print:hidden')
  })

  it('heads a list of links to each related post', () => {
    render(<RelatedPosts posts={[summary('a'), summary('b'), summary('c')]} />)

    expect(screen.getByRole('heading', { level: 2, name: msg('Site.related.title') })).toBeInTheDocument()
    const list = screen.getByRole('list')
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/posts/a', '/posts/b', '/posts/c'])
  })

  it('renders one card for one sibling', () => {
    const { container } = render(<RelatedPosts posts={[summary('a')]} />)

    expect(screen.getByRole('heading', { level: 2, name: msg('Site.related.title') })).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    // Pinned again now that the card is a compact ListRow: the DOM has two <a> to the post (title and
    // thumbnail), and only one in the accessibility tree. The assert above skips aria-hidden links so
    // by itself it cannot tell "thumbnail hidden" from "no thumbnail".
    expect(container.querySelectorAll('a[href="/posts/a"]')).toHaveLength(2)
    expect(container.querySelector('a[href="/posts/a"][aria-hidden="true"][tabindex="-1"]')).not.toBeNull()
  })

  it('each card is a compact ListRow: 6rem thumbnail, no category, no tags', () => {
    const cover = {
      id: '2c4e6a8b-0d1f-4a3c-9e5b-7d9f1b3d5f7a',
      fileName: '2c4e6a8b-0d1f-4a3c-9e5b-7d9f1b3d5f7a.jpg',
      width: 1200,
      height: 800,
      altText: null,
      dominantColor: '#445566',
    }
    const { container } = render(
      <RelatedPosts
        posts={[
          summary('a', { cover, tags: [{ id: 't1', name: 'Lessons', slug: 'lessons' }] }),
          summary('b', { tags: [{ id: 't2', name: 'CI/CD', slug: 'ci-cd' }] }),
        ]}
      />,
    )

    // The cover image asks for exactly 6rem: the compact thumbnail does not grow on wide screens.
    expect(container.querySelector('img')).toHaveAttribute('sizes', '6rem')
    // A post without a cover image gets cover art.
    expect(container.querySelectorAll('svg.cover-art')).toHaveLength(1)
    // No tags: the post page already has its own tag row, and the post page test pins each tag link
    // appearing exactly once.
    expect(screen.queryByRole('list', { name: msg('Site.article.tagsLabel') })).not.toBeInTheDocument()
    expect(container.querySelector('a[href^="/tags/"]')).toBeNull()
    // The "present" pair: two cards, each an h3 with a link.
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Post a', 'Post b'])
  })

  it('titles each card with an h3, so the heading order does not skip', () => {
    render(<RelatedPosts posts={[summary('a')]} />)

    // The page's own h1 is the post title and this section's heading is an h2, so the
    // cards have to be h3. An h2 per card, or a <p>, breaks the outline a screen
    // reader navigates by — and nothing visual would show it.
    expect(screen.getByRole('heading', { level: 3, name: 'Post a' })).toBeInTheDocument()
  })

  it('shows the date and reading time but not the category', () => {
    const { container } = render(<RelatedPosts posts={[{ ...summary('a'), readingMinutes: 9 } as PostSummary]} />)

    // Through ReadingMeta, so the `timeZone: 'UTC'` guard lives in one place.
    expect(container.querySelector('time')?.textContent).toBe(LONG_DATE_VI(28, 9, 2026))
    expect(screen.getByText(msg('Site.article.readingTime', { minutes: '9' }))).toBeInTheDocument()
    // No category, even when the related post is in another category: the
    // compact row reserves room for the title, and three more category links are three keyboard stops that do not help
    // choose a post — see the note in RelatedPosts.tsx.
    expect(screen.queryByText('Architecture')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument()
  })

  it('shows an excerpt when there is one and nothing when there is not', () => {
    const { container, unmount } = render(<RelatedPosts posts={[summary('a', { excerpt: 'A short note.' })]} />)
    expect(screen.getByText('A short note.')).toBeInTheDocument()
    // Pinned again: exactly one <p> and it is the excerpt — the thumbnail's cover art contributes no <p>,
    // so this count is still about the excerpt.
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container.querySelector('p')?.textContent).toBe('A short note.')
    unmount()

    const second = render(<RelatedPosts posts={[summary('a', { excerpt: null })]} />)
    // `{post.excerpt && …}` with a loosened guard renders an empty <p> and a margin.
    expect(second.container.querySelectorAll('p')).toHaveLength(0)
  })

  it('percent-encodes a slug in the card link', () => {
    render(<RelatedPosts posts={[summary(DIACRITIC_SLUG)]} />)

    expect(screen.getByRole('link')).toHaveAttribute('href', `/posts/${encodeURIComponent(DIACRITIC_SLUG)}`)
  })

  it('uses the shared Container gutter rather than its own', () => {
    const { container } = render(<RelatedPosts posts={[summary('a')]} />)
    const frame = container.firstElementChild

    // The brief's one shared gutter. jsdom applies no Tailwind CSS at all, so this is
    // a class-name assertion and nothing more: it catches `px-6` or a hand-rolled
    // `container mx-auto` creeping in, which is the drift Container exists to stop.
    // It cannot tell you the page looks right.
    expect(frame).toContainElement(container.querySelector('section'))
    expect(frame?.className).toMatch(/\bpx-4\b/)
    expect(frame?.className).toMatch(/\bsm:px-6\b/)
    expect(frame?.className).toMatch(/\bmax-w-3xl\b/)
  })

  it("width='reader' gives the 1400px frame width (max-w-[87.5rem])", () => {
    const { container } = render(<RelatedPosts posts={[summary('a')]} width="reader" />)
    expect(container.firstElementChild?.className).toContain('max-w-[87.5rem]')
  })

  it("width='bare' applies no Container classes: the section is the root", () => {
    const { container } = render(<RelatedPosts posts={[summary('a')]} width="bare" />)

    expect(container.firstElementChild?.tagName).toBe('SECTION')
    expect(container.innerHTML).not.toMatch(/max-w-|px-4|sm:px-6|mx-auto/)
    expect(screen.getByRole('region', { name: msg('Site.related.title') })).toBe(container.firstElementChild)
  })

  it("width='bare' still renders nothing when there is nothing related", () => {
    const { container } = render(<RelatedPosts posts={[]} width="bare" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('RelatedPosts: divider line and rhythm', () => {
  it.each(['prose', 'bare'] as const)('the section carries the shared block rhythm, width=%s', (width) => {
    render(<RelatedPosts posts={[summary('a'), summary('b')]} width={width} />)

    // The divider is on the <section>, which sits inside the Container (the margins of the column), so it is
    // exactly as long as the text column: a border on the Container would be 24px longer on each side.
    const section = screen.getByRole('region', { name: msg('Site.related.title') })
    expect(section).toHaveClass('border-t', 'border-neutral-200', 'py-8', 'sm:py-10', 'dark:border-neutral-800', 'print:hidden')
    expect(section.className).not.toMatch(/\bmt-|\bpx-/)
  })
})
