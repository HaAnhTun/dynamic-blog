import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TocEntry } from '@/lib/markdown'
import { msg, renderWithIntl } from '@/test/render-intl'
import { RAIL_SLOT, RAIL_STICKY } from './reader-layout'
import { ReadingRail } from './ReadingRail'

const entry = (id: string, text: string, depth: 2 | 3 | 4 = 2): TocEntry => ({ depth, id, text })
const THREE: TocEntry[] = [entry('mot', 'Mot'), entry('hai', 'Hai', 3), entry('ba', 'Ba')]
const ACTIONS = <button type="button">Like</button>

const label = msg('Site.reader.railLabel')

describe('ReadingRail', () => {
  it('is an aside named by Site.reader.railLabel with the slot classes and print:hidden', () => {
    renderWithIntl(<ReadingRail toc={THREE} actions={ACTIONS} />)

    const aside = screen.getByRole('complementary', { name: label })
    expect(aside.tagName).toBe('ASIDE')
    for (const name of RAIL_SLOT.split(' ')) expect(aside).toHaveClass(name)
    expect(aside).toHaveClass('print:hidden')
  })

  it('has one sticky div without overflow, in which the TOC list is the only overflow-y-auto element', () => {
    const { container } = renderWithIntl(<ReadingRail toc={THREE} actions={ACTIONS} />)

    const sticky = container.querySelector('[data-rail-sticky]')!
    expect(container.querySelectorAll('[data-rail-sticky]')).toHaveLength(1)
    expect(sticky.parentElement).toBe(screen.getByRole('complementary', { name: label }))
    for (const name of RAIL_STICKY.split(' ')) expect(sticky).toHaveClass(name)
    expect(sticky.className).not.toMatch(/overflow/)

    const scrollers = container.querySelectorAll('.overflow-y-auto')
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0]).toBe(sticky.querySelector('ul[data-toc-list]'))
  })

  it('draws the progress, the rail TOC and the actions in that order, the actions shrink-0 and once', () => {
    const { container } = renderWithIntl(<ReadingRail toc={THREE} actions={ACTIONS} />)

    const sticky = container.querySelector('[data-rail-sticky]')!
    const parts = [...sticky.children] as HTMLElement[]
    // ReadingProgress renders the fixed bar and the meter, then the TOC nav, then the actions wrapper.
    expect(parts).toHaveLength(4)
    expect(parts[0]).toHaveClass('fixed')
    expect(parts[1]).toHaveClass('shrink-0')
    expect(parts[2]!.tagName).toBe('NAV')
    expect(parts[2]).toHaveAttribute('aria-labelledby', 'muc-luc-rail')
    expect(within(parts[2]!).getAllByRole('link', { hidden: true })).toHaveLength(3)
    expect(parts[3]).toHaveClass('shrink-0')
    expect(within(parts[3]!).getAllByRole('button', { name: 'Like' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Like' })).toHaveLength(1)
  })

  it('contains no heading', () => {
    renderWithIntl(<ReadingRail toc={THREE} actions={ACTIONS} />)
    expect(screen.queryAllByRole('heading', { hidden: true })).toHaveLength(0)
  })

  it('keeps the actions without a TOC (a post with fewer than three headings)', () => {
    const { container } = renderWithIntl(<ReadingRail toc={THREE.slice(0, 2)} actions={ACTIONS} />)

    expect(screen.getByRole('complementary', { name: label })).toBeInTheDocument()
    expect(container.querySelector('nav')).toBeNull()
    expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument()
  })

  it('keeps the TOC without actions', () => {
    const { container } = renderWithIntl(<ReadingRail toc={THREE} actions={null} />)

    expect(container.querySelector('nav[data-toc]')).not.toBeNull()
    expect(container.querySelector('[data-rail-sticky]')!.lastElementChild!.tagName).toBe('NAV')
  })

  it('renders nothing without a TOC and without actions', () => {
    const short = renderWithIntl(<ReadingRail toc={THREE.slice(0, 2)} actions={null} />)
    expect(short.container).toBeEmptyDOMElement()

    const none = renderWithIntl(<ReadingRail toc={[]} actions={null} />)
    expect(none.container).toBeEmptyDOMElement()
  })

  it('uses no side-dependent utility class', () => {
    const { container } = renderWithIntl(<ReadingRail toc={THREE} actions={ACTIONS} />)
    const side = /(?:^|[\s"':])(?:left|right|pl|pr|ml|mr)-\S|border-[lr](?:-\S|["\s])|text-(?:left|right)/
    expect(container.innerHTML).not.toMatch(side)
  })
})
