import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TocEntry } from '@/lib/markdown'
import { tocHref } from '@/lib/toc'
import { translatorFor } from '@/test/intl'
import { msg } from '@/test/render-intl'
import { MIN_TOC_ENTRIES as FROM_ARTICLE_VIEW } from './ArticleView'
import { MIN_TOC_ENTRIES, TocNav } from './TocNav'

const t = translatorFor('vi', 'Site.article')

const entry = (id: string, text: string, depth: 2 | 3 | 4): TocEntry => ({ depth, id, text })

/** h2, h3 under it, h2: nested in the inline list as well as in the rail list. */
const THREE: TocEntry[] = [entry('mot', 'Mot', 2), entry('hai', 'Hai', 3), entry('ba', 'Ba', 2)]
const FOUR_LEVELS: TocEntry[] = [entry('a', 'A', 2), entry('b', 'B', 3), entry('c', 'C', 4), entry('d', 'D', 2)]

const eyebrow = msg('Site.article.toc')

describe('TocNav', () => {
  it('MIN_TOC_ENTRIES is exported from TocNav and still importable from ArticleView', () => {
    expect(MIN_TOC_ENTRIES).toBe(3)
    expect(FROM_ARTICLE_VIEW).toBe(MIN_TOC_ENTRIES)
  })

  it.each(['inline', 'rail'] as const)('%s: renders nothing under MIN_TOC_ENTRIES entries', (variant) => {
    const { container, rerender } = render(<TocNav variant={variant} toc={THREE.slice(0, 2)} t={t} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<TocNav variant={variant} toc={[]} t={t} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<TocNav variant={variant} toc={THREE} t={t} />)
    expect(container).not.toBeEmptyDOMElement()
  })

  describe('inline', () => {
    it('with `spy` (a page without a reading rail) stays visible at every width and carries the TocSpy', () => {
      const { container } = render(<TocNav variant="inline" toc={THREE} t={t} spy />)

      const nav = screen.getByRole('navigation', { name: eyebrow })
      expect(nav).not.toHaveClass('rail:hidden')
      expect(nav).toHaveClass('print:hidden')
      expect(container.querySelector('details')).not.toHaveAttribute('open')
    })

    it('is a <details> closed in the server HTML at every width, with no always-open or absolute classes', () => {
      const { container } = render(<TocNav variant="inline" toc={THREE} t={t} />)

      const nav = screen.getByRole('navigation', { name: eyebrow })
      expect(container.querySelector('details')).not.toHaveAttribute('open')
      expect(nav).toHaveAttribute('data-toc')
      expect(nav).toHaveClass('rail:hidden', 'print:hidden')
      expect(container.querySelector('#muc-luc')).toHaveTextContent(eyebrow)
      expect(nav.getAttribute('aria-labelledby')).toBe('muc-luc')
      // Only the rail breakpoint may appear as a variant: no md:/xl:/lg:/sm: always-open or gutter classes.
      expect(container.innerHTML).not.toMatch(/(?:^|[\s"])(?:md|xl|lg|sm):/)
      expect(container.innerHTML).not.toMatch(/details-content|pointer-events-none|\babsolute\b|\bsticky\b/)
      // The arrow is always shown now.
      expect(container.querySelector('summary svg.shrink-0')).not.toBeNull()
      expect(container.querySelector('ul[data-toc-list]')).toBeNull()
    })

    it('on a phone each entry is a 44px row at 15px with no gap between rows; the card has 24px of air above and below on a phone and 32px from sm', () => {
      const { container } = render(<TocNav variant="inline" toc={THREE} t={t} />)

      const nav = screen.getByRole('navigation', { name: eyebrow })
      expect(nav).toHaveClass('my-8', 'max-sm:my-6')
      for (const link of container.querySelectorAll('li a')) {
        expect(link).toHaveClass('max-sm:flex', 'max-sm:min-h-11', 'max-sm:items-center', 'max-sm:text-[0.9375rem]')
      }
      expect(container.querySelector('details ul')).toHaveClass('max-sm:space-y-0')
    })

    it('the list scrolls itself above 60dvh; links keep nesting and hrefs', () => {
      const { container } = render(<TocNav variant="inline" toc={FOUR_LEVELS} t={t} />)

      const list = container.querySelector('details > ul') as HTMLElement
      expect(list).toHaveClass('max-h-[60dvh]', 'overflow-y-auto')
      const links = within(list).getAllByRole('link')
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['a', 'b', 'c', 'd'].map(tocHref))
      // b is nested in a, c in b, d is top level again.
      expect(links[1]!.closest('ul')!.parentElement).toBe(links[0]!.closest('li'))
      expect(links[2]!.closest('ul')!.parentElement).toBe(links[1]!.closest('li'))
      expect(links[3]!.closest('ul')).toBe(list)
    })

    it('three entries: three links', () => {
      render(<TocNav variant="inline" toc={THREE} t={t} />)
      expect(within(screen.getByRole('navigation')).getAllByRole('link')).toHaveLength(3)
    })
  })

  describe('rail', () => {
    it('is a plain scrolling list (no <details>), hidden below the rail breakpoint, named by its own id', () => {
      const { container } = render(<TocNav variant="rail" toc={THREE} t={t} />)

      const nav = container.querySelector('nav')!
      expect(nav.getAttribute('aria-labelledby')).toBe('muc-luc-rail')
      expect(nav).toHaveAttribute('data-toc')
      expect(nav).toHaveClass('hidden', 'min-h-0', 'flex-1', 'flex-col', 'rail:flex', 'print:hidden')
      expect(container.querySelector('details')).toBeNull()
      const label = container.querySelector('p#muc-luc-rail')!
      expect(label).toHaveTextContent(eyebrow)
      expect(label).toHaveClass('shrink-0')
      expect(container.querySelectorAll('ul[data-toc-list]')).toHaveLength(1)
      expect(container.querySelector('ul[data-toc-list]')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'px-1', '-mx-1')
    })

    it('three entries: three links; nesting stays; the active style changes color only', () => {
      const { container } = render(<TocNav variant="rail" toc={FOUR_LEVELS} t={t} />)

      const links = [...container.querySelectorAll('a')]
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['a', 'b', 'c', 'd'].map(tocHref))
      expect(links[1]!.closest('ul')!.parentElement).toBe(links[0]!.closest('li'))
      // Deeper levels indent more, so the start border of every link stays on one line.
      expect(links.map((a) => [...a.classList].find((c) => /^ps-\d+$/.test(c)))).toEqual(['ps-3', 'ps-6', 'ps-9', 'ps-3'])
      for (const a of links) {
        expect(a).toHaveClass('aria-[current=location]:text-brand', 'aria-[current=location]:border-brand', 'border-s')
        expect(a.className).not.toMatch(/font-(medium|semibold|bold)/)
      }
    })

    it('three entries: three links', () => {
      render(<TocNav variant="rail" toc={THREE} t={t} />)
      expect(within(screen.getByRole('navigation', { hidden: true })).getAllByRole('link', { hidden: true })).toHaveLength(3)
    })
  })

  it('the two ids never collide when both navs are on the page, and both are not printed', () => {
    const { container } = render(
      <>
        <TocNav variant="inline" toc={THREE} t={t} />
        <TocNav variant="rail" toc={THREE} t={t} />
      </>,
    )

    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id)
    expect(ids).toEqual(['muc-luc', 'muc-luc-rail'])
    expect(container.querySelectorAll('nav[data-toc].print\\:hidden')).toHaveLength(2)
  })

  it('logical utilities only', () => {
    const { container } = render(
      <>
        <TocNav variant="inline" toc={FOUR_LEVELS} t={t} />
        <TocNav variant="rail" toc={FOUR_LEVELS} t={t} />
      </>,
    )

    expect(container.innerHTML).not.toMatch(
      /(?:^|[\s"])-?(?:pl|pr|ml|mr|left|right|border-l|border-r|text-left|text-right)(?:-|\s|")/,
    )
  })
})
