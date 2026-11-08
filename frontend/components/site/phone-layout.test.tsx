import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import type { Locale } from '@/i18n/config'
import type { SeriesSummary, Tag } from '@/lib/types'
import { setTestLocale } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { SignupForm } from '@/app/[locale]/(site)/newsletter/SignupForm'
import { Pagination } from '../Pagination'
import { ContactForm } from './ContactForm'
import { Footer } from './Footer'
import { Hero } from './Hero'
import { LanguageSwitcher } from './LanguageSwitcher'
import { NotFoundContent } from './NotFoundContent'
import { TagList } from './ReadingMeta'
import { SearchFilters, ActiveFilters } from './SearchFilters'
import { SearchForm } from './SearchForm'
import { SectionHeading } from './SectionHeading'
import { SeriesEntry } from './SeriesEntry'
import { ROW } from './reader/rail-parts'
import { Timeline } from './Timeline'

/**
 * The phone layout of the public pages (below `sm`, 640px): jsdom does not run Tailwind, so these pin the class contract that the
 * screenshots at 430 and 390px were checked against. Every phone utility is `max-sm:` or an unprefixed utility that an `sm:` one
 * overrides, so the desktop (1440px) classes are untouched; the second half of most tests says so.
 */

const classesOf = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

describe('section action link', () => {
  it('is a 44px row below sm and the plain link from sm', () => {
    render(<SectionHeading id="a" title="A" action={{ href: '/writing', label: 'All posts' }} />)

    const link = screen.getByRole('link', { name: /All posts/ })
    expect(classesOf(link)).toEqual(expect.arrayContaining(['max-sm:inline-flex', 'max-sm:min-h-11', 'max-sm:items-center']))
    // Centred with the heading on a phone, baseline-aligned from sm like before.
    expect(classesOf(link.parentElement)).toEqual(expect.arrayContaining(['items-center', 'sm:items-baseline']))
  })
})

describe('tag chips', () => {
  const TAGS: Tag[] = [
    { id: 't1', name: 'AWS', slug: 'aws' },
    { id: 't2', name: 'SQS', slug: 'sqs' },
  ]

  it('are 36px pills with a 4px hit area above and below on a phone, the 24px chip from sm', () => {
    renderWithIntl(<TagList tags={TAGS} />, { locale: 'en' })

    for (const chip of screen.getAllByRole('link')) {
      expect(classesOf(chip)).toEqual(
        expect.arrayContaining([
          'min-h-9',
          'inline-flex',
          'items-center',
          'after:absolute',
          'after:-inset-y-1',
          'sm:min-h-0',
          'sm:py-1',
          'sm:after:hidden',
        ]),
      )
    }
  })
})

describe('series entry', () => {
  const SERIES: SeriesSummary = {
    id: 's1',
    title: 'Pipeline',
    slug: 'pipeline',
    description: 'How to run a browser job in the cloud.',
    postCount: 2,
    readingMinutes: 20,
    latestPublishedAt: '2026-10-12T10:00:00Z',
    parts: [
      { slug: 'part-one', title: 'Part one' },
      { slug: 'part-two', title: 'Part two' },
    ],
  }

  it('puts the description under the title and the thumbnail on a phone, and keeps it in the text column from sm', () => {
    const { container } = renderWithIntl(<SeriesEntry series={SERIES} />, { locale: 'en' })

    const description = screen.getByText(SERIES.description!)
    expect(classesOf(description)).toEqual(expect.arrayContaining(['max-sm:col-span-2', 'text-[0.9375rem]', 'sm:text-base']))
    // The cell of the title is `contents` below sm, so the name stays beside the thumbnail and the description is a grid item of its own.
    expect(classesOf(description.parentElement)).toEqual(
      expect.arrayContaining(['col-start-1', 'row-start-1', 'max-sm:contents']),
    )
    expect(classesOf(container.querySelector('article'))).toContain('grid-cols-[minmax(0,1fr)_7rem]')
  })

  it('lists the parts as 44px rows without an underline on a phone', () => {
    renderWithIntl(<SeriesEntry series={SERIES} />, { locale: 'en' })

    const parts = within(screen.getByRole('list')).getAllByRole('link')
    expect(parts).toHaveLength(2)
    for (const link of parts) {
      expect(classesOf(link)).toEqual(expect.arrayContaining(['max-sm:min-h-11', 'max-sm:no-underline', 'underline']))
    }
    const start = screen.getByRole('link', { name: new RegExp(msg('Site.listing.seriesEntry.startAtPartOne', undefined, 'en')) })
    // The start link is the shared phone button (44px, filled), underlined text from sm.
    expect(classesOf(start)).toEqual(
      expect.arrayContaining(['max-sm:h-11', 'max-sm:inline-flex', 'max-sm:rounded-lg', 'max-sm:bg-neutral-900', 'underline']),
    )
    // Each part row has its number in a 24px gutter below sm.
    const row = parts[0]!.parentElement!
    expect(classesOf(row)).toEqual(expect.arrayContaining(['max-sm:flex', 'max-sm:items-center']))
    expect(classesOf(row.querySelector('span'))).toEqual(expect.arrayContaining(['w-6', 'sm:hidden']))
  })

  it('folds the parts after the third below sm into "+k parts", while every part stays in the markup for sm and up', () => {
    const parts = Array.from({ length: 6 }, (_, i) => ({ slug: `p-${i + 1}`, title: `Part ${i + 1}` }))
    renderWithIntl(
      <SeriesEntry series={{ ...SERIES, postCount: 6, parts }} partsShown={Number.POSITIVE_INFINITY} phonePartsShown={3} />,
      { locale: 'en' },
    )

    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(items).toHaveLength(6)
    expect(items.map((item) => classesOf(item).includes('max-sm:hidden'))).toEqual([false, false, false, true, true, true])
    const more = screen.getByRole('link', {
      name: (name) => name.includes(msg('Site.listing.seriesEntry.moreParts', { count: 3 }, 'en')),
    })
    expect(classesOf(more.parentElement)).toContain('sm:hidden')
  })
})

describe('not-found page', () => {
  it('offers its three exits as stacked 44px buttons on a phone and as the row of links from sm', () => {
    const { container } = renderWithIntl(<NotFoundContent />, { locale: 'en' })

    const row = container.querySelector('a')!.parentElement!
    expect(classesOf(row)).toEqual(expect.arrayContaining(['flex-col', 'gap-3', 'sm:flex-row', 'sm:flex-wrap']))
    const links = within(row).getAllByRole('link')
    expect(links).toHaveLength(3)
    for (const link of links) {
      expect(classesOf(link)).toEqual(
        expect.arrayContaining(['max-sm:h-11', 'max-sm:rounded-lg', 'max-sm:border', 'max-sm:no-underline']),
      )
    }
    // The first (home) is the filled button.
    expect(classesOf(links[0])).toContain('max-sm:bg-neutral-900')
    expect(classesOf(links[1])).not.toContain('max-sm:bg-neutral-900')
  })
})

describe('hero calls to action', () => {
  const { profile } = defaultSiteContent('en')

  it('are buttons on a phone: the first filled, the others outlined, and underlined links from sm', () => {
    renderWithIntl(
      <Hero hero={profile.hero} github="https://github.com/example-user" seeking={null} location={profile.location} />,
      { locale: 'en' },
    )

    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(3)
    for (const link of links)
      expect(classesOf(link)).toEqual(expect.arrayContaining(['max-sm:h-11', 'max-sm:rounded-lg', 'underline']))
    expect(classesOf(links[0])).toContain('max-sm:bg-neutral-900')
    for (const link of links.slice(1)) expect(classesOf(link)).toContain('max-sm:border-neutral-300')
  })
})

describe('home timeline', () => {
  it('has no rail on a phone: entries are separated by a hairline, and the rail comes back from sm', () => {
    const { timeline } = defaultSiteContent('en')
    const { container } = renderWithIntl(<Timeline data={timeline} bare />, { locale: 'en' })

    const list = container.querySelector('ol')!
    expect(classesOf(list)).toEqual(expect.arrayContaining(['divide-y', 'sm:divide-y-0', 'sm:border-l', 'sm:pl-6']))
    expect(classesOf(list)).not.toContain('border-l')
    expect(classesOf(list)).not.toContain('pl-6')
    for (const item of Array.from(list.children)) expect(classesOf(item)).toEqual(expect.arrayContaining(['py-6', 'sm:py-0']))
  })

  it('shows the first three bullets of a long entry on a phone with a button for the rest, and keeps the whole text in the page', () => {
    const { timeline } = defaultSiteContent('en')
    const highlights = ['one', 'two', 'three', 'four', 'five']
    const data = { ...timeline, entries: [{ ...timeline.entries[0]!, highlights }] }
    const { container } = renderWithIntl(<Timeline data={data} bare />, { locale: 'en' })

    // Everything is in the HTML (the hidden bullets are hidden by CSS below sm only); the button names how many are folded.
    expect(container.querySelectorAll('li li')).toHaveLength(5)
    const toggle = screen.getByRole('button', { name: msg('Site.entry.showMore', { count: 2 }, 'en') })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(classesOf(toggle)).toContain('sm:hidden')
  })
})

describe('contact form', () => {
  it('has fields of at least 44px and a full-width submit button on a phone', () => {
    renderWithIntl(<ContactForm />, { locale: 'en' })

    for (const field of screen.getAllByRole('textbox')) expect(classesOf(field), field.id).toContain('max-sm:min-h-11')
    const submit = screen.getByRole('button', { name: new RegExp(msg('Site.contact.form.submit', undefined, 'en')) })
    expect(classesOf(submit)).toEqual(expect.arrayContaining(['h-11', 'w-full', 'sm:w-auto']))
  })
})

describe('language switcher', () => {
  it('is a 44px flag below sm (no arrow), the pill from sm, and its list opens from the right edge', () => {
    renderWithIntl(<LanguageSwitcher />, { locale: 'en' })

    const nav = screen.getByRole('navigation', { name: msg('Language.navLabel', undefined, 'en') })
    const summary = nav.querySelector('summary')!
    expect(classesOf(summary)).toEqual(expect.arrayContaining(['h-11', 'w-11', 'sm:w-auto', 'md:h-9']))
    expect(classesOf(summary.querySelector('svg:last-of-type'))).toEqual(expect.arrayContaining(['hidden', 'sm:block']))
    const list = nav.querySelector('ul')!
    expect(classesOf(list)).toEqual(expect.arrayContaining(['right-0']))
    expect(classesOf(list)).not.toContain('left-0')
    for (const row of Array.from(list.querySelectorAll('li > *'))) expect(classesOf(row)).toContain('min-h-11')
  })
})

describe('footer', () => {
  async function renderFooter(locale: Locale) {
    setTestLocale(locale)
    return renderWithIntl(await Footer(), { locale })
  }

  it('lists its links as 44px rows without a gap on a phone, and draws an icon only from sm', async () => {
    await renderFooter('en')

    const nav = screen.getByRole('navigation', { name: msg('Site.footer.navLabel', undefined, 'en') })
    const lists = nav.querySelectorAll('ul')
    expect(lists).toHaveLength(2)
    for (const list of Array.from(lists)) expect(classesOf(list)).toEqual(expect.arrayContaining(['gap-0', 'sm:gap-2']))
    const links = within(nav).getAllByRole('link')
    for (const link of links) {
      expect(classesOf(link), link.textContent ?? '').toEqual(
        expect.arrayContaining(['max-sm:min-h-11', 'max-sm:no-underline', 'max-sm:after:hidden']),
      )
    }
    // The icon of "random" and "RSS" sits in a wrapper that does not exist below sm, so every label starts at the same x.
    const random = within(nav).getByRole('link', { name: msg('Site.footer.links.random', undefined, 'en') })
    expect(classesOf(random.querySelector('svg')!.parentElement)).toEqual(expect.arrayContaining(['hidden', 'sm:contents']))
  })
})

describe('search', () => {
  const OPTIONS = {
    categories: [{ slug: 'testing', name: 'Testing' }],
    tags: [
      { slug: 'aws', name: 'AWS' },
      { slug: 'sqs', name: 'SQS' },
    ],
    series: [{ slug: 'pipeline', name: 'Pipeline' }],
  }

  it('the keyword field and the button are 44px tall on a phone only', () => {
    renderWithIntl(<SearchForm q="queue" />, { locale: 'en' })

    expect(classesOf(screen.getByRole('searchbox'))).toContain('max-sm:min-h-11')
    expect(classesOf(screen.getByRole('button'))).toContain('max-sm:min-h-11')
  })

  it('the filter fields are 16px (no zoom on iPhone) and 44px tall below sm, the tag checkboxes are 44px rows', () => {
    const { container } = renderWithIntl(<SearchFilters filters={{ tags: ['aws'] }} options={OPTIONS} open />, { locale: 'en' })

    for (const select of Array.from(container.querySelectorAll('select'))) {
      expect(classesOf(select)).toEqual(expect.arrayContaining(['min-h-11', 'text-base', 'sm:min-h-0', 'sm:text-sm']))
    }
    const labels = Array.from(container.querySelectorAll('fieldset label'))
    expect(labels).toHaveLength(2)
    for (const label of labels)
      expect(classesOf(label)).toEqual(expect.arrayContaining(['max-sm:min-h-11', 'max-sm:after:hidden']))
  })

  it('the active filter chips are 36px with a 4px hit area, and "clear" is a 44px row', () => {
    renderWithIntl(<ActiveFilters query="queue" filters={{ tags: ['aws'] }} options={OPTIONS} />, { locale: 'en' })

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(classesOf(links[0])).toEqual(expect.arrayContaining(['max-sm:min-h-9', 'max-sm:after:-inset-y-1']))
    expect(classesOf(links[1])).toEqual(expect.arrayContaining(['max-sm:min-h-11', 'max-sm:after:hidden']))
  })
})

describe('pagination and sidebar rows', () => {
  it('the previous and next links are outlined 44px buttons below sm', () => {
    renderWithIntl(<Pagination meta={{ page: 1, size: 10, totalElements: 30, totalPages: 3 }} basePath="/writing" />, {
      locale: 'en',
    })

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(classesOf(link)).toEqual(
        expect.arrayContaining([
          'max-sm:min-h-11',
          'max-sm:rounded-lg',
          'max-sm:border',
          'max-sm:no-underline',
          'max-sm:after:hidden',
        ]),
      )
    }
  })

  it('a sidebar row is 44px tall on a coarse pointer, 32px on a fine one', () => {
    expect(ROW.split(' ')).toEqual(expect.arrayContaining(['py-1.5', 'pointer-coarse:min-h-11', 'pointer-coarse:py-2']))
  })
})

describe('newsletter form', () => {
  it('has a 44px email field below sm', () => {
    renderWithIntl(<SignupForm />, { locale: 'en' })

    expect(classesOf(screen.getByRole('textbox', { name: msg('Site.newsletter.form.emailLabel', undefined, 'en') }))).toContain(
      'max-sm:min-h-11',
    )
  })
})
