import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The page is only a frame: the session store stays at "asking" as in a server render, no real fetch.
vi.mock('@/lib/session-client', () => ({
  useSession: () => ({ status: 'loading' }),
  setAnonymous: vi.fn(),
}))

import BookmarksPage, { dynamic, generateMetadata } from './page'
import { pageProps } from '@/test/page-props'
import { IntlWrapper } from '@/test/intl'
import { msg } from '@/test/render-intl'

// The sidebar frame is tested once (BrowseFrame.test.tsx); here a stand-in records what the page asked for.
vi.mock('@/components/site/BrowseFrame', () => import('@/test/browse-frame-mock'))

const metadata = await generateMetadata(pageProps())

/** /bookmarks: static frame like /notifications; the list states are in BookmarkList.test.tsx. */
describe('/bookmarks page', () => {
  it('heading "Saved posts" (programmatically focusable), then the session-asking frame', async () => {
    render(await BookmarksPage(pageProps()))

    const heading = screen.getByRole('heading', { level: 1, name: msg('Site.account.bookmarks') })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading.id).not.toBe('')
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('sits in the frame with no current Explore row, the list in the main column', async () => {
    render(await BookmarksPage(pageProps()))

    const frame = screen.getByTestId('browse-frame')
    expect(frame).not.toHaveAttribute('data-current')
    expect(frame).toContainElement(screen.getByRole('heading', { level: 1, name: msg('Site.account.bookmarks') }))
    expect(frame).toContainElement(document.querySelector('[aria-busy="true"]'))
  })

  it('server-rendered HTML carries no user data and calls nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    let html: string
    try {
      html = renderToString(<IntlWrapper>{await BookmarksPage(pageProps())}</IntlWrapper>)
    } finally {
      vi.unstubAllGlobals()
    }

    expect(html).toContain(msg('Site.account.bookmarks'))
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toMatch(
      new RegExp(`${msg('Site.bookmarks.signIn')}|${msg('Site.bookmarks.unsave')}|${msg('Site.bookmarks.empty')}|<a `),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('deliberately static: does not read cookies, headers or searchParams; using a request API breaks the build', () => {
    expect(dynamic).toBe('error')

    const source = readFileSync(join(process.cwd(), 'app/[locale]/(site)/bookmarks/page.tsx'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bcookies\s*\(|\bheaders\s*\(|searchParams|next\/headers/)
  })

  it('noindex, nofollow, canonical /bookmarks, title "Saved posts", through pageMetadata', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.alternates?.canonical).toBe('/bookmarks')
    expect(metadata.title).toBe(msg('Site.account.bookmarks'))
    expect(metadata.openGraph?.url).toBe('/bookmarks')
  })
})
