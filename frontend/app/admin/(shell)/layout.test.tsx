import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The real `redirect()` throws a Next control error; the fake throws this one so the test can catch the target. */
class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`redirect ${target}`)
  }
}

const { cookieStore, redirect, pathname } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn() },
  redirect: vi.fn(),
  pathname: { value: '/admin/series' },
}))
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }))
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ replace: vi.fn() }),
  redirect,
}))

import { canWriteDrafts } from '@/lib/draft-storage'
import AdminLayout, { dynamic } from './layout'
import { msg } from '@/test/render-intl'

/** A token with a real base64url payload and a dropped signature: the layout only reads the claim, like proxy.ts. */
function tokenWith(payload: Record<string, unknown>): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64url({ alg: 'HS256' })}.${b64url(payload)}.khong-kiem-chu-ky`
}

redirect.mockImplementation((target: string) => {
  throw new RedirectSignal(target)
})

describe('Admin shell layout', () => {
  afterEach(() => {
    cookieStore.get.mockReset()
    redirect.mockClear()
    pathname.value = '/admin/series'
  })

  it('sets its own light background, dark text and light color-scheme, independent of the site theme', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })

    const { container } = render(await AdminLayout({ children: <p>Page content</p> }))

    // Bug: the body carries `dark:text-neutral-100`, the shell only set a light background, so in the dark theme
    // near-white text sat on a near-white background. The shell must set its own text colour, and a light
    // color-scheme so inputs, checkboxes and scrollbars are drawn for a light background.
    const shell = container.firstElementChild as HTMLElement
    expect(shell).toHaveClass('bg-white', 'text-slate-900', '[color-scheme:light]')
    // No `dark:` class in the shell: admin deliberately has a single theme.
    expect(shell.className).not.toMatch(/\bdark:/)
    // The marker for globals.css to exclude the shell from dark-theme-only rules (figure, figcaption, .shiki
    // inside .prose): without it the editor's "Preview" frame shows dark Shiki code on a light background.
    expect(shell).toHaveAttribute('data-admin')
  })

  it('binds the account in the token sub for the editor local drafts (a UUID only)', async () => {
    const sub = '11111111-1111-1111-1111-111111111111'
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'AUTHOR', sub }) })

    const first = render(await AdminLayout({ children: <p>Page content</p> }))
    expect(canWriteDrafts(sub)).toBe(true)
    first.unmount()
    expect(canWriteDrafts(sub)).toBe(false)

    // A sub that is not a UUID would put a colon or a path into the storage key: no drafts at all.
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'AUTHOR', sub: 'a:b' }) })
    const second = render(await AdminLayout({ children: <p>Page content</p> }))
    expect(canWriteDrafts('a:b')).toBe(false)
    second.unmount()
  })

  it('puts the page content inside <main id="main-content">', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })

    render(await AdminLayout({ children: <p>Page content</p> }))

    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', 'main-content')
    expect(within(main).getByText('Page content')).toBeInTheDocument()
  })

  it('uses AdminNav, with the role read from the token claim', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })

    render(await AdminLayout({ children: null }))

    const nav = screen.getByRole('navigation', { name: msg('Site.account.admin') })
    expect(within(nav).getByText('ADMIN')).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Series' })).toHaveAttribute('aria-current', 'page')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('the sidebar carries the site name, and is absent on the editor page', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })

    render(await AdminLayout({ children: <p>Page content</p> }))

    // The bar/sidebar is the banner landmark; the site name comes from the site content, not hard-coded.
    const { defaultSiteContent } = await import('@/content/defaults')
    const { DEFAULT_LOCALE } = await import('@/i18n/config')
    expect(within(screen.getByRole('banner')).getByText(defaultSiteContent(DEFAULT_LOCALE).site.name)).toBeInTheDocument()
    expect(screen.getByRole('main')).not.toContainElement(screen.getByRole('banner'))
  })

  it('the skip link "Skip to content" is the first focusable thing, pointing at <main id="main-content">', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })

    const { container } = render(await AdminLayout({ children: <button type="button">A button of the page</button> }))

    // Tab order: every focusable element in document order. The first must be the skip link, BEFORE the site
    // name, the "Menu" button and even the sidebar nav — that is the whole reason it exists.
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    )
    expect(focusables.length).toBeGreaterThan(3)
    const skip = focusables[0]
    expect(skip.tagName).toBe('A')
    expect(skip).toHaveAccessibleName(msg('Site.nav.skipToContent'))
    expect(skip).toHaveAttribute('href', '#main-content')
    // The target is real, and is the content region itself.
    expect(container.querySelector('#main-content')).toBe(screen.getByRole('main'))
    expect(screen.getByRole('banner')).not.toContainElement(skip)

    // Hidden with sr-only, shown on focus; NEVER `hidden` (display:none leaves the Tab order).
    expect(skip.className).toMatch(/\bsr-only\b/)
    expect(skip.className).toMatch(/\bfocus:not-sr-only\b/)
    expect(skip.className).not.toMatch(/(^|\s)hidden\b/)
    expect(skip).not.toHaveAttribute('hidden')
    // Admin has a single light theme: no `dark:` variant at all (unlike the site's skip link).
    expect(skip.className).not.toMatch(/\bdark:/)
  })

  it('the skip link is also on pages without a sidebar (the editor, the preview)', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })
    pathname.value = '/admin/posts/new'

    render(await AdminLayout({ children: <p>Writing desk</p> }))

    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByRole('link', { name: msg('Site.nav.skipToContent') })).toHaveAttribute('href', '#main-content')
  })

  it('every admin page is dynamic', () => {
    // Without this line a future admin page that does not read cookies could be prerendered and
    // serve an author's draft to everyone.
    expect(dynamic).toBe('force-dynamic')
  })
})

/**
 * The /admin UI for ADMIN and AUTHOR. The second layer after proxy.ts, for every full render:
 * it calls no backend (the claim is exactly the value the backend uses to authorise), so no error path
 * escapes (shell)/error.tsx.
 *
 * A deliberate change from before: AUTHOR used to be rendered and saw their own role label, and
 * with no cookie the menu was still there. Now AUTHOR is sent to the "no permission" notice, and with no
 * token goes to the login page.
 */
describe('Admin shell layout: ADMIN and AUTHOR', () => {
  afterEach(() => {
    cookieStore.get.mockReset()
    redirect.mockClear()
  })

  it('USER goes to /admin/login?reason=forbidden, rendering nothing of the admin', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'USER' }) })

    await expect(AdminLayout({ children: <p>Secret</p> })).rejects.toThrow(RedirectSignal)
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/admin/login?reason=forbidden')
  })

  it('AUTHOR gets in, with a shortened menu: only their own posts', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'AUTHOR' }) })

    render(await AdminLayout({ children: <p>Page content</p> }))

    expect(redirect).not.toHaveBeenCalled()
    expect(screen.getByText('Page content')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.shell.nav.myPosts') })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: msg('Admin.shell.nav.users') })).toBeNull()
  })

  it.each([
    ['no role claim', {}],
    ['unknown role', { role: 'SUPERUSER' }],
    ['role in the wrong case', { role: 'admin' }],
  ])('token %s is also no permission', async (_label, payload) => {
    cookieStore.get.mockReturnValue({ value: tokenWith(payload) })

    await expect(AdminLayout({ children: null })).rejects.toThrow(RedirectSignal)
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/admin/login?reason=forbidden')
  })

  it('without the access cookie goes to the login page, with no notice', async () => {
    cookieStore.get.mockReturnValue(undefined)

    await expect(AdminLayout({ children: null })).rejects.toThrow(RedirectSignal)
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/admin/login')
  })

  it('an empty access cookie is also no token', async () => {
    cookieStore.get.mockReturnValue({ value: '' })

    await expect(AdminLayout({ children: null })).rejects.toThrow(RedirectSignal)
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/admin/login')
  })

  it('reads exactly the access cookie, no other cookie', async () => {
    cookieStore.get.mockReturnValue({ value: tokenWith({ role: 'ADMIN' }) })

    render(await AdminLayout({ children: null }))

    const { accessCookieName } = await import('@/lib/auth-cookies')
    // Exactly one read, and it is the access cookie: the fake returns the token for EVERY name, so
    // `toHaveBeenCalledWith` alone would not see an extra read of another cookie (the refresh one, say).
    expect(cookieStore.get).toHaveBeenCalledExactlyOnceWith(accessCookieName())
  })
})
