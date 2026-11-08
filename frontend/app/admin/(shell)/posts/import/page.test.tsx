import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { adminRole, listCategories, redirect } = vi.hoisted(() => ({
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
  listCategories: vi.fn(async (): Promise<unknown[]> => []),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  }),
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('@/lib/admin-api', () => ({
  listCategories,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('./actions', () => ({
  previewPosts: vi.fn(),
  applyPosts: vi.fn(),
  checkArticle: vi.fn(),
  renderArticle: vi.fn(),
}))

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { msg } from '@/test/render-intl'
import PostImportPage from './page'

afterEach(() => {
  vi.clearAllMocks()
  adminRole.mockResolvedValue('ADMIN')
  listCategories.mockResolvedValue([])
})

describe('post import page', () => {
  it.each(['ADMIN', 'AUTHOR'])('renders the import with the title and a link back to the posts for an %s', async (role) => {
    adminRole.mockResolvedValue(role)

    render(await PostImportPage())

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.posts.import.page.title') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.posts.import.page.back') })).toHaveAttribute('href', '/admin')
    expect(screen.getByRole('link', { name: msg('Admin.posts.import.template.download') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.posts.import.template.authoringDownload') })).toHaveAttribute(
      'href',
      '/admin/posts/import/authoring-prompt',
    )
    expect(screen.getByText(msg('Admin.posts.import.files.dropTitle'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.common.adminOnly.title'))).not.toBeInTheDocument()
  })

  it('a token without an admin or author role gets the no access notice instead of the form', async () => {
    adminRole.mockResolvedValue(null)

    render(await PostImportPage())

    expect(screen.getByText(msg('Admin.common.noAccess.account.title'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.posts.import.files.dropTitle'))).not.toBeInTheDocument()
  })

  it('a 403 from the backend (the token still carries an old role) gets the no access notice instead of the form', async () => {
    listCategories.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Forbidden'))

    render(await PostImportPage())

    expect(screen.getByText(msg('Admin.common.noAccess.account.title'))).toBeInTheDocument()
    expect(screen.queryByText(msg('Admin.posts.import.files.dropTitle'))).not.toBeInTheDocument()
  })

  it('an expired session goes to the login', async () => {
    listCategories.mockRejectedValue(new SessionExpiredError())

    await expect(PostImportPage()).rejects.toThrow('NEXT_REDIRECT')

    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  it('any other failure of the backend is not hidden', async () => {
    listCategories.mockRejectedValue(new ApiError(500, 'INTERNAL', 'Boom'))

    await expect(PostImportPage()).rejects.toThrow('Boom')
  })
})
