import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BlogrollEntry } from '@/lib/site-content-types'
import type { Discovery, MonthBucket, TagCount } from '@/lib/discovery'
import { FEED_PATH } from '@/lib/site'
import type { PostSummary, SeriesSummary } from '@/lib/types'
import { glyphName } from '@/test/glyphs'
import { DiscoveryGrid } from './DiscoveryGrid'
import { msg } from '@/test/render-intl'
import { LONG_DATE_2026_10_05, MONTH_2025_12, MONTH_2026_10 } from '@/test/fixtures/vi/discovery-grid'

/*
 * DiscoveryGrid only displays: the "Most read" threshold, the maximum number of entries and excluding the post being read were already
 * decided by lib/discovery.ts (and tested there). Here we pin the spec table: which block exists in
 * which context, what each block looks like, and when the whole section disappears.
 */

function post(slug: string, over: Partial<PostSummary> = {}): PostSummary {
  return {
    id: `id-${slug}`,
    title: `Title ${slug}`,
    slug,
    excerpt: null,
    status: 'PUBLISHED',
    category: null,
    tags: [],
    featured: false,
    readingMinutes: 4,
    publishedAt: '2026-10-03T00:00:00Z',
    ...over,
  }
}

function series(n: number, over: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    id: `s${n}`,
    title: `Series ${n}`,
    slug: `series-${n}`,
    description: null,
    postCount: 3,
    readingMinutes: 27,
    latestPublishedAt: '2026-10-03T00:00:00Z',
    parts: [],
    ...over,
  }
}

function tagCount(n: number, count: number): TagCount {
  return { tag: { id: `t${n}`, name: `Tag ${n}`, slug: `tag-${n}` }, count }
}

function month(year: number, m: number, count: number): MonthBucket {
  return { year, month: m, count, posts: [] }
}

const EMPTY: Discovery = {
  popular: null,
  recent: null,
  series: null,
  seriesTotal: 0,
  tags: null,
  tagTotal: 0,
  months: null,
  blogroll: [],
}

/** Data for every block, as getDiscovery returns for /writing when every source has data. */
function full(over: Partial<Discovery> = {}): Discovery {
  return {
    popular: {
      kind: 'popular',
      posts: [post('nhieu-1', { viewCount: 2345 }), post('nhieu-2', { viewCount: 87 }), post('nhieu-3', { viewCount: 10 })],
    },
    recent: [post('moi-1', { publishedAt: '2026-10-05T00:00:00Z' }), post('moi-2')],
    series: [series(1), series(2)],
    seriesTotal: 2,
    tags: [tagCount(1, 7), tagCount(2, 2)],
    tagTotal: 2,
    months: [month(2026, 10, 7), month(2026, 9, 2), month(2025, 12, 1)],
    blogroll: [],
    ...over,
  }
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

/** The section's h3s, in order: exactly the list of blocks being shown. */
function widgetTitles(root: HTMLElement): string[] {
  return within(root)
    .queryAllByRole('heading', { level: 3 })
    .map((h) => h.textContent ?? '')
}

/** The block whose h3 is named `title`: the element wrapping that h3. */
function widget(root: HTMLElement, title: string): HTMLElement {
  return within(root).getByRole('heading', { level: 3, name: title }).parentElement as HTMLElement
}

describe('DiscoveryGrid', () => {
  it('is a region named by its h2, with the id on the h2', () => {
    render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

    const h2 = screen.getByRole('heading', { level: 2, name: msg('Site.writing.discoverTitle') })
    expect(h2).toHaveAttribute('id', 'kham-pha')
    expect(region(msg('Site.writing.discoverTitle'))).toContainElement(h2)
  })

  it('/writing: Most read, Series, Tags, Archive in the right order; no Recent, no Worth reading blogs when the blogroll is empty', () => {
    render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

    // `recent` has data but is not shown: on /writing the list itself is already the newest posts.
    expect(widgetTitles(region(msg('Site.writing.discoverTitle')))).toEqual([
      msg('Site.discovery.popular'),
      'Series',
      msg('Site.article.tagsLabel'),
      msg('Site.footer.links.archive'),
    ])
    expect(screen.queryByRole('heading', { name: msg('Site.discovery.recent') })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: msg('Site.discovery.blogroll') })).not.toBeInTheDocument()
  })

  it('/writing on a phone: series fold to 3, tags to 8 and months to 6 with CSS only; every entry stays in the markup for sm and up', () => {
    const data = full({
      series: [1, 2, 3, 4, 5].map((n) => series(n)),
      seriesTotal: 5,
      tags: Array.from({ length: 12 }, (_, i) => tagCount(i + 1, 12 - i)),
      tagTotal: 12,
      months: Array.from({ length: 9 }, (_, i) => month(2026, 9 - i, 1)),
    })
    render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={data} variant="writing" />)
    const root = region(msg('Site.writing.discoverTitle'))

    const hidden = (list: HTMLElement) =>
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.classList.contains('max-sm:hidden'))
    const seriesList = within(widget(root, 'Series')).getByRole('list')
    expect(hidden(seriesList)).toEqual([false, false, false, true, true])
    // Rows with a meta line keep 12px above and below it, so the meta line does not touch the hairline.
    expect(seriesList).toHaveClass('max-sm:[&>li]:py-3')
    const tagList = within(widget(root, msg('Site.article.tagsLabel'))).getByRole('list')
    expect(hidden(tagList)).toEqual([...Array(8).fill(false), ...Array(4).fill(true)])
    const monthList = within(widget(root, msg('Site.footer.links.archive'))).getByRole('list')
    expect(hidden(monthList)).toEqual([...Array(6).fill(false), ...Array(3).fill(true)])
  })

  it('post page: only Most read and Recent, even when the data has series, tags, months and a blogroll', () => {
    const blogroll: BlogrollEntry[] = [{ name: 'Blog A', url: 'https://a.example/' }]
    render(
      <DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full({ blogroll })} variant="article" />,
    )

    // A tags block is absent from the post page because the post page test pins that each tag link is unique.
    expect(widgetTitles(region(msg('Site.article.readNextTitle')))).toEqual([
      msg('Site.discovery.popular'),
      msg('Site.discovery.recent'),
    ])
    expect(screen.queryByRole('link', { name: /Tag 1/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Blog A' })).not.toBeInTheDocument()
  })

  it('each block has its own icon, aria-hidden, inside the h3 but not part of its name', () => {
    const blogroll: BlogrollEntry[] = [{ name: 'Blog A', url: 'https://a.example/' }]
    const { unmount } = render(
      <DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full({ blogroll })} variant="writing" />,
    )

    const glyphs = Object.fromEntries(
      screen.getAllByRole('heading', { level: 3 }).map((h) => {
        const svg = h.querySelector('svg')
        expect(svg, h.textContent ?? '').toHaveAttribute('aria-hidden', 'true')
        return [h.textContent, glyphName(svg)]
      }),
    )
    expect(glyphs).toEqual({
      [msg('Site.discovery.popular')]: 'TrendingUpIcon',
      Series: 'LayersIcon',
      [msg('Site.discovery.tags')]: 'TagsIcon',
      [msg('Site.discovery.archive')]: 'ArchiveIcon',
      [msg('Site.discovery.blogroll')]: 'LinkIcon',
    })
    unmount()

    render(<DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full()} variant="article" />)
    expect(glyphName(screen.getByRole('heading', { name: msg('Site.discovery.recent') }).querySelector('svg'))).toBe(
      'PenLineIcon',
    )
  })

  describe('on a phone', () => {
    it('the lists of the band of a post are hairline-separated rows with 44px link rows below sm, the plain list from sm', () => {
      const { container } = render(
        <DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full()} variant="article" />,
      )

      // The lists of the blocks, not the row of the two exits under them.
      const lists = container.querySelectorAll('.grid ol, .grid ul')
      expect(lists.length).toBeGreaterThan(0)
      for (const list of lists) {
        expect(list.className, list.outerHTML).toContain('divide-y')
        expect(list.className).toContain('max-sm:[&>li>a]:min-h-11')
        // The link row is a flex box on a phone: only `anywhere` lets a long unbroken title wrap there (`break-words` leaves its minimum
        // width at the whole word and the page scrolls sideways).
        expect(list.className).toContain('max-sm:[&>li>a]:[overflow-wrap:anywhere]')
        expect(list.className).toContain('sm:divide-y-0')
      }
      expect(container.querySelector('section')).toHaveClass('py-8', 'sm:py-10')
    })

    it('the lists of the /writing band wrap a long unbroken title in their link rows', () => {
      const { container } = render(
        <DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />,
      )

      // The tag pills are not link rows: only the lists that turn their links into flex rows need the wrapping rule.
      const rows = [...container.querySelectorAll('.grid ol, .grid ul')].filter((list) =>
        list.className.includes('max-sm:[&>li>a]:flex'),
      )
      expect(rows.length).toBeGreaterThan(0)
      for (const list of rows) expect(list.className, list.outerHTML).toContain('max-sm:[&>li>a]:[overflow-wrap:anywhere]')
    })
  })

  describe('Most read / Read first', () => {
    it('Most read: an ordered list, each post with a view count formatted in vi-VN that a screen reader can read', () => {
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

      const block = widget(region(msg('Site.writing.discoverTitle')), msg('Site.discovery.popular'))
      const items = within(block).getAllByRole('listitem')
      expect(block.querySelector('ol')).not.toBeNull()
      expect(items).toHaveLength(3)

      expect(within(items[0]!).getByRole('link', { name: 'Title nhieu-1' })).toHaveAttribute('href', '/posts/nhieu-1')
      // "2.345", not "2345" or "2,345"; and the " views" label is hidden from the eye but present in the text,
      // so the number does not stand alone when listened to.
      expect(items[0]).toHaveTextContent(`Title nhieu-1 2.345 ${msg('Site.discovery.viewsUnit', { count: 2345 })}`)
      expect(items[0]!.querySelector('.sr-only')).toHaveTextContent(msg('Site.discovery.viewsUnit', { count: 2345 }))
      expect(items[2]).toHaveTextContent(`10 ${msg('Site.discovery.viewsUnit', { count: 10 })}`)
      // No "Best posts" link in this branch: that is the exit of the curated branch.
      expect(within(block).queryByRole('link', { name: new RegExp(msg('Site.discovery.fullList')) })).not.toBeInTheDocument()
    })

    it('Read first: Star icon, posts by rank, no view count, a link to /start-here', () => {
      const data = full({ popular: { kind: 'recommended', posts: [post('hay-1'), post('hay-2')] } })
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={data} variant="writing" />)

      expect(screen.queryByRole('heading', { name: msg('Site.discovery.popular') })).not.toBeInTheDocument()
      const heading = screen.getByRole('heading', { level: 3, name: msg('Site.startHere.readFirst') })
      expect(glyphName(heading.querySelector('svg'))).toBe('StarIcon')

      const block = widget(region(msg('Site.writing.discoverTitle')), msg('Site.startHere.readFirst'))
      expect(
        within(block)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual(['Title hay-1', 'Title hay-2'])
      expect(block).not.toHaveTextContent(msg('Site.discovery.viewsUnit', { count: 2345 }))
      expect(within(block).getByRole('link', { name: msg('Site.discovery.fullList') })).toHaveAttribute('href', '/start-here')
    })
  })

  describe('Series', () => {
    it('each series has a link to its page, with "n parts · m minutes of reading"', () => {
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

      const block = widget(region(msg('Site.writing.discoverTitle')), 'Series')
      expect(within(block).getByRole('link', { name: 'Series 1' })).toHaveAttribute('href', '/series/series-1')
      expect(within(block).getAllByRole('listitem')[0]).toHaveTextContent(
        msg('Site.discovery.seriesPartsWithTime', { parts: 3, minutes: 27 }),
      )
    })

    it('more than 5 series: shows 5 and an "All series" link; with 5 or fewer there is no such link', () => {
      const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => series(n))
      const { unmount } = render(
        <DiscoveryGrid
          id="kham-pha"
          title={msg('Site.writing.discoverTitle')}
          data={full({ series: seven, seriesTotal: 7 })}
          variant="writing"
        />,
      )

      let block = widget(region(msg('Site.writing.discoverTitle')), 'Series')
      expect(within(block).getAllByRole('listitem')).toHaveLength(5)
      expect(within(block).getByRole('link', { name: msg('Site.discovery.allSeries') })).toHaveAttribute('href', '/series')
      unmount()

      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)
      block = widget(region(msg('Site.writing.discoverTitle')), 'Series')
      expect(within(block).getAllByRole('listitem')).toHaveLength(2)
      expect(within(block).queryByRole('link', { name: msg('Site.discovery.allSeries') })).not.toBeInTheDocument()
    })
  })

  describe('Tags', () => {
    it('chip links by slug, the post count shown as a number and read as "n posts"', () => {
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

      const chip = screen.getByRole('link', { name: `Tag 1 7 ${msg('Site.discovery.postsUnit', { count: 7 })}` })
      expect(chip).toHaveAttribute('href', '/tags/tag-1')
      // The word for "posts" is only for screen readers; the eye sees the number next to the tag name.
      expect(chip.querySelector('.sr-only')).toHaveTextContent(msg('Site.discovery.postsUnit', { count: 7 }))
      expect(screen.getByRole('link', { name: `Tag 2 2 ${msg('Site.discovery.postsUnit', { count: 2 })}` })).toHaveAttribute(
        'href',
        '/tags/tag-2',
      )
    })

    it('the post count in the chip is neutral-600: neutral-500 on the neutral-100 chip background is only 4.35:1', () => {
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

      const count = screen
        .getByRole('link', { name: `Tag 1 7 ${msg('Site.discovery.postsUnit', { count: 7 })}` })
        .querySelector('.tabular-nums')!
      expect(count).toHaveClass('text-neutral-600', 'dark:text-neutral-400')
      expect(count).not.toHaveClass('text-neutral-500')
    })

    it('at most 20 tags, always an "All topics" link to /topics', () => {
      const tags = Array.from({ length: 23 }, (_, i) => tagCount(i, 30 - i))
      render(
        <DiscoveryGrid
          id="kham-pha"
          title={msg('Site.writing.discoverTitle')}
          data={full({ tags, tagTotal: 23 })}
          variant="writing"
        />,
      )

      const block = widget(region(msg('Site.writing.discoverTitle')), msg('Site.article.tagsLabel'))
      expect(
        within(block).getAllByRole('link', {
          name: new RegExp(`^Tag \\d+ \\d+ ${msg('Site.discovery.postsUnit', { count: 7 })}$`),
        }),
      ).toHaveLength(20)
      expect(within(block).getByRole('link', { name: msg('Site.discovery.allTopics') })).toHaveAttribute('href', '/topics')
    })
  })

  describe('Archive', () => {
    it('one link per month to the right section of the archive page, the newest year carries no ?year', () => {
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />)

      const block = widget(region(msg('Site.writing.discoverTitle')), msg('Site.footer.links.archive'))
      // The newest year is the default /archive page (the canonical has no ?year); an older year must carry
      // ?year, otherwise the #thang-2025-12 section does not exist on that page.
      expect(within(block).getByRole('link', { name: MONTH_2026_10 })).toHaveAttribute('href', '/archive#thang-2026-10')
      expect(within(block).getByRole('link', { name: MONTH_2025_12 })).toHaveAttribute('href', '/archive?year=2025#thang-2025-12')
      expect(within(block).getAllByRole('listitem')[0]).toHaveTextContent(
        `${MONTH_2026_10} 7 ${msg('Site.discovery.postsUnit', { count: 7 })}`,
      )
      // The number sits right after the label, not pushed to the right edge of the column.
      expect(within(block).getAllByRole('listitem')[0]).not.toHaveClass('justify-between')
      expect(within(block).getByRole('link', { name: msg('Site.discovery.fullArchive') })).toHaveAttribute('href', '/archive')
    })

    it('at most 12 months', () => {
      const months = Array.from({ length: 15 }, (_, i) => month(2026 - Math.floor(i / 12), 12 - (i % 12), 1))
      render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full({ months })} variant="writing" />)

      expect(
        within(widget(region(msg('Site.writing.discoverTitle')), msg('Site.footer.links.archive'))).getAllByRole('listitem'),
      ).toHaveLength(12)
    })
  })

  it('Worth reading blogs: an empty blogroll gives no block; with entries, external links with a note', () => {
    const { unmount } = render(
      <DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />,
    )
    expect(screen.queryByRole('heading', { name: msg('Site.discovery.blogroll') })).not.toBeInTheDocument()
    unmount()

    const blogroll: BlogrollEntry[] = [
      { name: 'Blog A', url: 'https://a.example/', note: 'Writes carefully about systems.' },
      { name: 'Blog B', url: 'https://b.example/' },
    ]
    render(<DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full({ blogroll })} variant="writing" />)

    const block = widget(region(msg('Site.writing.discoverTitle')), msg('Site.discovery.blogroll'))
    expect(within(block).getByRole('link', { name: 'Blog A' })).toHaveAttribute('href', 'https://a.example/')
    expect(within(block).getByRole('link', { name: 'Blog B' })).toHaveAttribute('href', 'https://b.example/')
    expect(block).toHaveTextContent('Writes carefully about systems.')
  })

  it('Recent (post page): the title and date in <time> carry the original ISO', () => {
    render(<DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full()} variant="article" />)

    const block = widget(region(msg('Site.article.readNextTitle')), msg('Site.discovery.recent'))
    expect(within(block).getByRole('link', { name: 'Title moi-1' })).toHaveAttribute('href', '/posts/moi-1')
    const time = block.querySelector('time')
    expect(time).toHaveAttribute('dateTime', '2026-10-05T00:00:00Z')
    expect(time).toHaveTextContent(LONG_DATE_2026_10_05)
  })

  it('footer row: random read is an <a rel="nofollow"> to /random, and RSS', () => {
    for (const variant of ['writing', 'article'] as const) {
      const { unmount } = render(<DiscoveryGrid id="x" title="X" data={full()} variant={variant} />)

      expect(screen.getByRole('link', { name: msg('Site.discovery.randomPost') }), variant).toHaveAttribute('href', '/random')
      expect(screen.getByRole('link', { name: msg('Site.discovery.randomPost') }), variant).toHaveAttribute('rel', 'nofollow')
      expect(screen.getByRole('link', { name: msg('Site.discovery.followRss') }), variant).toHaveAttribute('href', FEED_PATH)
      unmount()
    }
  })

  it('every block empty renders nothing, including the footer row and the title', () => {
    for (const variant of ['writing', 'article'] as const) {
      const { container, unmount } = render(<DiscoveryGrid id="x" title="X" data={EMPTY} variant={variant} />)
      expect(container, variant).toBeEmptyDOMElement()
      unmount()
    }

    // Data that only exists in a block this context does not show also counts as "empty" for that context.
    const onlyRecent = { ...EMPTY, recent: [post('moi-1')] }
    const { container } = render(<DiscoveryGrid id="x" title="X" data={onlyRecent} variant="writing" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('one block with data left: the section still shows, with only that block', () => {
    render(
      <DiscoveryGrid
        id="kham-pha"
        title={msg('Site.writing.discoverTitle')}
        data={{ ...EMPTY, months: [month(2026, 10, 3)] }}
        variant="writing"
      />,
    )

    expect(widgetTitles(region(msg('Site.writing.discoverTitle')))).toEqual([msg('Site.footer.links.archive')])
    expect(screen.getByRole('link', { name: msg('Site.discovery.randomPost') })).toBeInTheDocument()
  })

  it('not printed, on both /writing and at the end of a post: navigation to other posts, not content', () => {
    const { unmount } = render(
      <DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />,
    )
    expect(region(msg('Site.writing.discoverTitle'))).toHaveClass('print:hidden')
    unmount()

    render(<DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full()} variant="article" />)
    expect(region(msg('Site.article.readNextTitle'))).toHaveClass('print:hidden')
  })

  it('defaults to the frame width (reader, max-w-[87.5rem]) for both variants', () => {
    const { unmount } = render(
      <DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" />,
    )
    const writing = region(msg('Site.writing.discoverTitle'))
    expect(writing.className).toContain('max-w-[87.5rem]')
    expect(writing.className).not.toContain('max-w-5xl')
    unmount()

    render(<DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full()} variant="article" />)
    const article = region(msg('Site.article.readNextTitle'))
    expect(article.className).toContain('max-w-[87.5rem]')
    expect(article.className).not.toContain('max-w-3xl')
  })

  it("an explicit width='reader' gives the 1400px frame width (max-w-[87.5rem])", () => {
    const { unmount } = render(
      <DiscoveryGrid id="doc-gi-tiep" title={msg('Site.article.readNextTitle')} data={full()} variant="article" width="reader" />,
    )
    const grid = region(msg('Site.article.readNextTitle'))
    expect(grid.className).toContain('max-w-[87.5rem]')
    expect(grid.className).not.toContain('max-w-3xl')
    expect(grid.className).not.toContain('max-w-6xl')
    unmount()

    render(
      <DiscoveryGrid id="kham-pha" title={msg('Site.writing.discoverTitle')} data={full()} variant="writing" width="reader" />,
    )
    expect(region(msg('Site.writing.discoverTitle')).className).toContain('max-w-[87.5rem]')
  })
})
