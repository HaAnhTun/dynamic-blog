import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NotFoundPage as NotFound } from './NotFoundPage'
import { msg } from '@/test/render-intl'
import { SITE_MAIN } from './reader/reader-layout'

// Footer is an async server component and cannot render in jsdom; Footer.test.tsx covers it.
vi.mock('./Footer', () => ({ Footer: () => null }))

/**
 * `not-found.tsx` takes no props — the framework gives it neither `params` nor the
 * request, so it cannot name the missing slug. What it can do is say what happened
 * and offer a way out, and that is what is pinned here.
 *
 * What this file cannot see: whether the response actually carries HTTP 404, and
 * whether this component is the one Next renders for a `notFound()` on a dynamic
 * route. Both were measured by serving the app and reading status codes; a unit test
 * renders the component in isolation and would look identical either way.
 */
describe('the not-found page', () => {
  it('says what happened', async () => {
    render(await NotFound())

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.notFound.title') })).toBeInTheDocument()
    // "changed address", not "changed slug": slug is the web maker's word, readers do not use it.
    expect(screen.getByText(msg('Site.notFound.lead'))).toBeInTheDocument()
    expect(screen.queryByText(/slug/)).not.toBeInTheDocument()

    // The nav matters as much as the message. A 404 whose only exit is the browser's back
    // button is a dead end, and this page sits outside app/(site)/ — which owns the header
    // — so it renders its own. Three ways out, each a real route.
    //
    // Scoped to <main>, not the whole document, and the reason is a real collision: the
    // Header this page renders ALSO has a link named "Search" (the search icon, which
    // carries an accessible name because an icon-only control must). An unscoped query
    // found two and failed — correctly. Scoping says which one the assertion is about.
    const body = within(screen.getByRole('main'))
    expect(body.getByRole('link', { name: msg('Site.login.backHome') })).toHaveAttribute('href', '/')
    expect(body.getByRole('link', { name: msg('Site.errorPage.exits.allPosts') })).toHaveAttribute('href', '/writing')
    expect(body.getByRole('link', { name: msg('Site.search.heading') })).toHaveAttribute('href', '/search')
  })

  it('is the document landmark, since the layout provides none', async () => {
    render(await NotFound())

    // app/layout.tsx renders no <main>, so this page's own is the only landmark in the
    // document, and <main> → <div> was invisible to every other assertion here.
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('has the same framed <main> as every other public page (SiteChrome, SITE_MAIN)', async () => {
    render(await NotFound())

    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(main.className.split(/\s+/)).toEqual(expect.arrayContaining(SITE_MAIN.split(/\s+/)))
    expect(main).toHaveClass('max-w-[87.5rem]', 'flex-1')
  })

  it('offers a link back to the homepage', async () => {
    render(await NotFound())

    // The href, not just the label: a reader who lands here has no other navigation
    // on the page, and nothing else in the suite would notice this pointing at a
    // route that does not exist.
    expect(screen.getByRole('link', { name: msg('Site.notFound.home') })).toHaveAttribute('href', '/')
  })
})
