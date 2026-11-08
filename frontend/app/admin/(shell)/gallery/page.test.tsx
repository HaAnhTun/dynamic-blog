import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GalleryPhotoAdmin } from '@/lib/types'

const { listAdminGallery, getMediaUsage, redirect, adminRole } = vi.hoisted(() => ({
  listAdminGallery: vi.fn(),
  getMediaUsage: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT')
  }),
  adminRole: vi.fn(async (): Promise<string | null> => 'ADMIN'),
}))
vi.mock('@/lib/admin-api', () => ({
  listAdminGallery,
  getMediaUsage,
  SessionExpiredError: class SessionExpiredError extends Error {},
}))
vi.mock('@/lib/admin-role', () => ({ adminRole }))
vi.mock('next/navigation', () => ({ redirect }))
// The action file is 'use server' and pulls in next/cache; the page only passes them down to GalleryManager.
vi.mock('./actions', () => ({
  uploadPhoto: vi.fn(),
  savePhoto: vi.fn(),
  removePhoto: vi.fn(),
  saveOrder: vi.fn(),
}))

import { ApiError } from '@/lib/api'
import GalleryAdminPage from './page'
import { msg } from '@/test/render-intl'

const photo = (id: string, altText: string, over: Partial<GalleryPhotoAdmin> = {}): GalleryPhotoAdmin => ({
  id,
  image: { id: `m-${id}`, fileName: `${id}.jpg`, width: 1600, height: 1200, altText, dominantColor: '#334455' },
  caption: null,
  takenOn: null,
  published: true,
  sortOrder: 0,
  originalFilename: `${id}.jpg`,
  byteSize: 1000,
  createdAt: '2026-10-06T01:00:00Z',
  updatedAt: '2026-10-06T01:00:00Z',
  ...over,
})

afterEach(() => vi.clearAllMocks())

describe('/admin/gallery', () => {
  it('heading, upload area, and every photo (hidden ones included) in the order the backend returns', async () => {
    listAdminGallery.mockResolvedValue([
      photo('a1', 'Wooden bridge in the mist'),
      photo('b2', 'Old quarter at dusk', { published: false }),
    ])

    render(await GalleryAdminPage())

    expect(screen.getByRole('heading', { level: 1, name: msg('Site.footer.links.gallery') })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: msg('Admin.editor.cover.upload') })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: msg('Admin.gallery.manager.orderLabel') })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole('img', { name: 'Wooden bridge in the mist' })).toBeInTheDocument()
    expect(within(rows[1]).getByRole('img', { name: 'Old quarter at dusk' })).toBeInTheDocument()
    // The public page is exactly /gallery, so whoever orders can see the result.
    expect(screen.getByRole('link', { name: msg('Site.footer.links.gallery') })).toHaveAttribute('href', '/gallery')
  })

  it('no photo yet: says so plainly; the upload area is still there', async () => {
    listAdminGallery.mockResolvedValue([])

    render(await GalleryAdminPage())

    expect(screen.getByText(msg('Site.gallery.empty'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: msg('Admin.gallery.manager.orderLabel') })).toBeNull()
    expect(screen.getByRole('region', { name: msg('Admin.editor.cover.upload') })).toBeInTheDocument()
  })

  it('session expired while loading the page → to the login page', async () => {
    const { SessionExpiredError } = await import('@/lib/admin-api')
    listAdminGallery.mockRejectedValue(new SessionExpiredError())

    await expect(GalleryAdminPage()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/admin/login')
  })

  // Pinned on purpose: the gallery's own sentence gives way to the shared AdminOnly state.
  it('403 (the token still carries an old role) → the admin-only page, no redirect', async () => {
    listAdminGallery.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    render(await GalleryAdminPage())

    // Still the gallery page, only the content is replaced by the explanation.
    expect(screen.getByRole('heading', { level: 1, name: msg('Site.footer.links.gallery') })).toBeInTheDocument()
    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: msg('Admin.editor.cover.upload') })).toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('AUTHOR: the admin-only page, does not call the backend', async () => {
    adminRole.mockResolvedValueOnce('AUTHOR')

    render(await GalleryAdminPage())

    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(listAdminGallery).not.toHaveBeenCalled()
    expect(getMediaUsage).not.toHaveBeenCalled()
  })

  it('another error (backend down) is not turned into a redirect to the login page', async () => {
    listAdminGallery.mockRejectedValue(new Error('fetch failed'))

    await expect(GalleryAdminPage()).rejects.toThrow('fetch failed')
    expect(redirect).not.toHaveBeenCalled()
  })
})

describe('/admin/gallery: storage used', () => {
  const GB = 1024 ** 3

  it('the usage gauge at the top of the page, read in parallel with the photo list', async () => {
    let finishList!: (photos: GalleryPhotoAdmin[]) => void
    listAdminGallery.mockReturnValue(new Promise((done) => (finishList = done)))
    getMediaUsage.mockResolvedValue({ usedBytes: GB / 2, maxBytes: GB, count: 2 })

    const rendering = GalleryAdminPage()
    // The second call went out before the first answered: two requests in parallel, not in sequence.
    await vi.waitFor(() => expect(getMediaUsage).toHaveBeenCalledTimes(1))
    finishList([photo('a1', 'Wooden bridge in the mist')])
    render(await rendering)

    const meter = screen.getByRole('meter', { name: msg('Admin.common.quota.title') })
    expect(meter).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText(msg('Admin.gallery.manager.tally', { count: '512 MB / 1 GB (50%) · 2' }))).toBeInTheDocument()
    // Before the upload area: what one needs to know before choosing a photo.
    expect(
      meter.compareDocumentPosition(screen.getByRole('region', { name: msg('Admin.editor.cover.upload') })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it.each([
    ['old backend without the endpoint (404)', new ApiError(404, 'ENDPOINT_NOT_FOUND', 'The requested endpoint does not exist')],
    ['server error', new ApiError(500, 'INTERNAL_ERROR', 'boom')],
    ['connection lost', new TypeError('fetch failed')],
  ])('%s: no gauge, the photo page is still usable', async (_label, failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listAdminGallery.mockResolvedValue([photo('a1', 'Wooden bridge in the mist')])
    getMediaUsage.mockRejectedValue(failure)

    render(await GalleryAdminPage())

    expect(screen.queryByRole('meter')).toBeNull()
    expect(screen.getByRole('list', { name: msg('Admin.gallery.manager.orderLabel') })).toBeInTheDocument()
    expect(redirect).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('malformed response body (not a number): treated as unreadable, no "NaN%" gauge drawn', async () => {
    listAdminGallery.mockResolvedValue([])
    getMediaUsage.mockResolvedValue({ usedBytes: '7', maxBytes: null, count: 1 })

    render(await GalleryAdminPage())

    expect(screen.queryByRole('meter')).toBeNull()
  })

  it('403 (not ADMIN): the explanation, no gauge', async () => {
    listAdminGallery.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))
    getMediaUsage.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Access denied'))

    render(await GalleryAdminPage())

    expect(screen.getByText(msg('Admin.common.adminOnly.title'))).toBeInTheDocument()
    expect(screen.queryByRole('meter')).toBeNull()
  })
})
