import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PostSummary } from '@/lib/types'
import { glyphName, glyphNames } from '@/test/glyphs'
import { ReadingMeta, TagList, readingMinutesOf } from './ReadingMeta'
import { msg } from '@/test/render-intl'
import { currentTestLocale, translatorFor } from '@/test/intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'

const rawMsg = (key: string) => (translatorFor(currentTestLocale()) as unknown as { raw(key: string): string }).raw(key)
const withDate = (key: string, date: string) => rawMsg(key).replace('<time>{date}</time>', date)
const READING_SUFFIX_RE = new RegExp(rawMsg('Site.article.readingTime').replace('{minutes} ', ''))
const UPDATED_RE = new RegExp(rawMsg('Site.article.updated').split(' <')[0]!)

const category = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }

// Name and slug deliberately different, and different the way the real data is
// different — a tag name with diacritics and capitals versus the lowercase ASCII slug the route matches on. A
// fixture where the two are equal cannot tell a component that links by slug from one
// that links by name, and linking by name is the defect this shape exists to catch.
const tag = { id: 't1', name: 'Lessons Learned', slug: 'lessons-learned' }

const summary = (extra: Partial<PostSummary> = {}): PostSummary => ({
  id: 'p1',
  title: 'One post',
  slug: 'one-post',
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: null,
  featured: false,
  readingMinutes: 5,
  ...extra,
})

describe('readingMinutesOf', () => {
  it('reads readingMinutes off a post the API returned', () => {
    // The field is on the wire — verified against the running backend:
    //   curl -s "localhost:8080/api/v1/posts?size=1" → "readingMinutes":12
    // and `PostSummary` in lib/types.ts declares it. The function exists for the payloads
    // that disagree with that declaration (the tests below), not to reach the field.
    expect(readingMinutesOf({ ...summary(), readingMinutes: 12 } as PostSummary)).toBe(12)
  })

  it('returns null when the field is missing entirely', () => {
    // An older cached response, or a payload from a deployment that predates the field.
    // The alternative on the page is a reading time printing NaN.
    //
    // The absence has to be CONSTRUCTED now. lib/types.ts declares
    // `readingMinutes: number`, so the fixture can no longer omit it — which is correct
    // for the type and does not make this branch dead: a TypeScript type is a claim about
    // a wire format, not a promise from it, and this function exists precisely to survive
    // a payload the type says is impossible. Deleting the key is more honest than
    // `undefined as unknown as number`, because it reproduces the real shape: a JSON
    // object that never had the property.
    const withoutTheField: Record<string, unknown> = { ...summary() }
    delete withoutTheField.readingMinutes
    expect('readingMinutes' in withoutTheField).toBe(false)

    expect(readingMinutesOf(withoutTheField as unknown as PostSummary)).toBeNull()
  })

  it('returns null for 0, a negative number, and a non-number', () => {
    // A reading time of 0 is worse than printing nothing, and a numeric-looking string would
    // render but compare and sort wrongly anywhere else it was used.
    expect(readingMinutesOf({ ...summary(), readingMinutes: 0 } as PostSummary)).toBeNull()
    expect(readingMinutesOf({ ...summary(), readingMinutes: -3 } as PostSummary)).toBeNull()
    expect(readingMinutesOf({ ...summary(), readingMinutes: Number.NaN } as PostSummary)).toBeNull()
    expect(readingMinutesOf({ ...summary(), readingMinutes: '7' } as unknown as PostSummary)).toBeNull()
  })
})

describe('ReadingMeta date', () => {
  it('formats the published date in UTC, in Vietnamese, in full', () => {
    const { container } = render(
      <ReadingMeta publishedAt="2026-09-28T17:30:00Z" category={null} tags={[]} readingMinutes={null} />,
    )
    const time = container.querySelector('time')

    expect(time).toHaveAttribute('dateTime', '2026-09-28T17:30:00Z')
    // 17:30Z is already 00:30 on the 29th in Asia/Ho_Chi_Minh, which
    // vitest.config.mts pins as the suite's timezone precisely so that deleting
    // `timeZone: 'UTC'` moves this to the 29th of September and fails. On a UTC host — every
    // default CI runner and container — the option could be deleted with nothing
    // noticing.
    expect(time?.textContent).toContain('28')
    expect(time?.textContent).not.toContain('29')
    // The locale and the style too, which a day-number assertion cannot see:
    // 'vi-VN' → 'en-US' and dateStyle 'long' → 'short' both leave the day at 28.
    expect(time?.textContent).toBe(LONG_DATE_VI(28, 9, 2026))
    // Pinned again now that the meta row has icons: the textContent above does NOT catch an icon slipping into
    // <time> (an SVG has no text), so the element must be asked directly. The calendar icon sits right before it.
    expect(time?.querySelector('svg')).toBeNull()
    expect(time?.children).toHaveLength(0)
    expect(glyphName(time?.previousElementSibling)).toBe('CalendarDaysIcon')
  })

  it('renders no <time> element at all when there is no date', () => {
    const { container } = render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={null} />)

    // Element, not text: a guard loosened to `publishedAt !== undefined` renders an
    // empty <time>, which no text assertion would see.
    expect(container.querySelector('time')).toBeNull()
  })
})

describe('ReadingMeta category and tags', () => {
  it('links the category to /categories/<slug> and shows its name', () => {
    render(<ReadingMeta publishedAt={null} category={category} tags={[]} readingMinutes={null} />)

    expect(screen.getByRole('link', { name: 'Architecture' })).toHaveAttribute('href', '/categories/architecture')
  })

  it('links a tag by its SLUG even when the name differs', () => {
    render(<ReadingMeta publishedAt={null} category={null} tags={[tag]} readingMinutes={null} />)

    const link = screen.getByRole('link', { name: 'Lessons Learned' })
    // The href is the slug...
    expect(link).toHaveAttribute('href', '/tags/lessons-learned')
    // ...and it is NOT the name. `/tags/${encodeURIComponent(tag.name)}` renders,
    // links, and matches no post at all, because the route filters on the slug.
    // Asserting only the positive leaves the two indistinguishable in any fixture
    // where name and slug happen to agree.
    expect(link.getAttribute('href')).not.toContain(encodeURIComponent('Lessons Learned'))
    expect(link.getAttribute('href')).not.toContain('Lessons')
  })

  it('percent-encodes a slug that needs it', () => {
    render(
      <ReadingMeta
        publishedAt={null}
        category={{ ...category, slug: 'machine learning' }}
        tags={[{ ...tag, slug: 'ci/cd tips' }]}
        readingMinutes={null}
      />,
    )

    expect(screen.getByRole('link', { name: 'Architecture' })).toHaveAttribute(
      'href',
      `/categories/${encodeURIComponent('machine learning')}`,
    )
    expect(screen.getByRole('link', { name: 'Lessons Learned' })).toHaveAttribute(
      'href',
      `/tags/${encodeURIComponent('ci/cd tips')}`,
    )
  })

  it('renders the tag list as a labelled list, one link per tag', () => {
    render(
      <ReadingMeta
        publishedAt={null}
        category={null}
        tags={[tag, { id: 't2', name: 'CI/CD', slug: 'ci-cd' }]}
        readingMinutes={null}
      />,
    )

    const list = screen.getByRole('list', { name: msg('Site.article.tagsLabel') })
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/tags/lessons-learned', '/tags/ci-cd'])
  })

  it('renders no list element when there are no tags', () => {
    const { container } = render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={null} />)

    // `tags.length >= 0` renders an empty <ul> carrying a top margin — invisible to
    // any text assertion, visible as a gap on the page.
    expect(container.querySelector('ul')).toBeNull()
  })
})

describe('ReadingMeta reading time', () => {
  it('prints "N min read"', () => {
    render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={12} />)

    expect(screen.getByText(msg('Site.article.readingTime', { minutes: '12' }))).toBeInTheDocument()
  })

  it('prints nothing when there is no estimate', () => {
    render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={null} />)

    expect(screen.queryByText(READING_SUFFIX_RE)).not.toBeInTheDocument()
  })

  it('does not wrap the estimate in <time>', () => {
    const { container } = render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={12} />)

    // <time> needs an ISO 8601 duration ("PT12M") in dateTime to be valid, so
    // <time dateTime="12 min"> is markup a validator rejects. Plain text is honest.
    expect(container.querySelector('time')).toBeNull()
  })
})

describe('ReadingMeta — icon', () => {
  it('all three items: [CalendarDays] date, [Folder] category, [Clock] reading time, in exactly this order', () => {
    const { container } = render(
      <ReadingMeta publishedAt="2026-09-28T17:30:00Z" category={category} tags={[]} readingMinutes={12} />,
    )

    expect(glyphNames(container)).toEqual(['CalendarDaysIcon', 'FolderIcon', 'ClockIcon'])
    // Decorative icons, never carrying a name: aria-hidden and not focusable.
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('focusable', 'false')
    }
  })

  it("[Folder] sits inside the category link, and the link's accessible name is still only the category name", () => {
    render(<ReadingMeta publishedAt={null} category={category} tags={[]} readingMinutes={null} />)

    const link = screen.getByRole('link', { name: 'Architecture' })
    expect(glyphNames(link)).toEqual(['FolderIcon'])
    expect(link.textContent).toBe('Architecture')
  })

  it('[Clock] sits with "N min read"', () => {
    render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={12} />)

    expect(glyphNames(screen.getByText(msg('Site.article.readingTime', { minutes: '12' })))).toEqual(['ClockIcon'])
  })

  it('a missing item also means its icon is missing', () => {
    // The "absent" pair of the three tests above: an icon standing alone with no text beside it looks
    // more like a bug than even an empty row.
    const { container } = render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={null} />)
    expect(container.querySelector('svg')).toBeNull()

    const onlyMinutes = render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={3} />)
    expect(glyphNames(onlyMinutes.container)).toEqual(['ClockIcon'])
  })

  it('an unreadable date: no empty <time>, no calendar icon', () => {
    // formatDate returns null for a broken date. Before, <time> was still built with empty content;
    // now there is a calendar icon beside it too, so an empty <time> becomes an orphan icon.
    const { container } = render(<ReadingMeta publishedAt="not-a-date" category={null} tags={[]} readingMinutes={4} />)

    expect(container.querySelector('time')).toBeNull()
    expect(glyphNames(container)).toEqual(['ClockIcon'])
  })

  it('the tag row has a leading Tag glyph, placed outside the <ul aria-label="Tags">', () => {
    render(
      <ReadingMeta
        publishedAt={null}
        category={null}
        tags={[tag, { id: 't2', name: 'CI/CD', slug: 'ci-cd' }]}
        readingMinutes={null}
      />,
    )

    const list = screen.getByRole('list', { name: msg('Site.article.tagsLabel') })
    // Outside the <ul>: the list only holds tag items, so a screen reader still reads "2 items".
    expect(list.querySelector('svg')).toBeNull()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(glyphName(list.previousElementSibling)).toBe('TagIcon')
  })
})

describe('ReadingMeta — updated date', () => {
  const PUBLISHED = '2026-09-28T17:30:00Z'

  it('a post edited after its publish date: "[PenLine] Updated <time>" right after the publish date, before the reading time', () => {
    const { container } = render(
      <ReadingMeta publishedAt={PUBLISHED} updatedAt="2026-10-06T08:00:00Z" category={category} tags={[]} readingMinutes={12} />,
    )

    const times = container.querySelectorAll('time')
    expect(times).toHaveLength(2)
    // The publish date is still the first <time>: everywhere else (post page test, OG) reads it as before.
    expect(times[0]).toHaveAttribute('dateTime', PUBLISHED)
    const updated = times[1]!
    expect(updated).toHaveAttribute('dateTime', '2026-10-06T08:00:00Z')
    // The <time> content is the date itself (like the publish date); the "updated" label sits outside it.
    expect(updated.textContent).toBe(LONG_DATE_VI(6, 10, 2026))
    expect(updated.children).toHaveLength(0)
    expect(updated.parentElement?.textContent).toBe(withDate('Site.article.updated', LONG_DATE_VI(6, 10, 2026)))

    // Each icon goes with its own item, in reading order: publish date, updated date, category, time.
    expect(glyphNames(container)).toEqual(['CalendarDaysIcon', 'PenLineIcon', 'FolderIcon', 'ClockIcon'])
    // Its item: an icon then a span "Updated <time>", just as the publish date item is an icon then <time>.
    const item = updated.parentElement!.parentElement!
    expect(glyphName(item.firstElementChild)).toBe('PenLineIcon')
    expect(item.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(glyphNames(item)).toEqual(['PenLineIcon'])
  })

  it.each([
    ['not passed', undefined],
    ['null', null],
    ['earlier than the publish date', '2026-09-02T00:00:00Z'],
    ['same day as publish (UTC)', '2026-09-28T23:00:00Z'],
    ['malformed', 'not-a-date'],
  ])('updated date %s: no "Updated" line, no orphan icon', (_label, updatedAt) => {
    const { container } = render(
      <ReadingMeta publishedAt={PUBLISHED} updatedAt={updatedAt} category={null} tags={[]} readingMinutes={12} />,
    )

    expect(screen.queryByText(UPDATED_RE)).not.toBeInTheDocument()
    expect(container.querySelectorAll('time')).toHaveLength(1)
    expect(glyphNames(container)).toEqual(['CalendarDaysIcon', 'ClockIcon'])
  })

  it('no publish date: no "Updated" line — an edit date has nothing to compare against', () => {
    const { container } = render(
      <ReadingMeta publishedAt={null} updatedAt="2026-10-06T08:00:00Z" category={null} tags={[]} readingMinutes={null} />,
    )

    expect(container.querySelector('time')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
  })
})

describe('TagList', () => {
  it('no tags: renders nothing, not even the glyph', () => {
    const { container } = render(<TagList tags={[]} className="mt-3" />)

    expect(container).toBeEmptyDOMElement()
  })

  it("with tags: the caller's class sits on the block wrapping the glyph and the list", () => {
    const { container } = render(<TagList tags={[tag]} className="mt-3" />)

    const wrapper = container.firstElementChild!
    expect(wrapper.className).toContain('mt-3')
    expect(glyphName(wrapper.firstElementChild)).toBe('TagIcon')
    expect(wrapper.querySelector(`ul[aria-label="${msg('Site.article.tagsLabel')}"]`)).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Lessons Learned' })).toHaveAttribute('href', '/tags/lessons-learned')
  })
})

describe('ReadingMeta trailing', () => {
  it('date, updated, minutes and the trailing item share ONE flex row (no nested flex row), with gap-x-3 gap-y-1', () => {
    const { container } = render(
      <ReadingMeta
        className="mt-5"
        publishedAt="2026-09-28T17:30:00Z"
        updatedAt="2026-10-02T09:00:00Z"
        category={null}
        tags={[]}
        readingMinutes={7}
        trailing={<span data-testid="views">1.2K</span>}
      />,
    )

    const row = screen.getByTestId('views').parentElement!
    expect(row.className).toMatch(/\bflex\b/)
    expect(row.className).toMatch(/\bgap-x-3\b/)
    expect(row.className).toMatch(/\bgap-y-1\b/)
    // The outer wrapper only carries the caller's className: it is not a second flex row.
    expect(container.firstElementChild).toBe(row.parentElement)
    expect(container.firstElementChild).toHaveClass('mt-5')
    expect(container.firstElementChild!.className).not.toMatch(/\bflex\b/)
    expect(container.querySelectorAll('.flex-wrap')).toHaveLength(1)
    // Everything is a direct child of that one row, the trailing item last.
    expect(row.querySelectorAll('time')).toHaveLength(2)
    expect(row.lastElementChild).toBe(screen.getByTestId('views'))
    expect(row.children).toHaveLength(4)
    expect(row).toHaveTextContent(msg('Site.article.readingTime', { minutes: '7' }))
  })

  it('without trailing nothing is added to the row', () => {
    render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={5} />)

    expect(screen.queryByTestId('views')).toBeNull()
  })
})

describe('ReadingMeta leading', () => {
  it('the leading item comes first and the trailing item last, all in ONE flex row', () => {
    const { container } = render(
      <ReadingMeta
        publishedAt="2026-09-28T17:30:00Z"
        updatedAt="2026-10-02T09:00:00Z"
        category={null}
        tags={[]}
        readingMinutes={7}
        leading={<span data-testid="badge">03 / 07</span>}
        trailing={<span data-testid="views">1.2K</span>}
      />,
    )

    const row = screen.getByTestId('badge').parentElement!
    expect(row).toBe(screen.getByTestId('views').parentElement)
    expect(row.firstElementChild).toBe(screen.getByTestId('badge'))
    expect(row.lastElementChild).toBe(screen.getByTestId('views'))
    expect(row.className).toContain('gap-x-3')
    expect(container.querySelectorAll('.flex-wrap')).toHaveLength(1)
    // badge, date, updated, minutes, views
    expect(row.children).toHaveLength(5)
  })

  it('without leading nothing is added to the row', () => {
    render(<ReadingMeta publishedAt={null} category={null} tags={[]} readingMinutes={5} />)

    expect(screen.queryByTestId('badge')).toBeNull()
  })
})
