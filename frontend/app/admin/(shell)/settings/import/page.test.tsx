import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getImportStatus, adminRole, redirect } = vi.hoisted(() => ({
  getImportStatus: vi.fn(),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
}))
vi.mock('@/lib/admin-site-import', () => ({ getImportStatus }))
vi.mock('@/lib/admin-api', () => ({ SessionExpiredError: class SessionExpiredError extends Error {} }))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
}))
vi.mock('./actions', () => ({ previewProfile: vi.fn(), applyProfile: vi.fn(), undoProfile: vi.fn(), loadImportStatus: vi.fn() }))

import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { msg } from '@/test/render-intl'
import ProfileImportPage from './page'

afterEach(() => {
  vi.clearAllMocks()
  adminRole.mockResolvedValue('ADMIN')
})

describe('profile import page', () => {
  it('renders the import with the title and a link back to the settings', async () => {
    getImportStatus.mockResolvedValue({ lastImport: null })

    render(await ProfileImportPage())

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.settings.profileImport.page.title') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.settings.allSettings') })).toHaveAttribute('href', '/admin/settings')
    expect(screen.getByRole('link', { name: msg('Admin.settings.profileImport.template.download') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: msg('Admin.settings.profileImport.undo.button') })).not.toBeInTheDocument()
  })

  it('shows the undo button when the last import can be undone', async () => {
    getImportStatus.mockResolvedValue({
      lastImport: {
        id: 1,
        createdAt: '2026-10-11T10:00:00Z',
        locale: 'vi',
        mode: 'update',
        undone: false,
        undoable: true,
        sections: [{ key: 'profile', status: 'updated' }],
      },
    })

    render(await ProfileImportPage())

    expect(screen.getByRole('button', { name: msg('Admin.settings.profileImport.undo.button') })).toBeInTheDocument()
  })

  it('an author sees the admin-only notice without a backend call; 403 shows it too; an expired session goes to login', async () => {
    adminRole.mockResolvedValue('AUTHOR')
    render(await ProfileImportPage())
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(getImportStatus).not.toHaveBeenCalled()

    adminRole.mockResolvedValue('ADMIN')
    getImportStatus.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    render(await ProfileImportPage())
    expect(screen.getAllByText(msg('Admin.common.adminOnly.title'))).toHaveLength(2)

    getImportStatus.mockRejectedValueOnce(new SessionExpiredError())
    await expect(ProfileImportPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })
})
