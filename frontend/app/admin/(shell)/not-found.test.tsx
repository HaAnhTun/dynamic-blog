import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AdminNotFound from './not-found'
import { msg } from '@/test/render-intl'

describe('Admin not-found page', () => {
  it('says the page is gone and links back to the post list, inside the admin frame (no public chrome)', () => {
    render(<AdminNotFound />)

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.notFound.title') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.shell.error.toPosts') })).toHaveAttribute('href', '/admin')
    expect(screen.queryByRole('banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  })
})
