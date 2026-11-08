import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// usePathname is the input of every aria-current assertion; useRouter because LogoutButton lives
// in the menu. Mocked instead of wrapping a router provider: the App Router has no public way to
// set the pathname from a test (same reason as components/site/Header.test.tsx).
const pathname = vi.hoisted(() => ({ value: '/admin' }))
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ replace: vi.fn() }),
}))

import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { msg, renderWithIntl } from '@/test/render-intl'
import AdminNav, { adminSections } from './AdminNav'

function renderAt(path: string, role: string | null = 'ADMIN') {
  pathname.value = path
  return render(<AdminNav role={role} />)
}

/** The links currently carrying aria-current, by name. There must always be exactly one. */
function currentLinks(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') !== null)
    .map((link) => `${link.textContent}=${link.getAttribute('aria-current')}`)
}

beforeEach(() => {
  pathname.value = '/admin'
})

describe('AdminNav', () => {
  it('has exactly thirteen management items: the four base items, "Analytics" and "Topics" after "Posts", then "Comments", "Users", "Author applications", "Newsletter", "Contact", "Security" and "Settings"', () => {
    renderAt('/admin')

    const sections = screen.getByRole('list', { name: msg('Admin.shell.sectionsLabel') })
    const links = within(sections).getAllByRole('link')

    expect(links.map((a) => a.textContent)).toEqual([
      msg('Site.about.readNextLinks.writing'),
      msg('Admin.shell.nav.analytics'),
      msg('Site.footer.links.topics'),
      'Series',
      msg('Site.footer.links.startHere'),
      msg('Site.footer.links.gallery'),
      msg('Site.comments.heading'),
      msg('Admin.shell.nav.users'),
      msg('Admin.shell.nav.applications'),
      'Newsletter',
      msg('Admin.shell.nav.contact'),
      msg('Admin.shell.nav.security'),
      msg('Admin.shell.nav.settings'),
    ])
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/admin',
      '/admin/analytics',
      '/admin/topics',
      '/admin/series',
      '/admin/curated',
      '/admin/gallery',
      '/admin/comments',
      '/admin/users',
      '/admin/applications',
      '/admin/newsletter',
      '/admin/contact',
      '/admin/security',
      '/admin/settings',
    ])
    expect(adminSections).toHaveLength(13)
  })

  it('after the management items come "Write a post", "View blog", the role and "Sign out"', () => {
    renderAt('/admin', 'ADMIN')

    const nav = screen.getByRole('navigation', { name: msg('Site.account.admin') })
    expect(within(nav).getByRole('link', { name: msg('Admin.shell.newPost') })).toHaveAttribute('href', '/admin/posts/new')
    expect(within(nav).getByRole('link', { name: 'Xem blog' })).toHaveAttribute('href', '/')
    expect(within(nav).getByText('ADMIN')).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: msg('Site.account.signOut') })).toHaveAttribute('type', 'button')

    // Reading order: items first, then actions. Read in document order.
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent)
    expect(names).toEqual([
      msg('Site.about.readNextLinks.writing'),
      msg('Admin.shell.nav.analytics'),
      msg('Site.footer.links.topics'),
      'Series',
      msg('Site.footer.links.startHere'),
      msg('Site.footer.links.gallery'),
      msg('Site.comments.heading'),
      msg('Admin.shell.nav.users'),
      msg('Admin.shell.nav.applications'),
      'Newsletter',
      msg('Admin.shell.nav.contact'),
      msg('Admin.shell.nav.security'),
      msg('Admin.shell.nav.settings'),
      msg('Admin.shell.newPost'),
      'Xem blog',
    ])
  })

  it('AUTHOR sees only their own posts, "Analytics" (their own posts), "Security" (their own sign-in), "Write a post" and "View blog"', () => {
    renderAt('/admin', 'AUTHOR')

    const nav = screen.getByRole('navigation', { name: msg('Site.account.admin') })
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent)
    expect(names).toEqual([
      msg('Admin.shell.nav.myPosts'),
      msg('Admin.shell.nav.analytics'),
      msg('Admin.shell.nav.security'),
      msg('Admin.shell.newPost'),
      'Xem blog',
    ])
    expect(within(nav).getByText('AUTHOR')).toBeInTheDocument()
  })

  it('without a role no empty cell is shown', () => {
    renderAt('/admin', null)

    const nav = screen.getByRole('navigation', { name: msg('Site.account.admin') })
    expect(within(nav).queryByText('ADMIN')).toBeNull()
    // The "present" counterpart: the rest of the menu is still complete.
    expect(within(nav).getByRole('button', { name: msg('Site.account.signOut') })).toBeInTheDocument()
  })

  it.each([
    ['/admin', msg('Site.about.readNextLinks.writing')],
    ['/admin/posts/11111111-1111-1111-1111-111111111111/edit', msg('Site.about.readNextLinks.writing')],
    ['/admin/series', 'Series'],
    ['/admin/series/abc', 'Series'],
    ['/admin/curated', msg('Site.footer.links.startHere')],
    ['/admin/gallery', msg('Site.footer.links.gallery')],
    ['/admin/topics', msg('Site.footer.links.topics')],
    ['/admin/comments', msg('Site.comments.heading')],
    ['/admin/users', msg('Admin.shell.nav.users')],
    ['/admin/analytics', msg('Admin.shell.nav.analytics')],
    ['/admin/newsletter', 'Newsletter'],
    ['/admin/contact', msg('Admin.shell.nav.contact')],
  ])('at %s only "%s" carries aria-current="page"', (path, label) => {
    renderAt(path)

    expect(currentLinks()).toEqual([`${label}=page`])
  })

  it('on the new-post page, "Write a post" is the current page, no other item', () => {
    // /admin/posts/new lies under /admin/posts, so "Posts" matched by prefix would also
    // get aria-current: two links both saying "this is the current page".
    renderAt('/admin/posts/new')

    expect(currentLinks()).toEqual([`${msg('Admin.shell.newPost')}=page`])
  })

  it('"Posts" does not light up on every page just because every URL starts with /admin', () => {
    renderAt('/admin/gallery')

    expect(screen.getByRole('link', { name: msg('Site.about.readNextLinks.writing') })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: msg('Site.footer.links.gallery') })).toHaveAttribute('aria-current', 'page')
  })

  it('each item has an icon before the label, and the icon does not add to the accessible name', () => {
    renderAt('/admin')

    for (const link of within(screen.getByRole('list', { name: msg('Admin.shell.sectionsLabel') })).getAllByRole('link')) {
      const icon = link.querySelector('svg')
      expect(icon, link.textContent ?? '').not.toBeNull()
      expect(icon).toHaveAttribute('aria-hidden', 'true')
      expect(link.firstElementChild).toBe(icon)
    }
  })

  it('the open item stands out by background and bold colour, the other items use slate-600 text (7:1 on slate-50)', () => {
    renderAt('/admin/series')

    expect(screen.getByRole('link', { name: 'Series' })).toHaveClass('bg-slate-200/70', 'text-slate-900')
    expect(screen.getByRole('link', { name: msg('Site.footer.links.gallery') })).toHaveClass('text-slate-600')
    expect(screen.getByRole('link', { name: msg('Site.footer.links.gallery') })).not.toHaveClass('bg-slate-200/70')
  })

  it('matches by path segment, not by string prefix', () => {
    // '/admin/series-cu'.startsWith('/admin/series') is true.
    renderAt('/admin/series-cu')

    expect(screen.getByRole('link', { name: 'Series' })).not.toHaveAttribute('aria-current')
    expect(currentLinks()).toEqual([])
  })
})

describe('AdminNav language switcher', () => {
  it('sits in the nav, after the sections, with the current language pressed', () => {
    pathname.value = '/admin/series'
    renderWithIntl(<AdminNav role="ADMIN" />, { locale: 'vi' })

    const nav = screen.getByRole('navigation', { name: msg('Site.account.admin') })
    const group = within(nav).getByRole('group', { name: msg('Admin.language.label') })
    expect(within(group).getByRole('button', { name: LANGUAGE_NAMES.vi })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false')
    expect(nav.querySelector<HTMLInputElement>('input[name="returnTo"]')).toHaveValue('/admin/series')
    const sections = within(nav).getByRole('list', { name: msg('Admin.shell.sectionsLabel') })
    expect(sections.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is reachable for an author too', () => {
    renderAt('/admin', 'AUTHOR')

    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument()
  })
})
