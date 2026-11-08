import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getSiteContentOverview, getSectionRow, listRevisions, adminRole, redirect } = vi.hoisted(() => ({
  getSiteContentOverview: vi.fn(),
  getSectionRow: vi.fn(),
  listRevisions: vi.fn(),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
}))
vi.mock('@/lib/admin-site-content', () => ({ getSiteContentOverview, getSectionRow, listRevisions }))
vi.mock('@/lib/admin-api', () => ({ SessionExpiredError: class SessionExpiredError extends Error {} }))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({
  redirect,
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('./actions', () => ({
  importDocument: vi.fn(),
  loadSampleContent: vi.fn(),
  saveSection: vi.fn(),
  restoreRevision: vi.fn(),
  uploadAvatar: vi.fn(),
}))

import { ApiError } from '@/lib/api'
import { msg } from '@/test/render-intl'
import SettingsSectionPage from './[key]/page'
import SettingsPage from './page'

const row = { schemaVersion: 1, updatedAt: '2026-10-11T00:00:00Z', payload: {} }
const overview = (locale: string, sections: Record<string, unknown>) => ({
  locale,
  defaultLocale: 'vi',
  locales: ['vi', 'en'],
  sections,
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  adminRole.mockResolvedValue('ADMIN')
})

describe('settings index', () => {
  it('lists the nine sections with a saved or missing badge per language, links to the editor and the deployment line', async () => {
    getSiteContentOverview.mockImplementation(async (locale: string) =>
      overview(locale, locale === 'vi' ? { site: row, profile: row } : { site: row }),
    )

    render(await SettingsPage())

    const list = screen.getByRole('list', { name: msg('Admin.settings.listLabel') })
    expect(within(list).getAllByRole('link')).toHaveLength(18)
    const profile = within(list).getByText(msg('Admin.settings.sections.profile.title')).closest('li') as HTMLElement
    expect(within(profile).getAllByText(msg('Admin.settings.status.saved'))).toHaveLength(1)
    expect(within(profile).getAllByText(msg('Admin.settings.status.missing'))).toHaveLength(1)
    expect(
      within(profile).getByRole('link', {
        name: msg('Admin.settings.editAria', {
          section: msg('Admin.settings.sections.profile.title'),
          language: msg('Admin.settings.locales.en'),
        }),
      }),
    ).toHaveAttribute('href', '/admin/settings/profile?locale=en')
    expect(
      screen.getByRole('link', { name: msg('Admin.settings.export.download', { language: msg('Admin.settings.locales.vi') }) }),
    ).toHaveAttribute('href', '/admin/settings/export?locale=vi')
    expect(
      screen.getByText(
        msg('Admin.settings.deployment', {
          defaultLocale: msg('Admin.settings.locales.vi'),
          enabled: `${msg('Admin.settings.locales.vi')}, ${msg('Admin.settings.locales.en')}`,
        }),
      ),
    ).toBeInTheDocument()
  })

  it('links to the Markdown import page', async () => {
    getSiteContentOverview.mockImplementation(async (locale: string) => overview(locale, {}))

    render(await SettingsPage())

    expect(screen.getByRole('link', { name: msg('Admin.settings.profileImport.card.open') })).toHaveAttribute(
      'href',
      '/admin/settings/import',
    )
  })

  it('offers the sample content panel with its button', async () => {
    getSiteContentOverview.mockImplementation(async (locale: string) => overview(locale, {}))

    render(await SettingsPage())

    const section = screen.getByRole('region', { name: msg('Admin.settings.sampleContent.heading') })
    expect(within(section).getByText(msg('Admin.settings.sampleContent.intro'))).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: msg('Admin.settings.sampleContent.submit') })).toBeEnabled()
  })

  it('an author sees the admin-only notice and no backend call is made; 403 shows it too', async () => {
    adminRole.mockResolvedValue('AUTHOR')
    render(await SettingsPage())
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(getSiteContentOverview).not.toHaveBeenCalled()

    adminRole.mockResolvedValue('ADMIN')
    getSiteContentOverview.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    render(await SettingsPage())
    expect(screen.getAllByText(msg('Admin.common.adminOnly.title'))).toHaveLength(2)
  })
})

describe('settings editor page', () => {
  const page = (key: string, locale?: string) =>
    SettingsSectionPage({ params: Promise.resolve({ key }), searchParams: Promise.resolve(locale ? { locale } : {}) })

  it('starts from the packaged default when the language has no row, and shows the other language read-only', async () => {
    getSectionRow.mockImplementation(async (_key: string, locale: string) =>
      locale === 'vi' ? { ...row, payload: { name: 'Other name' } } : null,
    )

    render(await page('site', 'en'))

    expect(screen.getByText(msg('Admin.settings.notSaved'))).toBeInTheDocument()
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toBeInTheDocument()
    expect(screen.getByText(/"Other name"/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: msg('Admin.settings.locales.vi') })).toHaveAttribute(
      'href',
      '/admin/settings/site?locale=vi',
    )
    expect(screen.getByText(msg('Admin.settings.locales.en'))).toHaveAttribute('aria-current', 'page')
    expect(listRevisions).not.toHaveBeenCalled()
  })

  it('an unknown key is a 404 and a stranger language falls back to the default', async () => {
    await expect(page('users', 'en')).rejects.toThrow('NEXT_NOT_FOUND')

    getSectionRow.mockResolvedValue(null)
    render(await page('site', 'fr'))
    expect(getSectionRow).toHaveBeenCalledWith('site', 'vi')
  })

  it('a saved row loads its revisions', async () => {
    getSectionRow.mockResolvedValue({ ...row, payload: { name: 'Saved' } })
    listRevisions.mockResolvedValue([{ id: 4, schemaVersion: 1, createdAt: '2026-10-10T08:30:00Z' }])

    render(await page('site', 'vi'))

    expect(listRevisions).toHaveBeenCalledWith('site', 'vi')
    expect(screen.getByLabelText(msg('Admin.settings.site.name'))).toHaveValue('Saved')
    expect(screen.getAllByRole('button', { name: new RegExp(msg('Admin.settings.revisions.restore')) })).toHaveLength(1)
  })
})
