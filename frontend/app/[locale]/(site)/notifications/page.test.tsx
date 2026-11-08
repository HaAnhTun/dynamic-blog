import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/notifications',
  useRouter: () => ({ replace: vi.fn() }),
}))
// The page is only a frame: the session store stays at "asking" as in a server render, no real fetch.
vi.mock('@/lib/session-client', () => ({
  useSession: () => ({ status: 'loading' }),
  getSessionSnapshot: () => ({ status: 'loading' }),
  logout: vi.fn(),
  setAnonymous: vi.fn(),
}))

import NotificationsPage, { dynamic, generateMetadata } from './page'
import { pageProps } from '@/test/page-props'
import { IntlWrapper } from '@/test/intl'
import { msg } from '@/test/render-intl'

const metadata = await generateMetadata(pageProps())

/**
 * /notifications: a static frame like /profile, identical for everyone; the list
 * is filled in by NotificationsCenter (client) after it asks for the session. The states of the list itself have their own test
 * (components/site/notifications/NotificationsCenter.test.tsx).
 */
describe('/notifications page', () => {
  it('heading "Notifications" (programmatically focusable, for when the last entry is deleted), then the session-asking frame', async () => {
    render(await NotificationsPage(pageProps()))

    const heading = screen.getByRole('heading', { level: 1, name: msg('Site.account.notifications') })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading.id).not.toBe('')
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('server-rendered HTML carries no user data', async () => {
    const html = renderToString(<IntlWrapper>{await NotificationsPage(pageProps())}</IntlWrapper>)

    expect(html).toContain(msg('Site.account.notifications'))
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toMatch(
      new RegExp(
        `${msg('Site.notifications.center.signIn')}|${msg('Site.notifications.markAll')}|${msg('Site.notifications.center.filterUnread')}|github\\.com`,
      ),
    )
  })

  it('deliberately static: does not read cookies, headers or searchParams; using a request API breaks the build', () => {
    expect(dynamic).toBe('error')

    const source = readFileSync(join(process.cwd(), 'app/[locale]/(site)/notifications/page.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bcookies\s*\(|\bheaders\s*\(|searchParams|next\/headers/)
  })

  it('noindex, nofollow, canonical /notifications, title "Notifications", through pageMetadata', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.alternates?.canonical).toBe('/notifications')
    expect(metadata.title).toBe(msg('Site.account.notifications'))
    expect(metadata.openGraph?.url).toBe('/notifications')
  })
})
