import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Pagination } from './Pagination'
import { msg } from '@/test/render-intl'

describe('Pagination', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(<Pagination meta={{ page: 0, size: 20, totalElements: 3, totalPages: 1 }} basePath="/" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('disables Previous on the first page and offers Next', () => {
    render(<Pagination meta={{ page: 0, size: 20, totalElements: 60, totalPages: 3 }} basePath="/" />)

    expect(screen.queryByRole('link', { name: msg('Site.pagination.previous') })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/?page=1')
  })

  it('disables Next on the last page and offers Previous', () => {
    render(<Pagination meta={{ page: 2, size: 20, totalElements: 60, totalPages: 3 }} basePath="/" />)

    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute('href', '/?page=1')
    expect(screen.queryByRole('link', { name: /sau/i })).not.toBeInTheDocument()
  })

  it('reports the human-facing page number, not the zero-based index', () => {
    render(<Pagination meta={{ page: 1, size: 20, totalElements: 60, totalPages: 3 }} basePath="/" />)
    expect(screen.getByText(msg('Site.pagination.status', { page: 2, total: 3 }))).toBeInTheDocument()
  })

  it('exposes itself as a labelled navigation landmark', () => {
    render(<Pagination meta={{ page: 1, size: 20, totalElements: 60, totalPages: 3 }} basePath="/" />)
    // Dropping aria-label, or rendering a <div> instead of <nav>, leaves every other
    // assertion in this file passing.
    expect(screen.getByRole('navigation', { name: msg('Site.pagination.label') })).toBeInTheDocument()
  })

  it('clamps a page the reader asked for but that does not exist', () => {
    // The backend echoes the requested page back, so /?page=99 against three pages
    // arrives here as meta.page = 99. Unclamped this renders "page 100 of 3" with a
    // Previous link to a page that is also out of range.
    render(<Pagination meta={{ page: 99, size: 20, totalElements: 60, totalPages: 3 }} basePath="/" />)

    expect(screen.getByText(msg('Site.pagination.status', { page: 3, total: 3 }))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.pagination.previous') })).toHaveAttribute('href', '/?page=1')
    expect(screen.queryByRole('link', { name: /sau/i })).not.toBeInTheDocument()
  })

  it('keeps an existing query on basePath instead of appending a second ?', () => {
    render(<Pagination meta={{ page: 0, size: 20, totalElements: 60, totalPages: 3 }} basePath="/?category=cong-nghe" />)
    expect(screen.getByRole('link', { name: /sau/i })).toHaveAttribute('href', '/?category=cong-nghe&page=1')
  })
})

describe('Pagination: tap target and focus ring', () => {
  it('Previous and Next links: enlarged tap target (TAP_TARGET), focus ring and the site color transition', () => {
    // It used to be a bare text link `hover:underline` about 20px tall: the tap target was too small on phones, and the focus ring
    // was only the browser default.
    render(<Pagination meta={{ page: 1, size: 20, totalElements: 60, totalPages: 3 }} basePath="/" />)
    const links = screen.getAllByRole('link')

    expect(links.map((link) => link.textContent)).toEqual([msg('Site.pagination.previous'), msg('Site.pagination.next')])
    for (const link of links) {
      const name = link.textContent ?? ''
      // TAP_TARGET: a transparent ::after extends 10px above and below the text, 6px on each side; the text does not move.
      expect(link, name).toHaveClass('relative', 'after:absolute', 'after:-inset-x-1.5', 'after:-inset-y-2.5')
      // FOCUS: 2px brand ring on keyboard focus.
      expect(link, name).toHaveClass(
        'rounded-sm',
        'focus-visible:outline-2',
        'focus-visible:outline-offset-2',
        'focus-visible:outline-brand',
      )
      // TRANSITION: 120ms, turned off entirely when the reader asks for reduced motion.
      expect(link, name).toHaveClass('transition-colors', 'duration-[120ms]', 'motion-reduce:transition-none')
      expect(link, name).toHaveClass('hover:underline')
    }
  })
})

describe('Pagination: "page n of N" is centered', () => {
  it('1fr auto 1fr grid: the two side columns are equal, the label sits in the middle column, even when one side is an empty cell', () => {
    // flex justify-between shifts the label depending on the length of the two links: ~40px left of center on page 1, ~46px
    // right of center on page 2 (measured at 1440), and it jumps when paging.
    for (const page of [0, 1, 2]) {
      const { unmount } = render(<Pagination meta={{ page, size: 10, totalElements: 30, totalPages: 3 }} basePath="/writing" />)
      const nav = screen.getByRole('navigation', { name: msg('Site.pagination.label') })
      expect(nav).toHaveClass('grid', 'grid-cols-[1fr_auto_1fr]')
      expect(nav).not.toHaveClass('justify-between')
      expect(nav.children).toHaveLength(3)
      expect(nav.children[1]).toHaveTextContent(msg('Site.pagination.status', { page: page + 1, total: 3 }))
      expect(nav.children[1]).toHaveClass('justify-self-center')
      unmount()
    }
  })
})
