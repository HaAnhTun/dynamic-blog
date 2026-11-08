import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SeriesMeta } from './SeriesMeta'
import { currentTestLocale, translatorFor } from '@/test/intl'
import { msg } from '@/test/render-intl'
import { LONG_DATE_VI } from '@/test/fixtures/vi/site-dates'

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const rawMsg = (key: string) => (translatorFor(currentTestLocale()) as unknown as { raw(key: string): string }).raw(key)
const exactly = (text: string) => new RegExp(`^${escapeRe(text)}$`)
const PARTS_2_MINUTES_14 = `${msg('Site.listing.seriesMeta.parts', { count: 2 })} · ${msg('Site.listing.seriesMeta.readingMinutes', { minutes: 14 })}`
const UPDATED_PREFIX = rawMsg('Site.listing.seriesMeta.updated').split(' <')[0]!

/**
 * The series meta line (/series, /series/[slug], /start-here). The previous version was plain text running on inside an
 * inline-flex containing the icon, so the "[Layers] 3 parts" group took its baseline from the SVG and stood 2px higher than the
 * rest. Now each piece is a flex item, centered vertically.
 */
describe('SeriesMeta', () => {
  it('one flex items-center row, each piece a flex item, the · dot separate and aria-hidden', () => {
    const { container } = render(<SeriesMeta parts={3} minutes={36} />)

    const line = container.firstElementChild!
    expect(line.tagName).toBe('P')
    expect(line).toHaveClass('flex', 'flex-wrap', 'items-center', 'gap-x-1.5')
    // No more bare text beside the spans: every visible piece is a child element.
    const bare = Array.from(line.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())
    expect(bare).toEqual([])
    const dots = Array.from(line.children).filter((el) => el.textContent === '·')
    expect(dots).toHaveLength(1)
    expect(dots[0]).toHaveAttribute('aria-hidden', 'true')
    expect(line.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    // textContent still reads as a sentence: exactly the string the /start-here page and e2e look for.
    expect(line).toHaveTextContent(
      exactly(
        `${msg('Site.listing.seriesMeta.parts', { count: 3 })} · ${msg('Site.listing.seriesMeta.readingMinutes', { minutes: 36 })}`,
      ),
    )
  })

  it('with an updated date it adds "· updated <time>"; a broken date drops the whole piece', () => {
    const { container, rerender } = render(
      <SeriesMeta parts={2} minutes={14} updatedAt="2026-10-05T03:00:00Z" className="mt-2" />,
    )
    const line = container.firstElementChild!
    expect(line).toHaveClass('mt-2')
    expect(line).toHaveTextContent(exactly(`${PARTS_2_MINUTES_14} · ${UPDATED_PREFIX} ${LONG_DATE_VI(5, 10, 2026)}`))
    expect(screen.getByText(LONG_DATE_VI(5, 10, 2026)).tagName).toBe('TIME')
    expect(screen.getByText(LONG_DATE_VI(5, 10, 2026))).toHaveAttribute('dateTime', '2026-10-05T03:00:00Z')

    rerender(<SeriesMeta parts={2} minutes={14} updatedAt="not a date" />)
    expect(container.firstElementChild).toHaveTextContent(exactly(PARTS_2_MINUTES_14))
  })
})
