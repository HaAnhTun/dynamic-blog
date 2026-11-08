import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import ErrorBoundary from './error'
import { msg } from '@/test/render-intl'
import { SERVER_WORD } from '@/test/fixtures/vi/error-copy-words'

/**
 * The root error boundary. Since the public-page error boundary moved, an error of a public page goes to app/(site)/error.tsx (inside the group
 * frame); this file is left for errors of app/(site)/layout.tsx itself and for routes outside the group with no
 * boundary of their own (/admin/login). Same wording as the group error page (components/site/ErrorContent.tsx).
 */

let log: MockInstance

beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
})

describe('the root error boundary', () => {
  it('offers a retry that calls retry, with the reader copy of the site error page', () => {
    // `retry`, not `reset`: Next 16.3 made it stable and recommended. It re-fetches before
    // re-rendering, where `reset` only re-renders the payload that already failed.
    const retry = vi.fn()

    render(<ErrorBoundary error={new Error('boom')} retry={retry} />)

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.errorPage.title') })).toBeInTheDocument()
    // The old copy blamed the "API server" — true for the developer, meaningless to a reader.
    expect(document.body.textContent).not.toMatch(new RegExp(`API|${SERVER_WORD}`))
    fireEvent.click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('is the document landmark itself, because it replaces the layout that owns <main>', () => {
    // An error in app/(site)/layout.tsx lands here, and that layout is what renders the header,
    // <main id="main-content"> and the footer. So this one renders its own <main>, with the id the
    // skip link points at.
    render(<ErrorBoundary error={new Error('boom')} retry={vi.fn()} />)

    const mains = screen.getAllByRole('main')
    expect(mains).toHaveLength(1)
    expect(mains[0]).toHaveAttribute('id', 'main-content')
    expect(screen.getByRole('link', { name: msg('Site.login.backHome') })).toHaveAttribute('href', '/')
  })

  it('shows the digest when there is one', () => {
    render(<ErrorBoundary error={Object.assign(new Error('boom'), { digest: '271828' })} retry={vi.fn()} />)

    expect(screen.getByText(msg('Site.errorPage.digest', { digest: '271828' }))).toBeInTheDocument()
    expect(log.mock.calls[0]).toContainEqual(expect.objectContaining({ digest: '271828' }))
  })

  it('keeps the error message off a public page', () => {
    // Not cosmetic. An ApiError from lib/api carries the backend's own message, and
    // the fallback one embeds the request path; a 500 from Spring can name a JDBC
    // URL. The test above proves this component renders text at all, so the absence
    // asserted here is a real absence and not a component that rendered nothing.
    render(<ErrorBoundary error={new Error('jdbc:postgresql://db:5432/blog refused')} retry={vi.fn()} />)

    expect(screen.queryByText(/jdbc:postgresql/)).not.toBeInTheDocument()
    // textContent rather than a query, so it also catches the message rendered
    // split across elements, which queryByText's per-element matching would miss.
    expect(document.body.textContent).not.toContain('jdbc:postgresql')
    // And innerHTML, because textContent does not see attributes: `title={error.message}`
    // on the heading leaks the whole string to anyone hovering it, and passes both of
    // the assertions above.
    expect(document.body.innerHTML).not.toContain('jdbc:postgresql')
  })
})
