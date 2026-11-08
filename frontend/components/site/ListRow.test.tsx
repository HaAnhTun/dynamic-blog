import { render, screen, within } from '@testing-library/react'
import Link from 'next/link'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaRef, PostSummary, SeriesRef } from '@/lib/types'
import { glyphName, glyphNames } from '@/test/glyphs'
import { ListRow } from './ListRow'
import { MEASURE } from './reader/reader-layout'
import { msg } from '@/test/render-intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'
import {
  HL_CATEGORY,
  HL_EXCERPT,
  HL_EXCERPT_MARKS,
  HL_HTML_TITLE,
  HL_OTHER_TITLE,
  HL_SERIES,
  HL_SHORT_TITLE,
  HL_SLUG,
  HL_TAG,
  HL_TITLE,
  HL_TITLE_MARKS,
} from '@/test/fixtures/vi/list-row-highlight'

/**
 * ListRow is the only primitive for a post row: /writing, category, tag, search,
 * home page, related posts, then /start-here and series.
 *
 * next/link is the real one, only wrapped with vi.fn to read back the `prefetch` prop — that prop does not
 * reach the DOM, so there is no other way to see whether the thumbnail link turns prefetch off.
 */
vi.mock('next/link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/link')>()
  const { createElement } = await import('react')
  const Real = actual.default
  return {
    ...actual,
    default: vi.fn((props: ComponentProps<typeof Real>) => createElement(Real, props)),
  }
})

const SERIES: SeriesRef = {
  id: 's1',
  slug: 'async-pipeline-on-aws',
  title: 'Series B',
  position: 2,
  partNumber: 2,
  partCount: 3,
}

const COVER: MediaRef = {
  id: '0b6f4e2a-9c1d-4e7f-a3b5-c6d7e8f90a1b',
  fileName: '0b6f4e2a-9c1d-4e7f-a3b5-c6d7e8f90a1b.png',
  width: 1200,
  height: 800,
  altText: 'Three boxes joined by arrows',
  dominantColor: '#334455',
}

const PART_WORD = msg('Site.listing.partLabel', { number: '2', total: '3' }).split(' ')[0]!
const READING_SUFFIX = msg('Site.article.readingTime', { minutes: '9' }).replace(/^9 /, '')

const TITLE = 'From API Gateway to SQS: why the request path must be async'
const SLUG = 'from-api-gateway-to-sqs-why-i-chose-async'
const HREF = `/posts/${SLUG}`

const post = (extra: Partial<PostSummary> = {}): PostSummary => ({
  id: 'p1',
  title: TITLE,
  slug: SLUG,
  excerpt: null,
  status: 'PUBLISHED',
  category: { id: 'c1', name: 'Architecture', slug: 'architecture', description: null },
  tags: [],
  // 18:23Z is already the 4th in Asia/Ho_Chi_Minh (the timezone vitest pins): the displayed date must be the 3rd.
  publishedAt: '2026-10-03T18:23:29.838073Z',
  featured: false,
  readingMinutes: 9,
  ...extra,
})

const classesOf = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/** Every <a> pointing to the post, including links hidden from the accessibility tree. */
const anchorsToPost = (root: ParentNode) => Array.from(root.querySelectorAll(`a[href="${HREF}"]`))

/** Thumbnail link: the link to the post that is not the title link. */
function thumbnailLink(container: HTMLElement): HTMLAnchorElement {
  const title = screen.getByRole('link', { name: TITLE })
  const others = anchorsToPost(container).filter((a) => a !== title)
  expect(others).toHaveLength(1)
  return others[0] as HTMLAnchorElement
}

afterEach(() => {
  vi.mocked(Link).mockClear()
})

describe('ListRow — links and heading', () => {
  it('the title anchor is a 45px hit area below sm that does not change the row height, and the thumbnail narrows to 6rem under 400px', () => {
    const { container } = render(<ListRow post={post()} headingLevel={2} />)

    expect(screen.getByRole('link', { name: TITLE })).toHaveClass('max-sm:inline-block', 'max-sm:py-2.5', 'max-sm:-my-2.5')
    expect(container.querySelector('article')).toHaveClass('max-[400px]:grid-cols-[minmax(0,1fr)_6rem]')
  })

  it('the title is the only accessible link to the post; the thumbnail is a hidden copy, outside the tab order', () => {
    const { container } = render(<ListRow post={post()} headingLevel={2} />)

    // Exactly one link carrying the title name, and exactly one link to the post in the accessibility tree: keyboard
    // and screen reader users still get one stop per post as before.
    expect(screen.getAllByRole('link', { name: TITLE })).toHaveLength(1)
    expect(screen.getByRole('link', { name: TITLE })).toHaveAttribute('href', HREF)
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href') === HREF)).toHaveLength(1)

    // The "present" pair: the DOM has TWO <a> to the post. The second is the thumbnail, clickable with the mouse
    // but aria-hidden and tabindex=-1, so the assert above does not count it.
    expect(anchorsToPost(container)).toHaveLength(2)
    const thumb = thumbnailLink(container)
    expect(thumb).toHaveAttribute('aria-hidden', 'true')
    expect(thumb).toHaveAttribute('tabindex', '-1')
    expect(thumb.textContent).toBe('')
    expect(thumb.querySelector('svg.cover-art')).not.toBeNull()
  })

  it('the thumbnail link turns prefetch off, the title link keeps the default', () => {
    render(<ListRow post={post()} headingLevel={2} />)

    const calls = vi.mocked(Link).mock.calls.map(([props]) => props as unknown as Record<string, unknown>)
    const toPost = calls.filter((p) => p.href === HREF)
    expect(toPost).toHaveLength(2)
    const hidden = (p: Record<string, unknown>) => String(p['aria-hidden']) === 'true'
    // Two links with the same URL: prefetching twice means two viewport observations for one job.
    expect(toPost.filter(hidden)).toHaveLength(1)
    expect(toPost.find(hidden)?.prefetch).toBe(false)
    expect(toPost.find((p) => !hidden(p))?.prefetch).toBeUndefined()
  })

  it('the heading level is decided by the caller: h2 on a list page, h3 under a section', () => {
    const h2 = render(<ListRow post={post()} headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
    h2.unmount()

    render(<ListRow post={post()} headingLevel={3} />)
    expect(screen.getByRole('heading', { level: 3, name: TITLE })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it('encodes the slug in the href', () => {
    render(<ListRow post={post({ slug: HL_SLUG, title: msg('Site.about.readNextLinks.writing') })} headingLevel={2} />)

    expect(screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') })).toHaveAttribute(
      'href',
      `/posts/${encodeURIComponent(HL_SLUG)}`,
    )
  })
})

describe('ListRow — kicker series', () => {
  it('post in a series: the <div> has [Layers], the series name is truncated, "Part 2/3" is never truncated', () => {
    const { container } = render(<ListRow post={post({ series: SERIES })} headingLevel={2} />)

    const name = screen.getByText(SERIES.title)
    const kicker = name.closest('div')!
    // <div>, not <p>: a row without an excerpt must not have any <p> (PostList.test).
    expect(kicker.tagName).toBe('DIV')
    expect(container.querySelector('p')).toBeNull()
    expect(glyphNames(kicker)).toEqual(['LayersIcon'])

    // Only the series name is truncated: the `truncate` span does not contain the part number...
    expect(name.tagName).toBe('SPAN')
    expect(classesOf(name)).toEqual(expect.arrayContaining(['block', 'truncate']))
    expect(name.textContent).not.toContain(PART_WORD)
    // ...and the name is a link to the series page, able to shrink (min-w-0) to make room for the part number.
    const seriesLink = name.closest('a')!
    expect(seriesLink).toHaveAttribute('href', `/series/${SERIES.slug}`)
    expect(classesOf(seriesLink)).toContain('min-w-0')
    expect(screen.getByRole('link', { name: SERIES.title })).toBe(seriesLink)

    // The part number sits outside the truncated area, does not shrink and does not wrap: at 320px a long series name is
    // cut down to a few letters, but "Part 2/3" is always readable.
    const part = screen.getByText(msg('Site.listing.partLabel', { number: '2', total: '3' }))
    expect(part.tagName).toBe('SPAN')
    expect(classesOf(part)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']))
    expect(name.contains(part)).toBe(false)
    expect(kicker.contains(part)).toBe(true)
    expect(classesOf(kicker)).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'items-center']))
  })

  it('the "·" dot is its own flex item, with the same gap-1.5 on both sides; textContent still reads "· Part 2/3"', () => {
    render(<ListRow post={post({ series: SERIES })} headingLevel={2} />)

    const kicker = screen.getByText(SERIES.title).closest('div')!
    const dot = within(kicker).getByText('·')
    // Previous version: "· " shared a span with the part number — a 6px gap before the dot, ~3.5px after.
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot.parentElement).toBe(kicker)
    expect(dot.textContent).toBe('·')
    expect(dot.nextElementSibling).toBe(screen.getByText(msg('Site.listing.partLabel', { number: '2', total: '3' })))
    expect(kicker.textContent).toContain(`· ${msg('Site.listing.partLabel', { number: '2', total: '3' })}`)
    expect(classesOf(kicker)).toContain('gap-1.5')
  })

  it('the series name link enlarges its tap target, except the bottom edge: the post title is only 4px away', () => {
    render(<ListRow post={post({ series: SERIES })} headingLevel={2} />)

    const seriesLink = screen.getByRole('link', { name: SERIES.title })
    expect(classesOf(seriesLink)).toEqual(
      expect.arrayContaining(['relative', 'after:absolute', 'after:-inset-x-1.5', 'after:-top-2.5', 'after:-bottom-1']),
    )
  })

  it('the kicker sits above the title, in the same cell as it', () => {
    render(<ListRow post={post({ series: SERIES })} headingLevel={2} />)

    const heading = screen.getByRole('heading', { level: 2, name: TITLE })
    const kicker = screen.getByText(SERIES.title).closest('div')!
    expect(kicker.parentElement).toBe(heading.parentElement)
    expect(kicker.nextElementSibling).toBe(heading)
  })

  it('missing partNumber or partCount: the number part is dropped, the series name stays', () => {
    for (const series of [
      { ...SERIES, partNumber: null, partCount: null },
      { ...SERIES, partNumber: 2, partCount: null },
      { ...SERIES, partNumber: null, partCount: 3 },
    ]) {
      const { container, unmount } = render(<ListRow post={post({ series })} headingLevel={2} />)
      const label = JSON.stringify([series.partNumber, series.partCount])

      // "Part n/m" is built only from these two fields, never from `position` (which may have gaps).
      expect(container.textContent, label).not.toContain(PART_WORD)
      expect(container.textContent, label).not.toContain(`${series.position}/`)
      // The "present" pair: the series name is still there.
      expect(screen.getByText(SERIES.title)).toBeInTheDocument()
      unmount()
    }
  })

  it('a post not in a series: no kicker, the heading is first in the cell', () => {
    const { container } = render(<ListRow post={post({ series: null })} headingLevel={2} />)

    const heading = screen.getByRole('heading', { level: 2, name: TITLE })
    expect(heading.parentElement?.firstElementChild).toBe(heading)
    expect(glyphNames(container)).not.toContain('LayersIcon')
    expect(container.querySelector('a[href^="/series/"]')).toBeNull()
    // `series` entirely absent on the old fixture (an optional field): same result.
    const legacy = post()
    delete legacy.series
    const again = render(<ListRow post={legacy} headingLevel={2} />)
    expect(glyphNames(again.container)).not.toContain('LayersIcon')
  })

  it('a passed-in kicker replaces the series kicker; null drops it entirely', () => {
    const custom = render(
      <ListRow post={post({ series: SERIES })} headingLevel={2} kicker={msg('Site.series.part', { number: '1' })} />,
    )
    const label = screen.getByText(msg('Site.series.part', { number: '1' }))
    expect(label.tagName).toBe('DIV')
    expect(label.nextElementSibling).toBe(screen.getByRole('heading', { level: 2 }))
    // Replaces, not adds: the default series kicker is gone.
    expect(screen.queryByText(SERIES.title)).not.toBeInTheDocument()
    expect(custom.container.querySelector('a[href^="/series/"]')).toBeNull()
    custom.unmount()

    const none = render(<ListRow post={post({ series: SERIES })} headingLevel={2} kicker={null} />)
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.parentElement?.firstElementChild).toBe(heading)
    expect(screen.queryByText(SERIES.title)).not.toBeInTheDocument()
    expect(glyphNames(none.container)).not.toContain('LayersIcon')
  })
})

describe('ListRow — meta', () => {
  it('[CalendarDays] beside <time> (not inside), [Folder] in the category link, [Clock] beside the reading time', () => {
    const { container } = render(<ListRow post={post()} headingLevel={2} />)

    const time = container.querySelector('time')!
    expect(time).toHaveAttribute('dateTime', '2026-10-03T18:23:29.838073Z')
    expect(time.textContent).toBe(LONG_DATE_VI(3, 10, 2026))
    // An icon is never inside <time>: the textContent above is the date itself.
    expect(time.querySelector('svg')).toBeNull()
    expect(glyphName(time.previousElementSibling)).toBe('CalendarDaysIcon')

    const category = screen.getByRole('link', { name: 'Architecture' })
    expect(category).toHaveAttribute('href', '/categories/architecture')
    expect(glyphNames(category)).toEqual(['FolderIcon'])

    const minutes = screen.getByText(msg('Site.article.readingTime', { minutes: '9' }))
    expect(glyphNames(minutes)).toEqual(['ClockIcon'])

    // Reading order: date, category, time. Every icon is aria-hidden.
    const row = time.closest('div')!
    expect(glyphNames(row)).toEqual(['CalendarDaysIcon', 'FolderIcon', 'ClockIcon'])
    for (const svg of row.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('focusable', 'false')
    }
  })

  it('showCategory={false}: no category link, the date and reading time remain', () => {
    const { container } = render(<ListRow post={post()} headingLevel={2} showCategory={false} />)

    expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument()
    expect(screen.queryByText('Architecture')).not.toBeInTheDocument()
    expect(glyphNames(container)).not.toContain('FolderIcon')
    // The "present" pair: the rest of the meta row is still there.
    expect(container.querySelector('time')?.textContent).toBe(LONG_DATE_VI(3, 10, 2026))
    expect(screen.getByText(msg('Site.article.readingTime', { minutes: '9' }))).toBeInTheDocument()
  })

  it('with nothing to record there is no meta row, and no orphan icon', () => {
    const { container } = render(
      <ListRow post={post({ publishedAt: null, category: null, readingMinutes: 0 })} headingLevel={2} />,
    )

    expect(container.querySelector('time')).toBeNull()
    expect(container.textContent).not.toContain(READING_SUFFIX)
    expect(glyphNames(container)).toEqual([])
    // Two cells: the title and the thumbnail. An empty meta row still takes its margin.
    expect(container.querySelector('article')?.children).toHaveLength(2)

    // The "present" pair: the same post with a date gets the meta row as the third cell.
    const full = render(<ListRow post={post()} headingLevel={2} />)
    expect(full.container.querySelector('article')?.children).toHaveLength(3)
  })

  it('a broken date leaves no empty <time> beside the calendar icon', () => {
    const { container } = render(<ListRow post={post({ publishedAt: 'not-a-date' })} headingLevel={2} />)

    expect(container.querySelector('time')).toBeNull()
    expect(glyphNames(container)).not.toContain('CalendarDaysIcon')
    expect(screen.getByText(msg('Site.article.readingTime', { minutes: '9' }))).toBeInTheDocument()
  })
})

describe('ListRow — excerpt', () => {
  const EXCERPT = 'A synchronous request path keeps the connection open for the whole processing time.'

  it('with an excerpt: one <p> with the MEASURE cap, clamped to three lines below 640px', () => {
    const { container } = render(<ListRow post={post({ excerpt: EXCERPT })} headingLevel={2} />)

    const p = screen.getByText(EXCERPT)
    expect(p.tagName).toBe('P')
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(classesOf(p)).toEqual(
      expect.arrayContaining([MEASURE, 'line-clamp-2', 'sm:line-clamp-none', 'text-[0.9375rem]', 'sm:text-base']),
    )
  })

  it('no excerpt (null, empty, whitespace only) or showExcerpt={false}: no <p>', () => {
    for (const excerpt of [null, '', '   ']) {
      const { container, unmount } = render(<ListRow post={post({ excerpt })} headingLevel={2} />)
      expect(container.querySelector('p'), JSON.stringify(excerpt)).toBeNull()
      unmount()
    }

    const { container } = render(<ListRow post={post({ excerpt: EXCERPT })} headingLevel={2} showExcerpt={false} />)
    expect(container.querySelector('p')).toBeNull()
    expect(screen.queryByText(EXCERPT)).not.toBeInTheDocument()
  })
})

describe('ListRow — server Segment[]', () => {
  const seg = (text: string, match = false) => ({ text, match })

  it('highlights by the segments the server returns; the snippet replaces the excerpt; segments that do not reassemble into the title keep the title (link name unchanged)', () => {
    const { container, unmount } = render(
      <ListRow
        post={post({ excerpt: 'Original excerpt.' })}
        headingLevel={2}
        query="sqs"
        titleSegments={[seg('From API Gateway to '), seg('SQS', true), seg(': why the request path must be async')]}
        excerptSegments={[seg('…pushed into '), seg('SQS', true), seg(' then answers 202…')]}
      />,
    )
    expect(Array.from(container.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['SQS', 'SQS'])
    expect(screen.getByRole('link', { name: TITLE })).toHaveAttribute('href', HREF)
    expect(container.querySelector('p')).toHaveTextContent('…pushed into SQS then answers 202…')
    expect(screen.queryByText('Original excerpt.')).not.toBeInTheDocument()
    unmount()

    render(<ListRow post={post()} headingLevel={2} titleSegments={[seg('Other title '), seg('segments', true)]} />)
    expect(screen.getByRole('link', { name: TITLE })).toBeInTheDocument()
  })

  it('text in a segment is text, never HTML', () => {
    const evil = '<img src=x onerror="alert(1)">'
    const { container } = render(
      <ListRow post={post({ title: evil })} headingLevel={2} titleSegments={[seg(evil, true)]} excerptSegments={[seg(evil)]} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('mark')).toHaveTextContent(evil)
    expect(container.querySelector('p')).toHaveTextContent(evil)
  })
})

describe('ListRow — tags', () => {
  const TAGS = [
    { id: 't1', name: 'Lessons', slug: 'lessons' },
    { id: 't2', name: 'CI/CD', slug: 'ci-cd' },
  ]

  it('with tags: the Tag glyph comes first, OUTSIDE the <ul aria-label="Tags">; chip links by slug', () => {
    render(<ListRow post={post({ tags: TAGS })} headingLevel={2} />)

    const list = screen.getByRole('list', { name: msg('Site.article.tagsLabel') })
    // Outside the <ul>: the list holds only the tag items, so the read-out item count is still the tag count.
    expect(list.querySelector('svg')).toBeNull()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(glyphName(list.previousElementSibling)).toBe('TagIcon')
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/tags/lessons', '/tags/ci-cd'])
  })

  it('no tags, or showTags={false}: no tag list, no Tag glyph', () => {
    const empty = render(<ListRow post={post({ tags: [] })} headingLevel={2} />)
    expect(screen.queryByRole('list', { name: msg('Site.article.tagsLabel') })).not.toBeInTheDocument()
    expect(empty.container.querySelector('ul')).toBeNull()
    expect(glyphNames(empty.container)).not.toContain('TagIcon')
    empty.unmount()

    const hidden = render(<ListRow post={post({ tags: TAGS })} headingLevel={2} showTags={false} />)
    expect(screen.queryByRole('list', { name: msg('Site.article.tagsLabel') })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Lessons' })).not.toBeInTheDocument()
    expect(glyphNames(hidden.container)).not.toContain('TagIcon')
  })
})

describe('ListRow — thumbnail', () => {
  it('post with a cover image: <img alt=""> in a hidden link, no cover art', () => {
    const { container } = render(<ListRow post={post({ cover: COVER })} headingLevel={2} />)

    const img = container.querySelector('img')!
    expect(img).toHaveAttribute('alt', '')
    expect(img.closest('a')).toBe(thumbnailLink(container))
    expect(img).toHaveAttribute('sizes', '(min-width: 640px) 14rem, 7rem')
    expect(container.querySelector('svg.cover-art')).toBeNull()
  })

  it('post without a cover image: svg.cover-art in a hidden link, no <img>', () => {
    const { container } = render(<ListRow post={post({ cover: null })} headingLevel={2} />)

    const art = container.querySelector('svg.cover-art')!
    expect(art).not.toBeNull()
    expect(art.closest('a')).toBe(thumbnailLink(container))
    expect(container.querySelector('img')).toBeNull()
  })

  it('compact: thumbnail 6rem at every width, so the image also asks for 6rem', () => {
    const { container } = render(<ListRow post={post({ cover: COVER })} headingLevel={3} compact />)

    expect(container.querySelector('img')).toHaveAttribute('sizes', '6rem')
    const grid = classesOf(container.querySelector('article'))
    expect(grid).toContain('grid-cols-[minmax(0,1fr)_6rem]')
    expect(grid).not.toContain('sm:grid-cols-[minmax(0,1fr)_clamp(10rem,28%,14rem)]')
  })
})

describe('ListRow — keyword highlighting (search page)', () => {
  const EXCERPT = HL_EXCERPT

  it('with `query`: matched words in the title and description sit in <mark>, matching without diacritics', () => {
    const { container } = render(
      <ListRow post={post({ title: HL_TITLE, excerpt: EXCERPT })} headingLevel={2} query="hoc hang doi" />,
    )

    const heading = screen.getByRole('heading', { level: 2 })
    expect(Array.from(heading.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(HL_TITLE_MARKS)
    const excerpt = screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === EXCERPT)
    expect(Array.from(excerpt.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(HL_EXCERPT_MARKS)
    // Exactly six, and only in those two places.
    expect(container.querySelectorAll('mark')).toHaveLength(6)
  })

  it('the visible text and the accessible name of the title link are unchanged: <mark> only wraps, adds no text', () => {
    const title = HL_TITLE
    render(<ListRow post={post({ title })} headingLevel={2} query="hoc" />)

    // Look it up by the full name: an extra space around <mark> turns the name into a doubled-space variant and
    // screen reader users would hear a title different from the post title.
    const link = screen.getByRole('link', { name: title })
    expect(link.textContent).toBe(title)
    expect(link.querySelector('mark')?.textContent).toBe(HL_TITLE_MARKS[0])
    // Still the only accessible link to the post.
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href') === HREF)).toHaveLength(1)
  })

  it('no `query` (every list other than /search): not a single <mark>', () => {
    const { container } = render(<ListRow post={post({ title: HL_TITLE, excerpt: EXCERPT })} headingLevel={2} />)

    expect(container.querySelector('mark')).toBeNull()
    expect(screen.getByRole('link', { name: HL_TITLE })).toBeInTheDocument()

    // An empty query too: there is no word to highlight.
    const blank = render(<ListRow post={post({ title: HL_SHORT_TITLE })} headingLevel={2} query="   " />)
    expect(blank.container.querySelector('mark')).toBeNull()
  })

  it('only the title and description: category, tags and series name are not highlighted even if they contain the keyword', () => {
    const { container } = render(
      <ListRow
        post={post({
          title: HL_OTHER_TITLE,
          category: { id: 'c2', name: HL_CATEGORY, slug: 'bai-hoc', description: null },
          tags: [{ id: 't1', name: HL_TAG, slug: 'hoc-may' }],
          series: { ...SERIES, title: HL_SERIES },
        })}
        headingLevel={2}
        query="hoc"
      />,
    )

    // All three places are navigation links, not the post's text; highlighting them would claim the post matches there.
    expect(container.querySelector('mark')).toBeNull()
    expect(screen.getByRole('link', { name: HL_CATEGORY })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: HL_TAG })).toBeInTheDocument()
  })

  it('<mark> is readable in both themes: separate light/dark backgrounds, text inheriting the line color', () => {
    render(<ListRow post={post({ title: HL_SHORT_TITLE })} headingLevel={2} query="hoc" />)

    const mark = screen.getByRole('heading', { level: 2 }).querySelector('mark')!
    // jsdom does not apply Tailwind: this is a class name assert. `text-inherit` is the part that must not be lost: the
    // default color of <mark> is black (MarkText), i.e. black text on a dark background in the dark theme, and the hover of
    // the title link (`hover:text-brand`) would not reach text inside <mark>.
    expect(classesOf(mark)).toEqual(expect.arrayContaining(['bg-amber-100', 'dark:bg-amber-300/25', 'text-inherit']))
  })

  it('a title containing HTML is still only text, including the highlighted part', () => {
    const title = HL_HTML_TITLE
    const { container } = render(<ListRow post={post({ title })} headingLevel={2} query="img hoc" />)

    // No <img> tag is produced from the title (post without a cover image: the thumbnail is SVG cover art).
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: title }).textContent).toBe(title)
    expect(Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual(['img', HL_EXCERPT_MARKS[0]])
  })

  it('a query full of regex special characters does not break the row', () => {
    expect(() =>
      render(<ListRow post={post({ title: 'Writing C++ (for beginners)' })} headingLevel={2} query="c++ ( [ $ \ .*" />),
    ).not.toThrow()
    expect(screen.getByRole('link', { name: 'Writing C++ (for beginners)' }).querySelector('mark')?.textContent).toBe('C')
  })
})

describe('ListRow — layout', () => {
  it('two-column grid: thumbnail 7rem, from 640px clamp(10rem,28%,14rem), spanning four rows and anchored to the top', () => {
    const { container } = render(
      <ListRow post={post({ excerpt: 'One paragraph.', tags: [{ id: 't1', name: 'AWS', slug: 'aws' }] })} headingLevel={2} />,
    )

    // jsdom does not apply Tailwind: this is a class name assert, not about the picture. Every class here
    // is a class from the design that must match verbatim; screenshots at 320/390/1024 are the rest of the check.
    const article = container.querySelector('article')!
    expect(classesOf(article)).toEqual(
      expect.arrayContaining([
        'grid',
        'grid-cols-[minmax(0,1fr)_7rem]',
        'gap-x-4',
        'sm:grid-cols-[minmax(0,1fr)_clamp(10rem,28%,14rem)]',
        'sm:gap-x-8',
        // The last row stretches: when the four cells have text yet are still shorter than the thumbnail, the excess is pushed
        // to the bottom instead of being split evenly between the title and the meta (measured 13px instead of 8px).
        'sm:grid-rows-[auto_auto_auto_1fr]',
      ]),
    )

    const thumb = thumbnailLink(container)
    expect(classesOf(thumb)).toEqual(
      expect.arrayContaining(['col-start-2', 'row-start-1', 'self-start', 'sm:row-span-4', 'sm:row-start-1']),
    )

    // Below 640px the meta, excerpt and tags run the full width under the title; from 640px they go back to the text column.
    const cells = Array.from(article.children).filter((el) => el !== thumb)
    const [titleCell, ...below] = cells
    expect(classesOf(titleCell)).toEqual(expect.arrayContaining(['col-start-1', 'row-start-1', 'min-w-0']))
    expect(below).toHaveLength(3)
    for (const cell of below) {
      expect(classesOf(cell)).toEqual(expect.arrayContaining(['col-span-2', 'sm:col-span-1', 'sm:col-start-1']))
    }
  })

  it('a long title does not push into horizontal overflow: the cell can shrink, text breaks mid-word', () => {
    render(<ListRow post={post()} headingLevel={2} />)

    const heading = screen.getByRole('heading', { level: 2, name: TITLE })
    expect(classesOf(heading.parentElement)).toContain('min-w-0')
    expect(classesOf(heading)).toContain('break-words')
  })
})
