import { render, screen } from '@testing-library/react'
import { pageProps } from '@/test/page-props'
import { describe, expect, it } from 'vitest'
import LoginPage, { generateMetadata } from './page'
import { msg } from '@/test/render-intl'

const metadata = await generateMetadata(pageProps())

/**
 * `LoginPage` is an async Server Component: RTL cannot render a promise directly, so the test calls
 * it as a function and then renders the tree it returns (same approach as /search).
 */
function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/[locale]/login'> {
  return { params: Promise.resolve({ locale: 'vi' }), searchParams: Promise.resolve(searchParams) }
}

async function renderLogin(searchParams: Record<string, string | string[] | undefined> = {}) {
  return render(await LoginPage(props(searchParams)))
}

function startLink(): HTMLElement {
  return screen.getByRole('link', { name: msg('Site.login.continueWithGithub') })
}

describe('/login page', () => {
  it('title, a sentence saying what the blog reads from GitHub, then the GitHub link and the way back to the home page', async () => {
    await renderLogin()

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.account.signIn') })).toBeInTheDocument()
    expect(screen.getByText(msg('Site.login.intro'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Site.login.backHome') })).toHaveAttribute('href', '/')
    // No error means no error box.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('GitHub link is a plain <a rel="nofollow"> to the start route, carrying the encoded returnTo', async () => {
    await renderLogin({ returnTo: '/posts/bai-viet?x=1#binh-luan' })

    const link = startLink()
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('rel', 'nofollow')
    expect(link).toHaveAttribute('href', `/api/auth/github/start?returnTo=${encodeURIComponent('/posts/bai-viet?x=1#binh-luan')}`)
    // The GitHub mark is for the eyes only: the link name is its text.
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it.each(['//evil.com', '/..//evil.com', 'https://evil.com', '/login', '/api/x'])(
    'returnTo %j is sanitized to "/" before entering the link',
    async (returnTo) => {
      await renderLogin({ returnTo })

      expect(startLink()).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2F')
    },
  )

  it('a repeated ?returnTo takes the first value', async () => {
    await renderLogin({ returnTo: ['/posts/a', '/posts/b'] })

    expect(startLink()).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fposts%2Fa')
  })

  it.each([
    ['denied', msg('Site.login.errors.denied')],
    ['state', msg('Site.login.errors.state')],
    ['unavailable', msg('Site.login.errors.unavailable')],
    ['suspended', msg('Site.login.errors.suspended')],
    ['disabled', msg('Site.login.errors.disabled')],
    ['rate', msg('Site.login.errors.rate')],
    ['failed', msg('Site.login.errors.failed')],
  ])('?error=%s shows the exact sentence in role="alert"', async (error, message) => {
    await renderLogin({ error })

    expect(screen.getByRole('alert')).toHaveTextContent(message)
  })

  it('an unknown error code shows nothing, and never echoes back the value on the URL', async () => {
    await renderLogin({ error: '<script>alert(1)</script>' })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toContain('<script>')
  })

  it('the error box comes before the GitHub link: read the error first, then the retry action', async () => {
    await renderLogin({ error: 'state' })

    const alert = screen.getByRole('alert')
    expect(alert.compareDocumentPosition(startLink()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('noindex, canonical /login, title "Sign in"', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.alternates?.canonical).toBe('/login')
    expect(metadata.title).toBe(msg('Site.account.signIn'))
  })
})
