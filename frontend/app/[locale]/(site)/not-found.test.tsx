import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NotFoundPage as RootNotFound } from '@/components/site/NotFoundPage'
import SiteNotFound from './not-found'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { msg } from '@/test/render-intl'

// Footer is an async server component and cannot render in jsdom; Footer.test.tsx covers it.
vi.mock('@/components/site/Footer', () => ({ Footer: () => null }))

/**
 * The 404 of the (site) group renders INSIDE app/(site)/layout.tsx, which already has the header, `<main>` and
 * footer. So it may only carry the content part: the earlier version (when only app/not-found.tsx existed) gave the 404 pages
 * of /posts/<unknown>, /series/<unknown>, /gallery?page=99 two headers, two footers and a `<main>` nested
 * inside a `<main>` with the same id, as the e2e public-routes.spec.ts measured on a real page.
 */
describe('404 page of the (site) group', () => {
  it('content part only: no header, no main, no footer', () => {
    render(<SiteNotFound />)

    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(document.getElementById('main-content')).toBeNull()
  })

  it('one centred card: CARD_PAGE column around a CARD that holds the h1', () => {
    render(<SiteNotFound />)
    const card = screen.getByRole('heading', { level: 1 }).parentElement!

    expect(card).toHaveClass(...CARD.split(' '))
    expect(card.parentElement).toHaveClass('max-w-3xl', ...CARD_PAGE.split(' '))
  })

  it('says what happened and offers three ways out', () => {
    render(<SiteNotFound />)

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.notFound.title') })).toBeInTheDocument()
    expect(screen.getByText(msg('Site.notFound.lead'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.login.backHome') })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: msg('Site.errorPage.exits.allPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.getByRole('link', { name: msg('Site.search.heading') })).toHaveAttribute('href', '/search')
  })

  it('same content as the root 404 (URL matching no route), only the frame differs', async () => {
    const { container: site } = render(<SiteNotFound />)
    const siteText = site.textContent
    const { container: root } = render(await RootNotFound())

    // The root version carries its own frame, because it sits outside the (site) group; the content part is the same component.
    expect(root.querySelector('main#main-content')?.textContent).toBe(siteText)
  })
})
