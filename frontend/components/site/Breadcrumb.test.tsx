import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import type { Category } from '@/lib/types'
import { Breadcrumb, breadcrumbTrail, SeriesBreadcrumb, seriesBreadcrumbTrail } from './Breadcrumb'
import { msg } from '@/test/render-intl'
import { ACCENTED_CATEGORY_SLUG } from '@/test/fixtures/vi/breadcrumb'

/**
 * The trail at the top of the post page: "Writing / [Folder] category". The category moved out of the meta row
 * up here, so this is the ONLY category link of the post page (the post page test pins that).
 */

const category: Category = { id: 'c1', name: 'Architecture', slug: 'architecture', description: null }

describe('Breadcrumb', () => {
  it('is a "Breadcrumb" nav with one <ol>: "Writing" then the category, one link per entry', () => {
    render(<Breadcrumb category={category} />)

    const nav = screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })
    expect(within(nav).getByRole('list').tagName).toBe('OL')
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      [msg('Site.footer.links.writing'), '/writing'],
      ['Architecture', '/categories/architecture'],
    ])
  })

  it('the "/" is ::before on the second entry, not text in the DOM', () => {
    const { container } = render(<Breadcrumb category={category} />)
    const items = container.querySelectorAll('li')

    expect(items).toHaveLength(2)
    // No "/" is text: a real "/" would be a third entry in the list for a screen
    // reader, or get mixed into the link name.
    expect(container.querySelector('nav')?.textContent).toBe(`${msg('Site.footer.links.writing')}Architecture`)
    // The separator sits on the later entry, not the first: the trail does not start with "/".
    expect(items[1].className).toContain("before:content-['/']")
    expect(items[0].className).not.toContain("before:content-['/']")
  })

  it('folder icon next to the category, aria-hidden, so the link name is still only the category name', () => {
    render(<Breadcrumb category={category} />)

    const link = screen.getByRole('link', { name: 'Architecture' })
    const icon = link.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveAttribute('focusable', 'false')
    // The Writing root has no icon: the Folder says "this is a category", separating it from a tag of the same name.
    expect(screen.getByRole('link', { name: msg('Site.footer.links.writing') }).querySelector('svg')).toBeNull()
  })

  it('a post without a category: only "Writing" remains, no empty entry', () => {
    const { container } = render(<Breadcrumb category={null} />)

    expect(container.querySelectorAll('li')).toHaveLength(1)
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/writing'])
  })

  it('encodes the category slug in the href', () => {
    render(<Breadcrumb category={{ ...category, slug: ACCENTED_CATEGORY_SLUG }} />)

    expect(screen.getByRole('link', { name: 'Architecture' })).toHaveAttribute(
      'href',
      `/categories/${encodeURIComponent(ACCENTED_CATEGORY_SLUG)}`,
    )
  })
})

describe('breadcrumbTrail', () => {
  it('same names and URLs as the visible links, so JSON-LD and the breadcrumb cannot drift apart', () => {
    const { container } = render(<Breadcrumb category={category} />)
    const visible = [...container.querySelectorAll('a')].map((a) => ({
      name: a.textContent,
      url: a.getAttribute('href'),
    }))

    expect(breadcrumbTrail(category, translatorFor('vi', 'Site.breadcrumb'))).toEqual(visible)
    expect(breadcrumbTrail(null, translatorFor('vi', 'Site.breadcrumb'))).toEqual([
      { name: msg('Site.footer.links.writing'), url: '/writing' },
    ])
  })
})

describe('SeriesBreadcrumb', () => {
  it('"Writing" / Series, the same "Breadcrumb" nav and style as the post page; Layers icon next to "Series", aria-hidden', () => {
    const { container } = render(<SeriesBreadcrumb />)

    const nav = screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })
    expect(within(nav).getByRole('list').tagName).toBe('OL')
    const links = within(nav).getAllByRole('link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [msg('Site.footer.links.writing'), '/writing'],
      [msg('Site.breadcrumb.series'), '/series'],
    ])
    expect(links[1]!.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(links[0]!.querySelector('svg')).toBeNull()
    expect(container.querySelector('nav')?.textContent).toBe(
      `${msg('Site.footer.links.writing')}${msg('Site.breadcrumb.series')}`,
    )
  })

  it('seriesBreadcrumbTrail is exactly the visible links: the JSON-LD of the series page is built from it', () => {
    const { container } = render(<SeriesBreadcrumb />)
    const visible = [...container.querySelectorAll('a')].map((a) => ({
      name: a.textContent,
      url: a.getAttribute('href'),
    }))

    expect(seriesBreadcrumbTrail(translatorFor('vi', 'Site.breadcrumb'))).toEqual(visible)
  })
})

describe('Breadcrumb on a phone', () => {
  it('the 16px eyebrow link widens its touch area with TAP_TARGET', () => {
    render(<Breadcrumb category={{ id: 'c', name: 'Architecture', slug: 'architecture', description: null } as Category} />)

    const links = within(screen.getByRole('navigation', { name: msg('Site.breadcrumb.label') })).getAllByRole('link')
    expect(links).toHaveLength(2)
    // 36px of hit area, 44px on a phone.
    for (const link of links) {
      expect(link).toHaveClass(
        'relative',
        'after:absolute',
        'after:-inset-x-1.5',
        'after:-inset-y-2.5',
        'max-sm:after:-inset-y-3.5',
      )
    }
  })
})
