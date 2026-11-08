import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HERO_BUTTON } from './hero-button'
import {
  ARTICLE_SLOT,
  BAND,
  BAR_FRAME,
  BODY_SLOT,
  BROWSE_GRID,
  BROWSE_MAIN,
  BROWSE_SIDE,
  CARD,
  CARD_PAGE,
  CASE_GRID,
  CASE_RAIL,
  CASE_RAIL_STICKY,
  END_SLOT,
  FRAME_MAX,
  FRAME_SIDES,
  HERO_SLOT,
  LEFT_SLOT,
  LEFT_STICKY,
  RAIL_SLOT,
  RAIL_STICKY,
  READER_GRID,
  SITE_MAIN,
  SPLIT_ASIDE,
  SPLIT_EVEN,
} from './reader-layout'

/**
 * reader-layout.ts is the one place that knows which side a column is on. These tests pin the shape of its class
 * strings (jsdom does not run Tailwind) and keep the rest of components/site/reader free of side-dependent classes.
 */

const SLOTS = { LEFT_SLOT, ARTICLE_SLOT, HERO_SLOT, BODY_SLOT, RAIL_SLOT, END_SLOT }
const SHELL = { FRAME_MAX, FRAME_SIDES, SITE_MAIN, BAR_FRAME }
const PAGES = {
  BROWSE_GRID,
  BROWSE_SIDE,
  BROWSE_MAIN,
  SPLIT_ASIDE,
  SPLIT_EVEN,
  CASE_GRID,
  CASE_RAIL,
  CASE_RAIL_STICKY,
  CARD,
  CARD_PAGE,
}
const ALL = { ...SHELL, READER_GRID, ...SLOTS, LEFT_STICKY, RAIL_STICKY, ...PAGES }

const tokens = (value: string) => value.split(/\s+/).filter(Boolean)

describe('reader-layout class strings', () => {
  it('the frame is 1400px (87.5rem) with side borders from the frame breakpoint, none on paper', () => {
    expect(FRAME_MAX).toBe('max-w-[87.5rem]')
    expect(FRAME_SIDES).toBe('frame:border-x frame:border-neutral-200 dark:frame:border-neutral-800 print:border-0')
    expect(BAR_FRAME).toBe(FRAME_SIDES)
    // No horizontal padding on the frame: every region owns its padding (the sidebar and the right column are full-bleed strips).
    for (const value of [FRAME_SIDES, SITE_MAIN]) {
      for (const token of tokens(value)) expect(token, token).not.toMatch(/(^|:)p[xlrse]?-\d/)
    }
  })

  it('main is the frame: centred, full width, a flex column that fills the page, a plain unbounded block on paper', () => {
    expect(SITE_MAIN).toBe(
      'mx-auto flex w-full flex-1 flex-col max-w-[87.5rem] frame:border-x frame:border-neutral-200 dark:frame:border-neutral-800 print:border-0 outline-none print:block print:max-w-none',
    )
    expect(tokens(SITE_MAIN)).toEqual(
      expect.arrayContaining([
        'mx-auto',
        'w-full',
        'flex-1',
        'flex-col',
        'max-w-[87.5rem]',
        'frame:border-x',
        'print:border-0',
        'outline-none',
        'print:block',
        'print:max-w-none',
      ]),
    )
  })

  it('the outer grid steps 1 / 2 columns (sidebar 14rem, then 16.25rem) and is a plain block on paper', () => {
    const list = tokens(READER_GRID)
    expect(READER_GRID).toContain('grid flex-1 grid-cols-1')
    expect(list).toContain('flex-1')
    expect(list).toContain('print:block')
    expect(list).toContain('lg:grid-cols-[14rem_minmax(0,1fr)]')
    expect(list).toContain('xl:grid-cols-[16.25rem_minmax(0,1fr)]')
    // The centre is fluid: there is nothing to centre, and no gap between the columns (the hairlines touch).
    expect(READER_GRID).not.toContain('justify-')
    expect(READER_GRID).not.toMatch(/gap-x/)
  })

  it('the article is a grid of its own: 1 column, then [1fr 13rem] from rail, [1fr 14.375rem] from xl', () => {
    const list = tokens(ARTICLE_SLOT)
    expect(list).toEqual(expect.arrayContaining(['grid', 'min-w-0', 'grid-cols-1', 'print:block', 'print:border-0']))
    expect(list).toContain('rail:grid-cols-[minmax(0,1fr)_13rem]')
    expect(list).toContain('xl:grid-cols-[minmax(0,1fr)_14.375rem]')
    expect(list).toEqual(expect.arrayContaining(['lg:col-start-2', 'lg:row-start-1', 'border-b']))
  })

  it('the browse grid has the post page tracks; the sidebar and the main column take one row, the sidebar first', () => {
    expect(BROWSE_GRID).toBe(
      'grid flex-1 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[16.25rem_minmax(0,1fr)] print:block',
    )
    expect(tokens(BROWSE_SIDE)).toEqual(
      expect.arrayContaining(['lg:col-start-1', 'lg:row-start-1', 'lg:border-e', 'lg:bg-neutral-50', 'print:hidden']),
    )
    expect(tokens(BROWSE_SIDE)).not.toContain('lg:row-span-2')
    expect(tokens(BROWSE_MAIN)).toEqual(
      expect.arrayContaining([
        'lg:col-start-2',
        'lg:row-start-1',
        'px-4',
        'sm:px-6',
        'lg:px-8',
        'xl:px-10',
        'pb-10',
        'sm:pb-14',
        'print:px-0',
      ]),
    )
    for (const slot of [BROWSE_SIDE, BROWSE_MAIN]) expect(tokens(slot)).toContain('min-w-0')
  })

  it('the showcase splits are top-aligned grids that are one column below lg', () => {
    for (const split of [SPLIT_ASIDE, SPLIT_EVEN]) {
      expect(tokens(split)).toEqual(expect.arrayContaining(['grid', 'items-start', 'gap-y-10']))
      expect(tokens(split)).not.toContain('grid-cols-1')
      for (const token of tokens(split).filter((item) => item.includes('grid-cols'))) expect(token, token).toMatch(/^(lg|xl):/)
    }
    expect(tokens(SPLIT_ASIDE)).toEqual(
      expect.arrayContaining(['lg:grid-cols-[minmax(0,1fr)_20rem]', 'xl:grid-cols-[minmax(0,1fr)_24rem]']),
    )
    expect(tokens(SPLIT_EVEN)).toContain('lg:grid-cols-2')
  })

  it('the case-study grid and rail follow the post article tracks; the rail is ruled and never printed', () => {
    expect(tokens(CASE_GRID)).toEqual(
      expect.arrayContaining([
        'grid',
        'min-w-0',
        'grid-cols-1',
        'rail:grid-cols-[minmax(0,1fr)_13rem]',
        'xl:grid-cols-[minmax(0,1fr)_14.375rem]',
        'print:block',
      ]),
    )
    expect(tokens(CASE_RAIL)).toEqual(
      expect.arrayContaining(['hidden', 'rail:block', 'rail:border-s', 'dark:rail:border-neutral-800', 'print:hidden']),
    )
    expect(CASE_RAIL_STICKY).toBe(RAIL_STICKY)
  })

  it('the card is a hairline box with a centred-page padding recipe', () => {
    expect(CARD_PAGE).toBe('py-8 sm:py-16')
    expect(tokens(CARD)).toEqual(
      expect.arrayContaining([
        'rounded-card',
        'border',
        'bg-neutral-50',
        'p-4',
        'sm:p-8',
        'dark:border-neutral-800',
        'dark:bg-neutral-900',
      ]),
    )
  })

  it('a band of a page is 32px above and below on a phone, 56px from sm', () => {
    expect(BAND).toBe('py-8 sm:py-14')
  })

  it('every string is well formed: no duplicated token, balanced brackets and parentheses', () => {
    for (const [name, value] of Object.entries(ALL)) {
      const list = tokens(value)
      expect(new Set(list).size, name).toBe(list.length)
      for (const token of list) {
        expect(token.split('[').length, `${name}: ${token}`).toBe(token.split(']').length)
        expect(token.split('(').length, `${name}: ${token}`).toBe(token.split(')').length)
      }
    }
  })

  it('no string uses order-', () => {
    for (const [name, value] of Object.entries(ALL)) {
      for (const token of tokens(value)) expect(token, `${name}: ${token}`).not.toMatch(/(^|:)-?order-/)
    }
  })

  it('placement (col-/row- start, span, end) is always behind lg: or rail:, so below lg the DOM order is the visual order', () => {
    for (const [name, value] of Object.entries(ALL)) {
      for (const token of tokens(value)) {
        if (/(^|:)(col|row)-(start|end|span)-/.test(token)) {
          expect(token, `${name}: ${token}`).toMatch(/^(dark:)?(lg|rail):/)
        }
      }
    }
  })

  it('the slots place the sidebar (left, full height), the article, the hero (both inner columns) and the end blocks', () => {
    expect(tokens(LEFT_SLOT)).toEqual(
      expect.arrayContaining(['lg:col-start-1', 'lg:row-start-1', 'lg:row-span-2', 'lg:border-e', 'lg:bg-neutral-50']),
    )
    expect(tokens(HERO_SLOT)).toContain('rail:col-span-2')
    expect(tokens(END_SLOT)).toEqual(expect.arrayContaining(['lg:col-start-2', 'lg:row-start-2']))
    for (const slot of [LEFT_SLOT, ARTICLE_SLOT, HERO_SLOT, BODY_SLOT, RAIL_SLOT, END_SLOT]) {
      expect(tokens(slot)).toContain('min-w-0')
    }
  })

  it('the rails are never printed; the hero and the body drop their padding on paper', () => {
    expect(tokens(LEFT_SLOT)).toContain('print:hidden')
    expect(tokens(RAIL_SLOT)).toContain('print:hidden')
    expect(tokens(HERO_SLOT)).toContain('print:px-0')
    expect(tokens(BODY_SLOT)).toContain('print:px-0')
  })

  it('the right column is ruled on its inner edge from rail, in both themes', () => {
    expect(tokens(RAIL_SLOT)).toEqual(
      expect.arrayContaining(['rail:border-s', 'rail:border-neutral-200', 'dark:rail:border-neutral-800']),
    )
  })

  it('the end blocks carry their own air, a readable width and the first-child border reset', () => {
    expect(tokens(END_SLOT)).toEqual(
      expect.arrayContaining([
        'pt-8',
        'pb-8',
        'sm:pt-10',
        'sm:pb-14',
        'lg:max-w-[56rem]',
        '[&>:first-child]:border-t-0',
        '[&>nav:first-child]:pt-0',
      ]),
    )
  })

  it('the hero and the body step their padding 16 / 24 / 32 / 40px', () => {
    for (const slot of [HERO_SLOT, BODY_SLOT]) {
      expect(tokens(slot)).toEqual(expect.arrayContaining(['px-4', 'sm:px-6', 'lg:px-8', 'xl:px-10']))
    }
  })

  it('the stickiness starts where the column exists: left from lg, right from rail; both tops read the visible header height', () => {
    for (const token of tokens(LEFT_STICKY)) expect(token, token).toMatch(/^lg:/)
    for (const token of tokens(RAIL_STICKY)) expect(token, token).toMatch(/^rail:/)
    expect(tokens(LEFT_STICKY)).toContain('lg:sticky')
    expect(tokens(RAIL_STICKY)).toContain('rail:sticky')
    expect(tokens(LEFT_STICKY)).toContain('lg:top-[var(--site-header-visible-h)]')
    expect(tokens(RAIL_STICKY)).toContain('rail:top-[calc(var(--site-header-visible-h)+1.5rem)]')
    // The sticky scrollers measure from the visible part of the header only, never the measured height that stays while it slides away.
    for (const value of [LEFT_STICKY, RAIL_STICKY]) {
      expect(value).toContain('--site-header-visible-h')
      expect(value).not.toMatch(/--site-header-h(?!-)/)
    }
    // The inner padding is inside the scroller, so a focus outline at its edge is not clipped.
    expect(tokens(LEFT_STICKY)).toEqual(
      expect.arrayContaining(['lg:overflow-y-auto', 'lg:overscroll-contain', 'lg:py-6', 'lg:ps-6', 'lg:pe-4']),
    )
  })

  it('the layout has no lg centring', () => {
    for (const [name, value] of Object.entries(ALL)) expect(value, name).not.toMatch(/justify-(center|normal)/)
  })
})

describe('HERO_BUTTON', () => {
  it('is the single hairline button recipe (44px on a phone, 40px from sm), with the shared focus ring and transition', () => {
    const list = tokens(HERO_BUTTON)
    expect(list).toEqual(
      expect.arrayContaining([
        'inline-flex',
        'h-11',
        'sm:h-10',
        'items-center',
        'gap-2',
        'rounded-lg',
        'border',
        'border-neutral-200',
        'px-3.5',
        'text-sm',
        'font-medium',
        'hover:border-brand',
        'hover:text-brand',
        'dark:border-neutral-800',
        'focus-visible:outline-2',
        'motion-reduce:transition-none',
      ]),
    )
    expect(new Set(list).size).toBe(list.length)
    // Mirroring stays a one-file change: the recipe is side-neutral.
    for (const token of list) expect(token, token).not.toMatch(/^(-?(left|right|pl|pr|ml|mr)-|border-[lr](-|$))/)
  })
})

describe('components/site/reader/*.tsx has no side-dependent classes', () => {
  /** Comments stripped: a note may say "left" without being a class. */
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const SIDE_CLASS =
    /(?<=^|[\s'"`:{(])(?:-?(?:left|right|pl|pr|ml|mr)-\S|border-[lr](?:-\S|(?=[\s'"`]))|text-(?:left|right)(?=[\s'"`]))/

  const dir = __dirname
  const files = readdirSync(dir).filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))

  it('the scanner catches the classes it is meant to catch', () => {
    for (const bad of ['pl-4', 'lg:pr-2', 'border-l', 'border-r-2', 'text-left', 'text-right', '-ml-1', 'left-0', 'right-2']) {
      expect(SIDE_CLASS.test(`className="x ${bad} y"`), bad).toBe(true)
    }
    for (const good of [
      'ps-4',
      'pe-2',
      'border-s',
      'border-e-2',
      'text-start',
      'text-end',
      '-ms-1',
      'start-0',
      'end-2',
      'px-1',
      'leftover',
    ]) {
      expect(SIDE_CLASS.test(`className="x ${good} y"`), good).toBe(false)
    }
  })

  it('none of the reader components uses left-, right-, pl-, pr-, ml-, mr-, border-l, border-r, text-left or text-right', () => {
    for (const name of files) {
      const source = stripComments(readFileSync(join(dir, name), 'utf8'))
      const match = SIDE_CLASS.exec(source)
      expect(match?.[0], `${name} uses a side-dependent class`).toBeUndefined()
    }
  })
})
