import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/profile',
  useRouter: () => ({ replace: vi.fn() }),
}))
// The page is only a frame: the session store stays at "asking" as in a server render, no real fetch.
vi.mock('@/lib/session-client', () => ({
  useSession: () => ({ status: 'loading' }),
  logout: vi.fn(),
  setAnonymous: vi.fn(),
}))

import ProfilePage, { dynamic, generateMetadata } from './page'
import { pageProps } from '@/test/page-props'
import { IntlWrapper } from '@/test/intl'
import { msg } from '@/test/render-intl'

const metadata = await generateMetadata(pageProps())

/**
 * /profile: a static frame, identical for everyone; the profile
 * is filled in by ProfileCard (client) after it asks /api/session. The states of the profile card itself have their own test
 * (components/site/ProfileCard.test.tsx).
 */
describe('/profile page', () => {
  it('heading "Profile", then the profile card in the session-asking state', async () => {
    render(await ProfilePage(pageProps()))

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.account.profile') })).toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('server-rendered HTML carries no user data', async () => {
    // Exactly what is prerendered and served to everyone: only the frame, the profile card "asking".
    const html = renderToString(<IntlWrapper>{await ProfilePage(pageProps())}</IntlWrapper>)

    expect(html).toContain(msg('Site.account.profile'))
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toMatch(
      new RegExp(`${msg('Site.profileCard.signOut')}|${msg('Site.profileCard.anonymous').replace('.', '')}|github\\.com`),
    )
  })

  it('deliberately static: does not read cookies, headers or searchParams; using a request API breaks the build', () => {
    // `dynamic = 'error'`: a `cookies()` added later makes `next build` stop, instead of silently
    // turning the page dynamic and putting one person's data into its HTML.
    expect(dynamic).toBe('error')

    const source = readFileSync(join(process.cwd(), 'app/[locale]/(site)/profile/page.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bcookies\s*\(|\bheaders\s*\(|searchParams|next\/headers/)
  })

  it('noindex, canonical /profile, title "Profile", through pageMetadata', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.alternates?.canonical).toBe('/profile')
    expect(metadata.title).toBe(msg('Site.account.profile'))
    // pageMetadata sets og:url from the canonical: a page that handwrites its metadata would miss it.
    expect(metadata.openGraph?.url).toBe('/profile')
  })
})
