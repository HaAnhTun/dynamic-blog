import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pathname = vi.hoisted(() => ({ value: '/admin' }))
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ replace: vi.fn() }),
}))

import AdminSidebar, { isFullWidthRoute } from './AdminSidebar'
import { msg } from '@/test/render-intl'

beforeEach(() => {
  pathname.value = '/admin'
})

// Renamed on purpose: it used to be `isEditorRoute`, covering only the editor. The full-page preview
// of a post also needs the full width (the post at the blog's reading width), so the name says what it checks.
describe('isFullWidthRoute', () => {
  it.each([
    ['/admin/posts/new', true],
    ['/admin/posts/11111111-1111-1111-1111-111111111111/edit', true],
    ['/admin/posts/11111111-1111-1111-1111-111111111111/preview', true],
    ['/admin', false],
    ['/admin/series', false],
    ['/admin/posts', false],
    // By segment: a longer path is neither an editor page nor a preview.
    ['/admin/posts/abc/edit/thua', false],
    ['/admin/posts/abc/preview/thua', false],
    ['/admin/posts/new-thing', false],
    ['/admin/posts/preview', false],
    ['/admin/posts//preview', false],
  ])('%s → %s', (path, expected) => {
    expect(isFullWidthRoute(path)).toBe(expected)
  })
})

describe('AdminSidebar', () => {
  it('has the site name and the "Admin" nav', () => {
    render(<AdminSidebar siteName="Site name" role="ADMIN" />)

    expect(screen.getByRole('banner')).toHaveTextContent('Site name')
    expect(screen.getByRole('navigation', { name: msg('Site.account.admin') })).toBeInTheDocument()
  })

  it('the post editor has no sidebar: the writing area needs the full width', () => {
    pathname.value = '/admin/posts/new'
    const { container } = render(<AdminSidebar siteName="Site name" role="ADMIN" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('the preview of a post has no sidebar either: the post needs exactly the reading width of the blog', () => {
    pathname.value = '/admin/posts/11111111-1111-1111-1111-111111111111/preview'
    const { container } = render(<AdminSidebar siteName="Site name" role="ADMIN" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('the Menu button (phone) opens/closes the nav and states it through aria-expanded', async () => {
    render(<AdminSidebar siteName="Site name" role="ADMIN" />)
    const toggle = screen.getByRole('button', { name: 'Menu' })
    const nav = screen.getByRole('navigation', { name: msg('Site.account.admin') })

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', nav.id)
    // Closed below lg is `hidden`; lg:flex keeps the sidebar always visible on desktop.
    expect(nav).toHaveClass('hidden', 'lg:flex')

    await act(async () => fireEvent.click(toggle))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(nav).not.toHaveClass('hidden')
  })

  it('Escape closes an open menu and returns focus to the Menu button', async () => {
    render(<AdminSidebar siteName="Site name" role="ADMIN" />)
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await act(async () => fireEvent.click(toggle))
    const link = screen.getByRole('link', { name: 'Series' })
    link.focus()

    await act(async () => fireEvent.keyDown(link, { key: 'Escape' }))

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
  })

  it('pressing an item closes the menu', async () => {
    render(<AdminSidebar siteName="Site name" role="ADMIN" />)
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await act(async () => fireEvent.click(toggle))

    await act(async () => fireEvent.click(screen.getByRole('link', { name: msg('Site.footer.links.gallery') })))

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
