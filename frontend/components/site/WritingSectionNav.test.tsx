import { render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ArchiveIcon, LayersIcon, NewspaperIcon, TagsIcon } from '@/components/icons'
import { WritingSectionNav } from './WritingSectionNav'
import { msg } from '@/test/render-intl'

/** The four ways to view posts, in display order: the `current` key, label, destination, icon. */
const SECTIONS = [
  ['latest', msg('Site.listing.sectionNav.latest'), '/writing', <NewspaperIcon key="latest" />],
  ['series', 'Series', '/series', <LayersIcon key="series" />],
  ['topics', msg('Site.footer.links.topics'), '/topics', <TagsIcon key="topics" />],
  ['archive', msg('Site.footer.links.archive'), '/archive', <ArchiveIcon key="archive" />],
] as const

/** The drawn part of an icon; see the comment of the same name in Header.test.tsx. */
function glyphOf(icon: ReactElement): string {
  const { container, unmount } = render(icon)
  const markup = container.querySelector('svg')!.innerHTML
  unmount()
  return markup
}

function sectionNav(): HTMLElement {
  return screen.getByRole('navigation', { name: msg('Site.listing.sectionNav.label') })
}

const classesOf = (el: Element) => el.className.split(/\s+/)

describe('WritingSectionNav', () => {
  it('is a named nav, with four links in the right order and the right destinations', () => {
    render(<WritingSectionNav current="latest" />)

    const links = within(sectionNav()).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual(SECTIONS.map(([, label]) => label))
    expect(links.map((a) => a.getAttribute('href'))).toEqual(SECTIONS.map(([, , href]) => href))
  })

  it.each(SECTIONS.map(([key, label]) => [key, label] as const))(
    'current="%s": exactly one item carries aria-current="page", which is %s',
    (key, label) => {
      render(<WritingSectionNav current={key} />)

      const marked = sectionNav().querySelectorAll('[aria-current]')
      expect(marked).toHaveLength(1)
      expect(marked[0]).toHaveAttribute('aria-current', 'page')
      expect(marked[0]).toHaveAccessibleName(label)
    },
  )

  it('highlights the current item with brand color and medium-weight text, not a solid-background pill', () => {
    render(<WritingSectionNav current="topics" />)

    expect(classesOf(screen.getByRole('link', { name: msg('Site.footer.links.topics') }))).toEqual(
      expect.arrayContaining(['text-brand', 'font-medium']),
    )
    for (const label of [msg('Site.listing.sectionNav.latest'), 'Series', msg('Site.footer.links.archive')]) {
      const other = classesOf(screen.getByRole('link', { name: label }))
      expect(other, label).not.toContain('text-brand')
      expect(other, label).not.toContain('font-medium')
    }
    // no solid-background pill, on any item.
    for (const link of screen.getAllByRole('link')) {
      expect(classesOf(link).filter((c) => /^(dark:)?bg-/.test(c))).toEqual([])
    }
  })

  it('each item has its own icon, hidden from screen readers; the link name is only the text', () => {
    render(<WritingSectionNav current="latest" />)

    for (const [, label, , icon] of SECTIONS) {
      // Exact name: an aria-hidden icon contributes nothing to the name.
      const svgs = screen.getByRole('link', { name: label }).querySelectorAll('svg')
      expect(svgs, label).toHaveLength(1)
      expect(svgs[0]).toHaveAttribute('aria-hidden', 'true')
      expect(svgs[0]).toHaveAttribute('focusable', 'false')
      expect(svgs[0]!.innerHTML, label).toBe(glyphOf(icon))
    }
  })

  it('wraps when out of room, not a horizontal scrollbar', () => {
    // An item pushed outside a scroll frame is an item a phone reader does not know
    // exists; four short labels wrapping onto a new line is enough.
    render(<WritingSectionNav current="latest" />)
    const list = classesOf(sectionNav().querySelector('ul')!)

    expect(list).toEqual(expect.arrayContaining(['flex', 'flex-wrap']))
    expect(list.filter((c) => c.startsWith('overflow-'))).toEqual([])
  })

  it('accepts an extra class from the page placing it, so the page decides the spacing above', () => {
    render(<WritingSectionNav current="archive" className="mt-6" />)

    expect(classesOf(sectionNav())).toContain('mt-6')
  })
})

describe('WritingSectionNav on a phone', () => {
  it('gap-x-4, gap-x-6 from 640px: four items fit one line at 390px', () => {
    render(<WritingSectionNav current="latest" />)
    const list = screen.getByRole('navigation', { name: msg('Site.listing.sectionNav.label') }).querySelector('ul')!

    // 82 + 66 + 71 + 71px plus three 24px gaps is 362px in 358px: the archive item drops alone.
    expect(list).toHaveClass('gap-x-4', 'sm:gap-x-6')
    expect(list).not.toHaveClass('gap-x-6')
  })

  it('each link has an enlarged tap target (TAP_TARGET) while the text does not change', () => {
    render(<WritingSectionNav current="series" />)

    for (const link of screen.getAllByRole('link'))
      expect(link).toHaveClass('relative', 'after:absolute', 'after:-inset-x-1.5', 'after:-inset-y-2.5')
  })
})
