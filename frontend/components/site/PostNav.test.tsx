import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import type { PostSummary } from '@/lib/types'
import { PostNav, getAdjacentPosts } from './PostNav'
import { msg } from '@/test/render-intl'
import { DIACRITIC_POST_SLUG } from '@/test/fixtures/vi/post-nav-slug'

const PREVIOUS_PART_LABEL = new RegExp(msg('Site.postNav.previousPart', { title: 'x' }).split(' · ')[0]!)

/**
 * the neighbors are looked up in the FULL list (`fetchAllPublishedPosts`, the same cached request that
 * the "what to read next" block and related posts read on this page), no longer in one page of 50 posts. Mock exactly that
 * module: the real one calls the network. `ApiError` is the real class from lib/api.ts.
 */
vi.mock('@/lib/published-posts', () => ({ fetchAllPublishedPosts: vi.fn() }))

/**
 * NEWEST FIRST, with real descending timestamps rather than nulls.
 *
 * This is the shape the backend actually returns — verified against the running
 * service: item 0's publishedAt (…18:23:29.838073Z) is later than item 1's
 * (…18:23:29.802220Z) — and fetchAllPublishedPosts keeps that order. The dates are in the
 * fixture, not just the order, because the whole correctness question here is which array
 * direction is "earlier", and a fixture with no dates lets a reader of this test assume
 * either answer.
 */
const ORDER = ['moi-nhat', 'giua', 'cu-nhat'] as const

const posts = (slugs: readonly string[]): PostSummary[] =>
  slugs.map((slug, i) => ({
    id: `id-${slug}`,
    title: `Post ${slug}`,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 5,
    // Descending: index 0 is the most recently published.
    publishedAt: new Date(Date.UTC(2026, 8, 28, 12, 0, 0) - i * 86_400_000).toISOString(),
  }))

function stubAll(slugs: readonly string[]) {
  vi.mocked(fetchAllPublishedPosts).mockResolvedValue(posts(slugs))
}

afterEach(() => {
  vi.mocked(fetchAllPublishedPosts).mockReset()
})

describe('getAdjacentPosts', () => {
  it('asks for the posts of the language of the article only', async () => {
    stubAll(ORDER)

    await getAdjacentPosts('giua', 'en')

    expect(fetchAllPublishedPosts).toHaveBeenCalledWith('en')
  })

  it('reads the whole cached published list, once', async () => {
    stubAll(ORDER)

    await getAdjacentPosts('giua')

    // One read of the full list — the same request (URL, `posts` tag) that getDiscovery already made for
    // the post page, so Next merges them — replacing a separate `getPosts({ size: 50 })` page.
    expect(fetchAllPublishedPosts).toHaveBeenCalledTimes(1)
  })

  it('reads previous as the OLDER post and next as the NEWER one', async () => {
    stubAll(ORDER)

    const { previous, next } = await getAdjacentPosts('giua')

    // The listing is newest-first, so the array index runs backwards relative to
    // publication order. This is the one thing in the file that can be wrong while
    // everything renders: `items[index - 1]` as "previous" gives a pair of links that
    // march the reader forwards through time under a label that says backwards, and
    // every structural assertion in this suite still passes.
    expect(previous?.slug).toBe('cu-nhat')
    expect(next?.slug).toBe('moi-nhat')
    // Stated as dates too, so the claim is about time and not about array direction.
    expect(Date.parse(previous!.publishedAt!)).toBeLessThan(Date.parse(next!.publishedAt!))
  })

  it('gives the first post ever published no previous', async () => {
    stubAll(ORDER)

    // 'cu-nhat' is the oldest, and sits at the END of a newest-first array. `??  null`
    // is doing the work: `items[index + 1]` is `undefined` past the end, and an
    // `undefined` handed to PostNav renders nothing but typechecks as a PostSummary.
    const { previous, next } = await getAdjacentPosts('cu-nhat')

    expect(previous).toBeNull()
    expect(next?.slug).toBe('giua')
  })

  it('gives the most recent post no next', async () => {
    stubAll(ORDER)

    // Index 0, so `items[-1]` — which is `undefined` in JS rather than the last
    // element as it would be in Python. Pinned because the "wrap around" bug is a
    // real one in languages where that index is legal.
    const { previous, next } = await getAdjacentPosts('moi-nhat')

    expect(next).toBeNull()
    expect(previous?.slug).toBe('giua')
  })

  it('gives a lone post neither neighbour', async () => {
    stubAll(['chi-mot'])

    await expect(getAdjacentPosts('chi-mot')).resolves.toEqual({ previous: null, next: null })
  })

  it('the 60th post still has two neighbors: no more 50-post window', async () => {
    // PINNED AGAIN ON PURPOSE. Previously, this function read one page of the 50 newest posts (ADJACENCY_WINDOW), and
    // the test here pinned that limit: a post older than the 50th lost both buttons. Now it reads the full
    // list, so that "cliff" is gone — a blog of 80 posts can still continue from the oldest post.
    const slugs = Array.from({ length: 80 }, (_, i) => `bai-${i}`)
    stubAll(slugs)

    const { previous, next } = await getAdjacentPosts('bai-60')

    expect(previous?.slug).toBe('bai-61')
    expect(next?.slug).toBe('bai-59')
    // And the oldest of the 80 still has a "next post" link.
    await expect(getAdjacentPosts('bai-79')).resolves.toMatchObject({ previous: null, next: { slug: 'bai-78' } })
  })

  it('gives nothing for a post that is not in the published list', async () => {
    // A draft being previewed, or a cache that has not caught up with a fresh publish. The failure
    // mode must be "no links", never "links to the wrong posts" — `findIndex` returning -1 and
    // being used unchecked would make `items[0]` the "previous" of every missing post.
    stubAll(ORDER)

    await expect(getAdjacentPosts('khong-trong-danh-sach')).resolves.toEqual({
      previous: null,
      next: null,
    })
  })

  it('gives nothing instead of propagating a listing failure', async () => {
    vi.mocked(fetchAllPublishedPosts).mockRejectedValue(new ApiError(503, 'UPSTREAM', 'database is down'))

    // Same reasoning as RelatedPosts: `getPost` has already succeeded, the reader has
    // the article, and a listing outage is not a reason to replace it with an error.
    await expect(getAdjacentPosts('giua')).resolves.toEqual({ previous: null, next: null })
  })
})

describe('PostNav', () => {
  const post = (slug: string) => posts([slug])[0]!

  it('renders nothing when there is neither neighbour', () => {
    const { container } = render(<PostNav previous={null} next={null} />)

    // The first and only post on a new blog. An empty bordered strip is
    // indistinguishable from a broken one.
    expect(container).toBeEmptyDOMElement()
  })

  it('does not print: on paper the previous/next post cards lead nowhere', () => {
    render(<PostNav previous={post('cu')} next={post('moi')} />)

    expect(screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })).toHaveClass('print:hidden')
  })

  it('keeps the previous/next label on one line on a phone, so the card is not taller than its title', () => {
    render(<PostNav previous={post('cu')} next={post('moi')} />)

    const label = screen.getByText(msg('Site.postNav.previous'), { exact: false })
    expect(label).toHaveClass('block', 'max-sm:line-clamp-1')
  })

  it('is a named landmark holding both links', () => {
    render(<PostNav previous={post('cu')} next={post('moi')} />)

    // Named, because this document already has the header's nav and the article's
    // table of contents; an unnamed third nav is unusable in a landmark list.
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/posts/cu', '/posts/moi'])
  })

  it('a neighbour of the other language is linked under its own language prefix', () => {
    render(<PostNav previous={{ ...post('cu'), language: 'en' }} next={post('moi')} />)

    expect(screen.getByRole('link', { name: new RegExp('Post cu') })).toHaveAttribute('href', '/en/posts/cu')
    expect(screen.getByRole('link', { name: new RegExp('Post moi') })).toHaveAttribute('href', '/posts/moi')
  })

  it('labels each side and shows the neighbour title', () => {
    render(<PostNav previous={post('cu')} next={post('moi')} />)

    // The accessible name of each link is label + title, so a screen-reader user
    // hears which direction they are going. Two links reading only the bare titles
    // give no direction at all.
    expect(screen.getByRole('link', { name: `${msg('Site.postNav.previous')} Post cu` })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: `${msg('Site.postNav.next')} Post moi` })).toBeInTheDocument()
  })

  it('renders only the previous link when there is no next', () => {
    render(<PostNav previous={post('cu')} next={null} />)

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/posts/cu')
    expect(screen.queryByText(msg('Site.postNav.next'))).not.toBeInTheDocument()
  })

  it('renders only the next link when there is no previous, and keeps it on the right', () => {
    render(<PostNav previous={null} next={post('moi')} />)

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/posts/moi')
    expect(screen.queryByText(msg('Site.postNav.previous'))).not.toBeInTheDocument()

    // "and keeps it on the right" was in this test's name but asserted nowhere. With a
    // single link in a two-column grid, the default is column one — so a lone next link
    // would sit on the LEFT, where a reader looks for the previous post. `sm:col-start-2`
    // is what prevents that, and jsdom applies no CSS, so the class is the only channel a
    // unit test can inspect.
    expect(links[0]).toHaveClass('sm:col-start-2')
    expect(links[0]).toHaveClass('sm:text-right')
    // Class-name only — jsdom applies no Tailwind — but it is the one thing that
    // keeps a lone "next" card out of column 1, where it would read as "previous".
    expect(links[0].className).toMatch(/\bsm:col-start-2\b/)
  })

  it('percent-encodes a slug in each link', () => {
    render(<PostNav previous={post(DIACRITIC_POST_SLUG)} next={null} />)

    expect(screen.getByRole('link')).toHaveAttribute('href', `/posts/${encodeURIComponent(DIACRITIC_POST_SLUG)}`)
  })

  it('post in a series: follows the parts, labels "Previous part · {series}" / "Next part · {series}"', () => {
    render(
      <PostNav
        previous={post('cu')}
        next={post('moi')}
        series={{ title: 'Series A', previous: post('phan-1'), next: post('phan-3') }}
      />,
    )

    // Same landmark, same name: only the content changes with the series.
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/posts/phan-1', '/posts/phan-3'])
    expect(
      screen.getByRole('link', { name: msg('Site.postNav.previousPart', { title: 'Series A Post phan-1' }) }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: msg('Site.postNav.nextPart', { title: 'Series A Post phan-3' }) }),
    ).toBeInTheDocument()
    // The chronological neighbors are not mixed in: two ways of going in one nav are two different answers
    // to "what to read next".
    expect(screen.queryByText(msg('Site.postNav.previous'))).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Post cu/ })).not.toBeInTheDocument()
  })

  it('first part of a series: only "next part", no chronologically previous post to fill in', () => {
    render(
      <PostNav previous={post('cu')} next={post('moi')} series={{ title: 'Series A', previous: null, next: post('phan-2') }} />,
    )

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/posts/phan-2')
    // Alone on the right, like "next post".
    expect(links[0]).toHaveClass('sm:col-start-2')
  })

  it('a series with only one published part: falls back to chronological navigation', () => {
    render(<PostNav previous={post('cu')} next={post('moi')} series={{ title: 'Series A', previous: null, next: null }} />)

    // With no adjacent part the series nav is empty; the reader still needs a way onward.
    expect(screen.getByRole('link', { name: `${msg('Site.postNav.previous')} Post cu` })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: `${msg('Site.postNav.next')} Post moi` })).toBeInTheDocument()
    expect(screen.queryByText(PREVIOUS_PART_LABEL)).not.toBeInTheDocument()
  })

  it('puts the Container (gutter, measure) around the nav and keeps the nav named', () => {
    const { container } = render(<PostNav previous={post('cu')} next={null} />)
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })

    // Container takes no aria-label, so the landmark is the <nav> itself, inside the gutter: it
    // never loses its name, and its divider is as long as the text column and not as long as the window.
    expect(nav.className).not.toMatch(/\bpx-4\b/)
    const frame = container.firstElementChild
    expect(frame).toContainElement(nav)
    expect(frame?.className).toMatch(/\bpx-4\b/)
    expect(frame?.className).toMatch(/\bsm:px-6\b/)
    expect(frame?.className).toMatch(/\bmax-w-3xl\b/)
  })

  it("width='reader' and 'wide' set the frame measure", () => {
    const { container, rerender } = render(<PostNav previous={post('cu')} next={null} width="reader" />)
    expect(container.firstElementChild?.className).toContain('max-w-[87.5rem]')
    rerender(<PostNav previous={post('cu')} next={null} width="wide" />)
    expect(container.firstElementChild?.className).toMatch(/\bmax-w-5xl\b/)
  })

  it("width='bare' applies no Container classes: the nav is the root", () => {
    const { container } = render(<PostNav previous={post('cu')} next={post('moi')} width="bare" />)
    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })

    expect(container.firstElementChild).toBe(nav)
    expect(container.innerHTML).not.toMatch(/max-w-|px-4|sm:px-6|mx-auto/)
  })

  it('renders nothing with no neighbour, whatever the width', () => {
    const { container } = render(<PostNav previous={null} next={null} width="bare" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('PostNav: divider line and rhythm', () => {
  it.each(['prose', 'bare'] as const)('the nav carries the shared block rhythm, width=%s', (width) => {
    const post = (slug: string) => posts([slug])[0]!
    render(<PostNav previous={post('truoc')} next={post('sau')} width={width} />)

    const nav = screen.getByRole('navigation', { name: msg('Site.postNav.navLabel') })
    expect(nav).toHaveClass('border-t', 'border-neutral-200', 'py-8', 'sm:py-10', 'dark:border-neutral-800')
    expect(nav).toHaveClass('print:hidden')
    expect(nav.className).not.toMatch(/\bmt-/)
    // The divider is the nav's own, not a second rule inside it.
    expect(nav.querySelector('.border-t')).toBeNull()
  })

  it('the label is 13px on a phone and 12px from sm, the title 17px on a phone and 16px from sm, both with a tight leading', () => {
    const post = (slug: string) => posts([slug])[0]!
    render(<PostNav previous={post('truoc')} next={post('sau')} />)

    for (const link of screen.getAllByRole('link')) {
      const [label, title] = Array.from(link.querySelectorAll('span'))
      expect(label).toHaveClass('text-[0.8125rem]', 'leading-snug', 'sm:text-xs')
      expect(title).toHaveClass('text-[1.0625rem]', 'leading-snug', 'sm:text-base', 'sm:leading-normal')
    }
  })

  it('the default frame hides the whole block from print too', () => {
    const { container } = render(<PostNav previous={posts(['cu'])[0]!} next={null} />)
    expect(container.firstElementChild).toHaveClass('print:hidden')
  })
})
