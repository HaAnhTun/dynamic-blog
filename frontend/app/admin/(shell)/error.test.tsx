import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pathname = vi.hoisted(() => ({ value: '/admin/series' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))

import AdminError from './error'
import { msg } from '@/test/render-intl'

beforeEach(() => {
  pathname.value = '/admin/series'
})

describe('Admin error page', () => {
  it('says what happened, offers retry and a way out; retry (refresh data), not reset', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const retry = vi.fn()
    render(<AdminError error={Object.assign(new Error('boom'), { digest: '4242' })} retry={retry} />)

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.errorPage.title') })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: msg('Site.profile.author.retry') }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: msg('Admin.shell.error.toPosts') })).toHaveAttribute('href', '/admin')
    // The digest code is the only thing that ties the screen to the server log.
    expect(screen.getByText(/4242/)).toBeInTheDocument()
    log.mockRestore()
  })

  it('error on the post list itself (/admin): no link back to /admin, since it cannot clear the error', () => {
    // The boundary only clears the error when the pathname changes; /admin?q=x → /admin is the same pathname.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    pathname.value = '/admin'
    render(<AdminError error={new Error('boom')} retry={vi.fn()} />)

    expect(screen.queryByRole('link', { name: msg('Admin.shell.error.toPosts') })).toBeNull()
    expect(screen.getByRole('button', { name: msg('Site.profile.author.retry') })).toBeInTheDocument()
    log.mockRestore()
  })

  it('without a digest there is no empty error-code line', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<AdminError error={new Error('boom')} retry={vi.fn()} />)

    expect(screen.queryByText(new RegExp(msg('Admin.shell.error.digest', { digest: '' }).trim()))).toBeNull()
    log.mockRestore()
  })
})
