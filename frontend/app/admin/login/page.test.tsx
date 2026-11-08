import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultSiteContent } from '@/content/defaults'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { setTestLocale, translatorFor } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'
import { LANGUAGE_NAMES } from '@/components/site/language-names'

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/admin/login' }))

import LoginPage from './page'

/**
 * `LoginPage` is an async Server Component (it reads `searchParams` to show the "no permission"
 * notice): RTL cannot render a promise directly, so the test calls it as a function and renders the
 * tree it returns, like the reader's /login page.
 */
function props(searchParams: Record<string, string | string[] | undefined> = {}): PageProps<'/admin/login'> {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) }
}

async function renderLogin(searchParams: Record<string, string | string[] | undefined> = {}, locale?: 'vi' | 'en') {
  // The server helpers the page awaits read the test locale, so it is set before the page runs.
  if (locale) setTestLocale(locale)
  return renderWithIntl(await LoginPage(props(searchParams)), { locale })
}

const login = (key: string, locale?: 'vi' | 'en') => msg(`Admin.login.${key}`, undefined, locale)

/** The forbidden sentence as it reads on the page: the catalog message without its link tag. */
const rawForbidden = (locale: 'vi' | 'en') =>
  (translatorFor(locale, 'Admin.login') as unknown as { raw(key: string): string }).raw('forbidden')
const forbidden = (locale: 'vi' | 'en' = 'vi') => rawForbidden(locale).replace(/<\/?home>/g, '')
const FORBIDDEN = forbidden()

/** The words inside the link tag of the forbidden sentence. */
const homeLinkText = (locale: 'vi' | 'en' = 'vi') => /<home>(.*)<\/home>/.exec(rawForbidden(locale))![1]!

describe('Admin login page', () => {
  it('sets its own light background, dark text and light color-scheme like the shell, independent of the site theme', async () => {
    const { container } = await renderLogin()

    // Visual QA bug: only the shell was fixed for the dark theme; this page still followed the site's
    // #0a0a0a background while using light-theme colour classes: the "Sign in" button bg-slate-900
    // sank into the background (1.11:1).
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper).toHaveClass('min-h-screen', 'bg-slate-50', 'text-slate-900', '[color-scheme:light]')
    expect(wrapper).toHaveAttribute('data-admin')
    expect(wrapper.className).not.toMatch(/\bdark:/)
    expect(wrapper).toContainElement(screen.getByRole('main'))
  })

  it('both inputs have a white background and a visible border, not transparent over the page background', async () => {
    await renderLogin()

    for (const input of [screen.getByLabelText(login('email')), screen.getByLabelText(login('password'))]) {
      expect(input).toHaveClass('bg-white', 'border-slate-300')
    }
  })

  it('names the site before the heading, and offers a way back to the blog for people who wandered in', async () => {
    await renderLogin()

    const main = screen.getByRole('main')
    const site = within(main).getByText(defaultSiteContent(DEFAULT_LOCALE).site.name)
    const heading = within(main).getByRole('heading', { level: 1, name: login('title') })
    // Reading order: site name, then heading. This page sits outside the shell, so no sidebar says it for us.
    expect(site.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(main).getByRole('link', { name: login('backToBlog') })).toHaveAttribute('href', '/')
  })

  it('authors (GitHub only) get their own path: a plain link to the start route, returning to /admin; the password form stays above', async () => {
    await renderLogin()

    const github = screen.getByRole('link', { name: login('github') })
    expect(github).toHaveAttribute('href', '/api/auth/github/start?returnTo=%2Fadmin')
    expect(github).toHaveAttribute('rel', 'nofollow')
    expect(
      screen.getByLabelText(login('password')).compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

/**
 * proxy.ts and the (shell) layout send anyone who is neither ADMIN nor AUTHOR here with
 * `?reason=forbidden`. Without this sentence a GitHub reader who clicks into /admin only sees the
 * login form and cannot tell why they are signed in yet still asked for a password.
 */
describe('Admin login page: no-permission notice', () => {
  it('?reason=forbidden shows the exact sentence in role="alert", before the form', async () => {
    await renderLogin({ reason: 'forbidden' })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(FORBIDDEN)
    // "back to the home page" is a real way out, not just text.
    expect(within(alert).getByRole('link', { name: homeLinkText() })).toHaveAttribute('href', '/')
    // Read before the form: the user learns why they are here before being asked for an email.
    const email = screen.getByLabelText(login('email'))
    expect(alert.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('?reason=session-not-ended says the server could not end the session, in role="alert", before the form', async () => {
    await renderLogin({ reason: 'session-not-ended' })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(login('sessionNotEnded'))
    expect(alert.compareDocumentPosition(screen.getByLabelText(login('email'))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The other sentence is not shown with it.
    expect(screen.queryByText(FORBIDDEN)).toBeNull()
  })

  it('without a reason there is no notice', async () => {
    await renderLogin()

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([['expired'], ['FORBIDDEN'], ['<script>alert(1)</script>']])(
    'unknown reason %j shows nothing, and does not echo the URL value',
    async (reason) => {
      const { container } = await renderLogin({ reason })

      expect(screen.queryByRole('alert')).toBeNull()
      expect(container.textContent).not.toContain(reason)
    },
  )

  it('a repeated ?reason takes the first value', async () => {
    await renderLogin({ reason: ['forbidden', 'x'] })

    expect(screen.getByRole('alert')).toHaveTextContent(FORBIDDEN)
  })
})

describe('Admin login page: where the sign-in ends', () => {
  it('?next= with an admin path is kept for GitHub too: "sign in again" from Security returns to Security', async () => {
    await renderLogin({ next: '/admin/security' })

    expect(screen.getByRole('link', { name: login('github') })).toHaveAttribute(
      'href',
      '/api/auth/github/start?returnTo=%2Fadmin%2Fsecurity',
    )
  })

  it.each([['//evil.example'], ['https://evil.example/admin'], ['/en/posts/a'], ['/admin/login/mfa'], ['/administrator']])(
    'a ?next= of %j is not followed: GitHub returns to /admin',
    async (next) => {
      await renderLogin({ next })

      expect(screen.getByRole('link', { name: login('github') })).toHaveAttribute(
        'href',
        '/api/auth/github/start?returnTo=%2Fadmin',
      )
    },
  )
})

describe('Admin login page: language', () => {
  it('shows the English copy when the admin language is English, and keeps the form ids', async () => {
    const { container } = await renderLogin({ reason: 'forbidden' }, 'en')

    expect(screen.getByRole('heading', { level: 1, name: login('title', 'en') })).toBeInTheDocument()
    expect(screen.getByLabelText(login('password', 'en'))).toHaveAttribute('id', 'password')
    expect(screen.getByRole('alert')).toHaveTextContent(forbidden('en'))
    expect(within(screen.getByRole('alert')).getByRole('link', { name: homeLinkText('en') })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: login('github', 'en') })).toBeInTheDocument()
    expect(container.querySelector('#email')).not.toBeNull()
  })

  it('offers the language switcher with the current language pressed', async () => {
    await renderLogin({}, 'en')

    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: LANGUAGE_NAMES.vi })).toHaveAttribute('aria-pressed', 'false')
  })
})
