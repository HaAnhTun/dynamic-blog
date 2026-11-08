import { describe, expect, it } from 'vitest'
import type { TocEntry } from './markdown'
import { HEADING_SCROLL_MARGIN_PX, activeHeadingId, activeLinePx, nestToc, tocHref, tocRootMargin, type TocNode } from './toc'
import { TOC_IDS_VI } from '@/test/fixtures/vi/accented-text'

const entry = (depth: number, id: string): TocEntry => ({ depth, id, text: id.toUpperCase() })

/** A reduced tree for comparison: the id and its children. */
type Shape = [string, Shape[]]
const shape = (nodes: TocNode[]): Shape[] => nodes.map((node) => [node.id, shape(node.children)])

describe('nestToc', () => {
  it('nests by level, keeps the order and data of each item, does not modify the source list', () => {
    const flat = [entry(2, 'a'), entry(3, 'a1'), entry(4, 'a1x'), entry(3, 'a2'), entry(2, 'b'), entry(3, 'b1')]
    const copy = structuredClone(flat)

    const tree = nestToc(flat)

    expect(shape(tree)).toEqual([
      [
        'a',
        [
          ['a1', [['a1x', []]]],
          ['a2', []],
        ],
      ],
      ['b', [['b1', []]]],
    ])
    expect(tree[0]).toMatchObject({ depth: 2, id: 'a', text: 'A' })
    expect(flat).toEqual(copy)
    expect(nestToc([])).toEqual([])
  })

  it('a level jump (h2 → h4): nests one step, an h3 following is a sibling of that h4, no empty item in between', () => {
    expect(shape(nestToc([entry(2, 'a'), entry(4, 'x'), entry(3, 'y'), entry(4, 'z')]))).toEqual([
      [
        'a',
        [
          ['x', []],
          ['y', [['z', []]]],
        ],
      ],
    ])
  })

  it('a post opening deeper than h2: those items sit at the top level, so does the h2 after them', () => {
    expect(shape(nestToc([entry(3, 'x'), entry(4, 'x1'), entry(3, 'y'), entry(2, 'a'), entry(3, 'a1')]))).toEqual([
      ['x', [['x1', []]]],
      ['y', []],
      ['a', [['a1', []]]],
    ])
  })
})

describe('activeHeadingId', () => {
  const at = (...tops: number[]) => tops.map((top, index) => ({ id: `h${index}`, top }))

  it('the last heading fully past the line; before the first heading (the intro section) gives null', () => {
    expect(activeHeadingId([], 40)).toBeNull()
    expect(activeHeadingId(at(300, 900), 40)).toBeNull()
    expect(activeHeadingId(at(-500, 39.5, 41), 40)).toBe('h1')
    expect(activeHeadingId(at(-2000, -800, -10), 40)).toBe('h2')
  })

  it('exactly on the line is not past it: matches the IntersectionObserver "fully inside the root", does not highlight an item early', () => {
    expect(activeHeadingId(at(-100, 40), 40)).toBe('h0')
  })

  it('a heading just jumped to (top edge at header + scroll-margin, off by rounding) is the item being read', () => {
    // Sticky header: the scroll-padding-top of <html> is the header height, scroll-margin adds on top of it.
    for (const header of [0, 64, 97.5]) {
      const line = activeLinePx(header)
      expect(line).toBe(header + HEADING_SCROLL_MARGIN_PX + 8)
      for (const offset of [-1, 0, 1]) {
        const top = header + HEADING_SCROLL_MARGIN_PX + offset
        expect(activeHeadingId(at(-300, top, 600), line), `${header}/${top}`).toBe('h1')
      }
    }
  })

  it('the rootMargin of TocSpy starts exactly at the reading line, extending downward', () => {
    expect(tocRootMargin(activeLinePx(64))).toBe('-104px 0px 10000% 0px')
  })
})

describe('tocHref', () => {
  it('encodes the id, including accented letters, whitespace, # and %; decodes back to exactly the id', () => {
    for (const id of TOC_IDS_VI) {
      const href = tocHref(id)
      expect(href).toMatch(/^#[A-Za-z0-9\-_.!~*'()%]+$/)
      expect(decodeURIComponent(href.slice(1))).toBe(id)
    }
  })
})
