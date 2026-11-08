import { act, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { callBff } = vi.hoisted(() => ({ callBff: vi.fn() }))
vi.mock('@/lib/bff-client', () => ({ callBff }))

import ConfirmPage, { generateMetadata as generateConfirmMetadata } from './confirm/page'
import UnsubscribePage, { generateMetadata as generateUnsubscribeMetadata } from './unsubscribe/page'
import { pageProps } from '@/test/page-props'
import { IntlWrapper, msg } from '@/test/intl'

const TOKEN = 'q0Vx8bT3sJm2Lr5YwN1eK7uHcA9dGf4ZpXiOtUnB6yQ'
const LINK_INVALID = msg('Site.newsletter.token.linkInvalid')

/** The two token pages: same mold, different button, BFF route and result sentence. */
const PAGES = [
  {
    path: '/newsletter/confirm',
    Page: ConfirmPage,
    metadata: await generateConfirmMetadata(pageProps()),
    button: msg('Site.newsletter.token.confirm.button'),
    api: '/api/newsletter/confirm',
    done: msg('Site.newsletter.token.confirm.done'),
    back: msg('Site.newsletter.token.confirm.back'),
  },
  {
    path: '/newsletter/unsubscribe',
    Page: UnsubscribePage,
    metadata: await generateUnsubscribeMetadata(pageProps()),
    button: msg('Site.newsletter.token.unsubscribe.button'),
    api: '/api/newsletter/unsubscribe',
    done: msg('Site.newsletter.token.unsubscribe.done'),
    back: msg('Site.newsletter.token.unsubscribe.back'),
  },
]

function props(token?: string | string[]) {
  return { searchParams: Promise.resolve(token === undefined ? {} : { token }) }
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

// reset, not just clear: one test leaves callBff hanging on an unfinished promise, and the next test must not inherit it.
afterEach(() => vi.resetAllMocks())

describe.each(PAGES)('$path', ({ path, Page, metadata, button, api, done, back }) => {
  it('noindex, nofollow; canonical is the bare path, with no token', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.alternates?.canonical).toBe(path)
  })

  it('GET only draws the button: rendering (on the server and in the browser) calls nothing, and the HTML does not print the token', async () => {
    const tree = await Page(props(TOKEN))

    const html = renderToString(<IntlWrapper>{tree}</IntlWrapper>)
    expect(html).toContain(button)
    expect(html).not.toContain(TOKEN)
    render(tree)
    expect(screen.getByRole('button', { name: button })).toBeInTheDocument()
    expect(callBff).not.toHaveBeenCalled()
  })

  it.each([undefined, 'ngan', `${TOKEN}/x`, ['', TOKEN]])(
    'token %j missing or malformed: a generic sentence with a link back to /newsletter, no button',
    async (token) => {
      render(await Page(props(token)))

      expect(screen.getByText(LINK_INVALID)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: back })).toHaveAttribute('href', '/newsletter')
      expect(screen.queryByRole('button')).toBeNull()
    },
  )

  it('click: one JSON POST `{ token }` even when clicked twice; on success the result sentence gets focus and the button disappears', async () => {
    let answer!: (value: unknown) => void
    callBff.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    render(await Page(props(TOKEN)))

    const action = screen.getByRole('button', { name: button })
    await click(action)
    await click(action)
    expect(callBff).toHaveBeenCalledExactlyOnceWith(api, { method: 'POST', body: JSON.stringify({ token: TOKEN }) })

    await act(async () => answer({ ok: true, data: { status: 'X' } }))
    expect(screen.queryByRole('button')).toBeNull()
    const result = screen.getByText(done).parentElement!
    expect(result).toHaveFocus()
  })

  it('BFF says the token is invalid: generic sentence, focus moves to it; 429 keeps the button, with a wait sentence', async () => {
    callBff.mockResolvedValueOnce({ ok: false, status: 429, code: 'RATE_LIMITED' })
    callBff.mockResolvedValueOnce({ ok: false, status: 400, code: 'NEWSLETTER_TOKEN_INVALID' })
    render(await Page(props(TOKEN)))

    await click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('alert')).toHaveTextContent(msg('Site.newsletter.errors.rateLimited'))

    await click(screen.getByRole('button', { name: button }))
    expect(screen.getByText(LINK_INVALID).parentElement).toHaveFocus()
    expect(screen.getByRole('link', { name: back })).toHaveAttribute('href', '/newsletter')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
