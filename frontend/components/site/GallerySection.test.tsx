import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mediaPath } from '@/lib/media'
import type { GalleryPhoto } from '@/lib/types'
import { tileSizes } from './GalleryGrid'
import { GallerySection } from './GallerySection'
import { msg } from '@/test/render-intl'

/**
 * The photos section of the home page and the About page: the same component, the six newest
 * photos, a 3-column grid, a "view all photos →" link. No photos means no section — no stray
 * heading, no hole.
 *
 * Two layouts because the two pages differ: the home page stacks `Container` bands (each carries
 * its own margins), while the About page already sits in a text column with margins — a Container nested in it would
 * indent a second time.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const photo = (n: number): GalleryPhoto => ({
  id: uuid(100 + n),
  image: {
    id: uuid(n),
    fileName: `${uuid(n)}.jpg`,
    width: 1600,
    height: 1200,
    altText: `Photo description number ${n}`,
    dominantColor: null,
  },
  caption: null,
  takenOn: null,
})

const SIX = [1, 2, 3, 4, 5, 6].map(photo)

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

describe('GallerySection', () => {
  it('renders nothing when there are no photos', () => {
    const { container } = render(<GallerySection id="anh" photos={[]} headingLevel={2} />)

    expect(container.innerHTML).toBe('')
  })

  it('band: the <section> is a reader-width Container carrying the margins, named by the h2 "Photos", link "See all photos" in the heading row', () => {
    const { container } = render(<GallerySection id="anh" photos={SIX} headingLevel={2} />)

    const section = container.firstElementChild!
    expect(section.tagName).toBe('SECTION')
    expect(section).toHaveAttribute('aria-labelledby', 'anh')
    // The same margins as every other home page section (page.test.tsx pins this for the whole page).
    expect(classesOf(section)).toEqual(
      expect.arrayContaining(['mx-auto', 'w-full', 'max-w-[87.5rem]', 'px-4', 'sm:px-6', 'py-8', 'sm:py-14']),
    )
    expect(classesOf(section)).not.toContain('max-w-5xl')

    const heading = screen.getByRole('heading', { level: 2, name: msg('Site.footer.links.gallery') })
    expect(heading).toHaveAttribute('id', 'anh')
    expect(screen.getByRole('region', { name: msg('Site.footer.links.gallery') })).toBe(section)

    const all = screen.getByRole('link', { name: msg('Site.gallery.seeAll') })
    expect(all).toHaveAttribute('href', '/gallery')
  })

  it('every passed photo is present, each a cell pointing to the original file, with a viewer', () => {
    const { container } = render(<GallerySection id="anh" photos={SIX} headingLevel={2} />)

    const tiles = within(container.querySelector('ul')!).getAllByRole('link')
    expect(tiles.map((a) => a.getAttribute('href'))).toEqual(SIX.map((p) => mediaPath(p.image)))
    expect(container.querySelectorAll('dialog')).toHaveLength(1)
    // The band grid: 6 columns from lg (3 below), images loaded by the band cell width.
    expect(classesOf(container.querySelector('ul'))).toEqual(
      expect.arrayContaining(['grid-cols-3', 'lg:grid-cols-6', 'gap-1', 'sm:gap-2']),
    )
    expect(container.querySelector('img')).toHaveAttribute('sizes', tileSizes(SIX[0]!.image, 'band'))
    // A block below the first screen: every cell is still lazy, none is prioritized.
    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveAttribute('loading', 'lazy')
      expect(img).not.toHaveAttribute('fetchpriority')
    }
  })

  it('bare: the heading and the grid only, no Container wrapper and no vertical padding', () => {
    const { container } = render(<GallerySection id="anh" photos={SIX} headingLevel={2} bare />)

    const section = container.firstElementChild!
    expect(section.tagName).toBe('SECTION')
    expect(section).toHaveAttribute('aria-labelledby', 'anh')
    // Nothing of the Container: no margins, no max width, no gutter, no py- padding.
    expect(section.getAttribute('class')).toBeNull()
    expect(container.querySelector(`:not(dialog, dialog *)[class*="max-w-"]`)).toBeNull()
    expect(container.querySelector(`:not(dialog, dialog *)[class*="px-"]`)).toBeNull()
    expect(container.querySelector(`:not(dialog, dialog *)[class*="py-"]`)).toBeNull()

    // Still the whole section: the named heading, the "see all" link in the heading row, the 6-column grid and the viewer.
    expect(screen.getByRole('region', { name: msg('Site.footer.links.gallery') })).toBe(section)
    expect(screen.getByRole('heading', { level: 2, name: msg('Site.footer.links.gallery') })).toHaveAttribute('id', 'anh')
    expect(screen.getByRole('link', { name: msg('Site.gallery.seeAll') })).toHaveAttribute('href', '/gallery')
    expect(classesOf(container.querySelector('ul'))).toContain('lg:grid-cols-6')
    expect(container.querySelectorAll('dialog')).toHaveLength(1)
  })

  it('bare with no photos still renders nothing', () => {
    const { container } = render(<GallerySection id="anh" photos={[]} headingLevel={2} bare />)

    expect(container.innerHTML).toBe('')
  })

  it('inside the About page frame (deprecated column layout, unchanged): the <section> adds no margins, h2 like the other sections, link below the grid', () => {
    const { container } = render(<GallerySection id="anh" photos={SIX} headingLevel={2} layout="column" />)

    const section = container.firstElementChild!
    expect(section.tagName).toBe('SECTION')
    expect(section).toHaveAttribute('aria-labelledby', 'anh')
    // The page frame already has margins: adding a Container here would indent a second time.
    expect(classesOf(section)).not.toContain('px-4')
    expect(classesOf(section)).not.toContain('mx-auto')
    // The "has one" pair: still spaced from the previous section like the other About page sections.
    expect(classesOf(section)).toContain('mt-12')

    const heading = screen.getByRole('heading', { level: 2, name: msg('Site.footer.links.gallery') })
    expect(heading).toHaveAttribute('id', 'anh')
    expect(classesOf(heading)).toEqual(expect.arrayContaining(['text-xl', 'font-semibold', 'tracking-tight']))

    const all = screen.getByRole('link', { name: msg('Site.gallery.seeAll') })
    expect(all).toHaveAttribute('href', '/gallery')
    // After the grid, not in the heading row.
    expect(container.querySelector('ul')!.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The text column of /about is narrower than the frame from lg (the right column is the profile card): `sizes` follows that column.
    expect(container.querySelector('img')).toHaveAttribute('sizes', tileSizes(SIX[0]!.image, 'column'))
  })

  it('the arrow of "See all photos →" is not part of the accessible name', () => {
    render(<GallerySection id="anh" photos={SIX} headingLevel={2} layout="column" />)

    const all = screen.getByRole('link', { name: msg('Site.gallery.seeAll') })
    expect(all.textContent).toContain('→')
    expect(within(all).getByText('→')).toHaveAttribute('aria-hidden', 'true')
  })
})
