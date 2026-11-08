import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SITE_MAIN } from '@/components/site/reader/reader-layout'
import SiteLayout from './layout'

// The layout is an async server component: the frame is what it returns once it has read the locale from the route params.
const params = Promise.resolve({ locale: 'vi' })

// Header, footer and button have their own tests (SiteChrome.test.tsx pins the three-part shell); here is the layout: it passes the
// site content down, puts the page in the framed <main> and keeps "Back to top" outside the shell.
vi.mock('@/components/site/Header', () => ({ Header: () => <header /> }))
vi.mock('@/components/site/Footer', () => ({ Footer: () => <footer /> }))
vi.mock('@/components/site/BackToTop', () => ({ BackToTop: () => <div data-testid="back-to-top" /> }))

describe('app/(site)/layout', () => {
  it('<main id="main-content"> has no fixed tabindex: a mouse click on the text does not focus <main>', async () => {
    render(
      await SiteLayout({
        children: <p>A paragraph</p>,
        params,
      }),
    )

    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    // With a fixed tabindex="-1" a click on the text focuses <main>, and the next Tab jumps back to the first link on the page.
    // The "Back to top" button attaches it when needed (BackToTop.test.tsx).
    expect(main).not.toHaveAttribute('tabindex')
    main.focus()
    expect(document.activeElement).not.toBe(main)
    // When focused by script: no focus ring is drawn around the whole page.
    expect(main).toHaveClass('outline-none', 'flex-1', 'flex-col')
  })

  it('<main> is the 1400px frame (SITE_MAIN), with the header before it and the footer after it', async () => {
    const { container } = render(await SiteLayout({ children: <p>A paragraph</p>, params }))

    const main = screen.getByRole('main')
    expect(main).toHaveClass('max-w-[87.5rem]', 'mx-auto', 'w-full', 'frame:border-x', 'print:block')
    expect(main.className.split(/\s+/)).toEqual(expect.arrayContaining(SITE_MAIN.split(/\s+/)))
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(main).toContainElement(screen.getByText('A paragraph'))
    expect(container.querySelector('header')!.nextElementSibling).toBe(main)
    expect(main.nextElementSibling).toBe(container.querySelector('footer'))
  })

  it('exactly one "Back to top" button, after the footer: last in the Tab order, not cutting into the content', async () => {
    const { container } = render(await SiteLayout({ children: 'Page content', params }))

    expect(screen.getAllByTestId('back-to-top')).toHaveLength(1)
    expect(container.lastElementChild).toBe(screen.getByTestId('back-to-top'))
    expect(container.querySelector('footer')!.nextElementSibling).toBe(screen.getByTestId('back-to-top'))
  })
})
