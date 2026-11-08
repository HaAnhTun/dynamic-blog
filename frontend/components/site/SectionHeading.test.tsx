import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  FOCUS,
  FOCUS_INSET,
  FOCUS_RING,
  ICON_TAP_TARGET,
  INLINE_LINK,
  SectionHeading,
  TAP_TARGET,
  TITLE_LINK,
  TRANSITION,
} from './SectionHeading'
import { msg } from '@/test/render-intl'

describe('SectionHeading', () => {
  it('renders an h2 carrying the id, so /#anchor lands on the heading itself', () => {
    render(<SectionHeading id="chang-duong" title={msg('Site.home.timeline.title')} />)

    const heading = screen.getByRole('heading', { level: 2, name: msg('Site.home.timeline.title') })
    // On the heading, not on a wrapper: an id on the outer div scrolls to the rule above
    // the heading and a screen reader announces nothing on arrival.
    expect(heading).toHaveAttribute('id', 'chang-duong')
  })

  it('renders no paragraph at all when there is no lead', () => {
    const { container } = render(<SectionHeading id="a" title="A" />)

    // Not `queryByText(...)` — an empty <p> still takes its top margin, so the absence
    // that matters is the element's, not the text's.
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders the lead when given one', () => {
    render(<SectionHeading id="a" title="A" lead="A lead line." />)

    expect(screen.getByText('A lead line.')).toBeInTheDocument()
  })

  it('renders no action link when no action is given', () => {
    render(<SectionHeading id="a" title="A" />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('names the action link by its label alone, with the arrow hidden', () => {
    render(<SectionHeading id="a" title="A" action={{ href: '/writing', label: msg('Site.startHere.allPosts') }} />)

    // An exact name. Without aria-hidden on the arrow this announces as
    // "<link text> right arrow", and a query by the exact link text fails.
    const link = screen.getByRole('link', { name: msg('Site.startHere.allPosts') })
    expect(link).toHaveAttribute('href', '/writing')
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe('→')
  })

  it('keeps a visible focus ring and a reduced-motion escape on both link treatments', () => {
    // jsdom applies no Tailwind CSS, so this is an assertion about the class strings and
    // nothing more — it cannot prove the ring paints. What it does catch is the real
    // regression: an edit that drops `focus-visible:outline-brand` from one of the two,
    // leaving half the links on the homepage with no visible focus state.
    for (const [name, classes] of [
      ['INLINE_LINK', INLINE_LINK],
      ['TITLE_LINK', TITLE_LINK],
    ] as const) {
      expect(classes, name).toContain('focus-visible:outline-2')
      expect(classes, name).toContain('focus-visible:outline-brand')
      expect(classes, name).toContain('motion-reduce:transition-none')
      // The brief caps animation at a 120ms colour or opacity transition.
      expect(classes, name).toContain('duration-[120ms]')
    }
  })
})

describe('shared focus and color-transition constants', () => {
  it('FOCUS = rounded-sm + FOCUS_RING; FOCUS_INSET draws the ring inward (negative offset)', () => {
    expect(FOCUS).toBe(`rounded-sm ${FOCUS_RING}`)
    expect(FOCUS_RING.split(' ')).toEqual([
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-brand',
    ])
    expect(FOCUS_INSET.split(' ')).toEqual([
      'focus-visible:outline-2',
      'focus-visible:-outline-offset-2',
      'focus-visible:outline-brand',
    ])
  })

  it('the share buttons and the series part row do not retype the focus ring or the color transition', () => {
    // Five hand-typed copies of one string match each other until one of them forgets a piece — a bug that no
    // test and no kind of error catches. These four files used to hand-type both.
    for (const file of ['ShareBar.tsx', 'CopyLink.tsx', 'NativeShare.tsx', 'SeriesBlock.tsx']) {
      const source = readFileSync(join(process.cwd(), 'components/site', file), 'utf8')
      expect(source, file).not.toMatch(/focus-visible:outline-offset-2|focus-visible:outline-brand/)
      expect(source, file).not.toContain('duration-[120ms]')
      expect(source, file).toContain('${FOCUS_RING} ${TRANSITION}')
    }
    expect(TRANSITION).toContain('duration-[120ms]')
  })
})

describe('invisible tap targets (TAP_TARGET, ICON_TAP_TARGET)', () => {
  it('ICON_TAP_TARGET: an absolute ::after extends 4px on each side — a 36px slot becomes a 44px tap target, taking no room', () => {
    // `after:-inset-1` = -0.25rem = 4px; 36 + 2 × 4 = 44. Equal on all four sides: the icon slot is square.
    expect(ICON_TAP_TARGET.split(' ')).toEqual(['relative', 'after:absolute', 'after:-inset-1'])
    // The same way as TAP_TARGET of text links: a `relative` element, the tap area is an absolute `::after`.
    expect(TAP_TARGET.split(' ').slice(0, 2)).toEqual(['relative', 'after:absolute'])
  })
})
