import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import type { Now } from '@/lib/site-content-types'
import { NowSection } from './NowSection'
import { currentTestLocale, TEST_LOCALE, translatorFor } from '@/test/intl'
import { msg } from '@/test/render-intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'

const UPDATED_LABEL = new RegExp(
  (translatorFor(currentTestLocale(), 'Site.home.now') as unknown as { raw(key: string): string }).raw('updated').split(' <')[0]!,
  'i',
)

const { now } = defaultSiteContent(TEST_LOCALE)

const fixture: Now = {
  lastUpdated: '2026-10-04',
  intro: 'A few things in progress.',
  // A MIXED fixture: one item with evidence, one without. A fixture of only items without
  // evidence would turn every link-counting assert into `0 === 0` — green while checking nothing.
  items: [{ text: 'First item', evidence: { href: '/tags/aws', label: 'post about AWS' } }, { text: 'Second item' }],
}

describe('NowSection', () => {
  it('renders the intro and one list item per entry', () => {
    render(<NowSection data={fixture} />)

    expect(screen.getByText('A few things in progress.')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['First item — post about AWS →', 'Second item'])
  })

  it('shows how stale the list is, formatted, with the raw date in the markup', () => {
    render(<NowSection data={fixture} />)

    const time = screen.getByText(LONG_DATE_VI(4, 10, 2026))
    expect(time.tagName).toBe('TIME')
    // The machine-readable value stays on the attribute even though the visible text is
    // localised, so a crawler and a reader see the same date.
    expect(time).toHaveAttribute('dateTime', '2026-10-04')
    // Formatted, not echoed. This is the assertion that fails if `timeZone: 'UTC'` is
    // dropped: the suite pins TZ to Asia/Ho_Chi_Minh, where '2026-10-04' is still the 4th
    // — so the zone guard is checked by the next test instead, which is honest about it.
    expect(time.textContent).not.toBe('2026-10-04')
    expect(screen.getByText(UPDATED_LABEL)).toBeInTheDocument()
  })

  it('formats a date that would shift zone, in UTC', () => {
    // Asia/Ho_Chi_Minh is UTC+7, so a UTC-midnight date only shifts westward. Checking a
    // date whose UTC instant is the previous local day in a negative-offset zone is not
    // possible from a single pinned TZ, so this test pins the other half: the formatter
    // must read the string as a UTC instant, which is why '2026-01-01' is the 1st of January and
    // not the 31st of December. A formatter left on the host zone would be wrong here for every
    // reader west of UTC.
    render(<NowSection data={{ ...fixture, lastUpdated: '2026-01-01' }} />)

    expect(screen.getByText(LONG_DATE_VI(1, 1, 2026))).toBeInTheDocument()
  })

  it('shows what the author typed when the date is not a date', () => {
    // Intl.DateTimeFormat.format THROWS a RangeError on an invalid date rather than
    // returning a placeholder, so without the guard a typo in a content file takes the
    // whole homepage down with a 500.
    render(<NowSection data={{ ...fixture, lastUpdated: 'unknown' }} />)

    const time = screen.getByText('unknown')
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('dateTime', 'unknown')
  })

  it('only renders a link for an item that has evidence, no padding to fill the count', () => {
    render(<NowSection data={fixture} />)

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(fixture.items.filter((item) => item.evidence).length)
    expect(links[0]).toHaveAttribute('href', '/tags/aws')
  })

  it('every piece of evidence in the packaged data points into this very site', () => {
    // An external link here would be a claim the site cannot verify. Internal destinations
    // are guarded by the sitemap and the route tests.
    const withEvidence = now.items.filter((item) => item.evidence)
    // The loop below must have something to check.
    expect(withEvidence.length).toBeGreaterThan(0)
    for (const item of withEvidence) expect(item.evidence!.href).toMatch(/^\//)
  })

  it('renders the packaged data it is given', () => {
    render(<NowSection data={now} />)

    expect(screen.getByText(now.intro)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(now.items.length)
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.home.now.title') })).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute('dateTime', now.lastUpdated)
  })

  describe('bare', () => {
    it('renders the section without a Container and without vertical padding', () => {
      const { container } = render(<NowSection bare data={fixture} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.tagName).toBe('SECTION')
      expect(root.className).not.toContain('mx-auto')
      expect(root.className).not.toContain('px-4')
      expect(root.className).not.toContain('max-w-')
      expect(root.className).not.toMatch(/(^|\s)(sm:)?py-/)
    })

    it('keeps the Container and the padding by default', () => {
      const { container } = render(<NowSection data={fixture} />)
      const root = container.firstElementChild as HTMLElement

      expect(root.className).toContain('mx-auto')
      expect(root.className).toContain('py-')
    })
  })

  it('names the bare section by its heading', () => {
    const { container } = render(<NowSection bare data={fixture} />)

    expect(container.querySelector('section')).toHaveAttribute('aria-labelledby', 'hien-tai')
    expect(container.querySelector('h2#hien-tai')).not.toBeNull()
  })
})
