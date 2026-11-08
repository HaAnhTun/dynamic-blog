import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SiteChrome } from './SiteChrome'
import { SITE_MAIN } from './reader/reader-layout'

// Header and Footer have their own tests (Header.test.tsx, Footer.test.tsx); here is only the shell: what sits around <main>.
const header = vi.hoisted(() => vi.fn())
vi.mock('./Header', () => ({
  Header: (props: { siteName: string; galleryLead: string | null }) => {
    header(props)
    return <header data-testid="header" />
  },
}))
vi.mock('./Footer', () => ({ Footer: () => <footer data-testid="footer" /> }))

describe('SiteChrome', () => {
  it('renders the header, then the framed <main> with the children, then the footer, in that order', () => {
    const { container } = render(
      <SiteChrome siteName="Site" galleryLead={null}>
        <p>Page content</p>
      </SiteChrome>,
    )

    expect([...container.children].map((child) => child.tagName)).toEqual(['HEADER', 'MAIN', 'FOOTER'])
    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByText('Page content'))
    expect(container.children[0]).toBe(screen.getByTestId('header'))
    expect(container.children[2]).toBe(screen.getByTestId('footer'))
    // Exactly one main landmark: the one the skip link points at.
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main).not.toHaveAttribute('tabindex')
  })

  it('<main> is the 1400px frame: SITE_MAIN, the one place that sets the width, the centring and the side hairlines', () => {
    render(
      <SiteChrome siteName="Site" galleryLead={null}>
        x
      </SiteChrome>,
    )

    const main = screen.getByRole('main')
    expect(main.className.split(/\s+/)).toEqual(expect.arrayContaining(SITE_MAIN.split(/\s+/)))
    expect(main).toHaveClass('max-w-[87.5rem]', 'mx-auto', 'w-full', 'flex-1', 'flex-col', 'outline-none', 'frame:border-x')
    // A plain block without a max width on paper, and no hairlines there.
    expect(main).toHaveClass('print:block', 'print:max-w-none', 'print:border-0')
  })

  it('passes the site name and the gallery lead to the header, and loads no data itself', () => {
    render(
      <SiteChrome siteName="My site" galleryLead="A lead">
        x
      </SiteChrome>,
    )

    expect(header).toHaveBeenCalledWith(expect.objectContaining({ siteName: 'My site', galleryLead: 'A lead' }))
  })

  it('has no BackToTop: the layout owns it, outside the shell', () => {
    const { container } = render(
      <SiteChrome siteName="Site" galleryLead={null}>
        x
      </SiteChrome>,
    )

    expect(container.querySelector('button')).toBeNull()
  })
})
