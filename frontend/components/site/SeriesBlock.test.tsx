import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PostSummary, SeriesDetail } from '@/lib/types'
import { SeriesBlock, seriesRows } from './SeriesBlock'
import { msg } from '@/test/render-intl'
import { currentTestLocale, translatorFor } from '@/test/intl'

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const rawMsg = (key: string) => (translatorFor(currentTestLocale()) as unknown as { raw(key: string): string }).raw(key)
const VIEW_ALL_NAME = rawMsg('Site.seriesBlock.viewAll').replace(/ <arrow>.*<\/arrow>/, '')
const PART_TWO_OF_THREE = new RegExp(escapeRe(msg('Site.seriesBlock.partOf', { current: 2, total: 3 }).split(' · ').pop()!))

/**
 * The series block in a post: a left-ruled list like Timeline, a brand bar on the part being
 * read, `aria-current="true"` + sr-only "currently reading" text, "Part n/m"; beyond 7 parts the list becomes a window.
 */

const SLUG = 'async-pipeline-on-aws'

const part = (n: number, count: number): PostSummary => ({
  id: `p${n}`,
  // The title contains no number, so the sequence number in the list can only come from the block.
  title: `Part title ${String.fromCharCode(64 + n)}`,
  slug: `phan-${n}`,
  excerpt: null,
  status: 'PUBLISHED',
  category: null,
  tags: [],
  publishedAt: '2026-10-03T08:00:00Z',
  featured: false,
  readingMinutes: 5,
  series: { id: 's1', slug: SLUG, title: 'Async pipeline on AWS', position: n, partNumber: n, partCount: count },
})

const detail = (count: number): SeriesDetail => ({
  id: 's1',
  title: 'Async pipeline on AWS',
  slug: SLUG,
  description: null,
  posts: Array.from({ length: count }, (_, i) => part(i + 1, count)),
})

/** The sequence number shown on each row (including the row being read), "…" for a gap row. */
function shownNumbers(container: HTMLElement): string[] {
  return [...container.querySelectorAll('ol > li')].map((li) =>
    li.getAttribute('aria-hidden') === 'true' ? '…' : (li.querySelector('[data-part-number]')?.textContent ?? '?'),
  )
}

describe('SeriesBlock', () => {
  it('is a nav named after the series, listing every part in reading order', () => {
    const { container } = render(<SeriesBlock series={detail(3)} currentSlug="phan-2" />)

    const nav = screen.getByRole('navigation', { name: 'Async pipeline on AWS' })
    expect(within(nav).getByRole('list').tagName).toBe('OL')
    expect(shownNumbers(container)).toEqual(['1', '2', '3'])
    // The series name leads to the series page.
    expect(within(nav).getByRole('link', { name: 'Async pipeline on AWS' })).toHaveAttribute('href', `/series/${SLUG}`)
  })

  it('the part being read is not a link: aria-current="true", sr-only "(currently reading)", brand bar', () => {
    const { container } = render(<SeriesBlock series={detail(3)} currentSlug="phan-2" />)

    const current = container.querySelector('li[aria-current="true"]')
    expect(current).not.toBeNull()
    expect(current?.textContent).toContain('Part title B')
    expect(current?.querySelector('.sr-only')?.textContent?.trim()).toBe(msg('Site.seriesBlock.currentPart'))
    expect(current?.querySelector('a')).toBeNull()
    expect(current?.querySelector('.border-brand')).not.toBeNull()
    // Exactly one part is the part being read, and the other parts are links to their posts.
    expect(container.querySelectorAll('[aria-current]')).toHaveLength(1)
    expect(container.querySelectorAll('ol .border-brand')).toHaveLength(1)
    expect(screen.getByRole('link', { name: /Part title A/ })).toHaveAttribute('href', '/posts/phan-1')
    expect(screen.getByRole('link', { name: /Part title C/ })).toHaveAttribute('href', '/posts/phan-3')
    expect(screen.queryByRole('link', { name: /Part title B/ })).not.toBeInTheDocument()
  })

  it('writes "Part n/m" by position among the published parts', () => {
    render(<SeriesBlock series={detail(3)} currentSlug="phan-2" />)

    expect(screen.getByText(PART_TWO_OF_THREE)).toBeInTheDocument()
  })

  it('up to 7 parts: shows all, no "…", no "view all"', () => {
    const { container } = render(<SeriesBlock series={detail(7)} currentSlug="phan-4" />)

    expect(shownNumbers(container)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(container.querySelector('li[aria-hidden="true"]')).toBeNull()
    expect(screen.queryByRole('link', { name: VIEW_ALL_NAME })).not.toBeInTheDocument()
  })

  it('beyond 7 parts: first, …, n−1, n, n+1, …, last, and "view all →"', () => {
    const { container } = render(<SeriesBlock series={detail(10)} currentSlug="phan-5" />)

    expect(shownNumbers(container)).toEqual(['1', '…', '4', '5', '6', '…', '10'])
    // The "…" row is hidden from the accessibility tree: the list reads out exactly the number of parts being shown.
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(5)
    const all = screen.getByRole('link', { name: VIEW_ALL_NAME })
    expect(all).toHaveAttribute('href', `/series/${SLUG}`)
  })

  it('a gap that hides only one part shows that part instead of "…"', () => {
    const { container } = render(<SeriesBlock series={detail(8)} currentSlug="phan-4" />)

    // Part 2 stands alone between part 1 and part 3: a "…" would take exactly its place while hiding
    // a title, so it is shown.
    expect(shownNumbers(container)).toEqual(['1', '2', '3', '4', '5', '…', '8'])
  })

  it('does not render when the post is not among the published parts', () => {
    const { container } = render(<SeriesBlock series={detail(3)} currentSlug="bai-khac" />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('seriesRows', () => {
  it('first part being read: no gap before it', () => {
    expect(seriesRows(10, 0)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'part', index: 1 },
      { kind: 'gap', after: 1 },
      { kind: 'part', index: 9 },
    ])
  })

  it('last part being read: no gap after it', () => {
    expect(seriesRows(10, 9)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'gap', after: 0 },
      { kind: 'part', index: 8 },
      { kind: 'part', index: 9 },
    ])
  })
})
