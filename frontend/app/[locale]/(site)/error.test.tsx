import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import SiteError from './error'
import { TECHNICAL_WORDS } from '@/test/fixtures/vi/error-wording'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { msg } from '@/test/render-intl'

/**
 * Error boundary of the (site) group: when a public page throws while rendering (the API returns 5xx, the network
 * to the backend drops), Next renders this file INSIDE app/(site)/layout.tsx, so the header, `<main>` and footer
 * are still there: the reader can carry on using the site's own navigation bar.
 *
 * Before this file that error fell through to app/error.tsx at the root, replacing the layout of the group: an error page with no header,
 * no footer, and a sentence about "the API server".
 */

let log: MockInstance

beforeEach(() => {
  // The boundary logs the error to the console (to leave a trace in the browser); the test does not need to see it.
  log = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
})

describe('error page of the (site) group', () => {
  it('says in the reader own words what happened; "Try again" calls retry exactly once, with no argument', () => {
    const retry = vi.fn()
    render(<SiteError error={new Error('boom')} retry={retry} />)

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.errorPage.title') })).toBeInTheDocument()
    expect(screen.getByText(msg('Site.errorPage.lead'))).toBeInTheDocument()
    // No technical wording: the reader does not know, and does not need to know, that the site has an "API" behind it.
    expect(document.body.textContent).not.toMatch(TECHNICAL_WORDS)

    fireEvent.click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))

    // `retry` (Next 16.3) refreshes the data from the server and only then re-renders; `reset` only re-renders the very payload
    // that broke. Called with no argument: the click event is not passed into the Next function.
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith()
  })

  it('three ways out like the 404 page: home page, all posts, search', () => {
    render(<SiteError error={new Error('boom')} retry={vi.fn()} />)

    expect(screen.getByRole('link', { name: msg('Site.login.backHome') })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: msg('Site.errorPage.exits.allPosts') })).toHaveAttribute('href', '/writing')
    expect(screen.getByRole('link', { name: msg('Site.search.heading') })).toHaveAttribute('href', '/search')
  })

  it('has no <main> of its own: sits inside the <main id="main-content"> of the group layout', () => {
    // Two <main> in one document is invalid HTML and makes "Skip to content" ambiguous.
    const { container } = render(<SiteError error={new Error('boom')} retry={vi.fn()} />)
    expect(container.querySelector('main')).toBeNull()

    render(
      <main id="main-content">
        <SiteError error={new Error('boom')} retry={vi.fn()} />
      </main>,
    )
    expect(document.querySelectorAll('main')).toHaveLength(1)
  })

  it('one centred card like the 404 page (CARD_PAGE column, the h1 inside the CARD)', () => {
    render(<SiteError error={new Error('boom')} retry={vi.fn()} />)
    const card = screen.getByRole('heading', { level: 1 }).parentElement!
    const column = card.parentElement!

    expect(card).toHaveClass(...CARD.split(' '))
    expect(column).toHaveClass('max-w-3xl', 'px-4', ...CARD_PAGE.split(' '))
  })

  it('shows the digest code when present, the only thing tying this screen to the server log; no empty line when absent', () => {
    const { unmount } = render(<SiteError error={Object.assign(new Error('boom'), { digest: '3141592653' })} retry={vi.fn()} />)
    expect(screen.getByText(msg('Site.errorPage.digest', { digest: '3141592653' }))).toBeInTheDocument()
    unmount()

    render(<SiteError error={new Error('boom')} retry={vi.fn()} />)
    expect(screen.queryByText(new RegExp(msg('Site.errorPage.digest', { digest: '' }).replace(/[:\s]+$/, '')))).toBeNull()
  })

  it('never prints error.message, not even in an attribute', () => {
    // In production Next replaces the message of a server error with a generic sentence, but an error thrown on the client keeps its
    // message, and the ApiError of lib/api.ts carries the request path. The check is a real one: the first test
    // proves the component renders the text, so its absence here is a true absence.
    render(<SiteError error={new Error('jdbc:postgresql://db:5432/blog refused')} retry={vi.fn()} />)

    expect(document.body.textContent).not.toContain('jdbc:postgresql')
    expect(document.body.innerHTML).not.toContain('jdbc:postgresql')
  })

  it('logs the error to the console once, inside an effect', () => {
    const error = new Error('boom')
    render(<SiteError error={error} retry={vi.fn()} />)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]).toContain(error)
  })

  it('"Try again" is a real button, 40px tall on a phone, with the site focus ring', () => {
    render(<SiteError error={new Error('boom')} retry={vi.fn()} />)
    const retry = screen.getByRole('button', { name: msg('Site.profile.author.retry') })

    expect(retry).toHaveAttribute('type', 'button')
    expect(retry).toHaveClass('h-10', 'sm:h-9', 'focus-visible:outline-2', 'focus-visible:outline-brand')
    expect(within(retry.parentElement!).getAllByRole('link')).toHaveLength(3)
  })
})
