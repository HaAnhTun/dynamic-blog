import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalleryPhotoAdmin } from '@/lib/types'

const { prepareUpload } = vi.hoisted(() => ({ prepareUpload: vi.fn() }))
vi.mock('@/lib/prepare-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prepare-upload')>()),
  prepareUpload,
}))

import GalleryManager, { type DeleteOutcome, type OrderOutcome } from './GalleryManager'
import type { PhotoFields, PhotoOutcome } from './GalleryUploader'
import { msg } from '@/test/render-intl'

/** A regex matching a catalog message literally (optionally anchored with a prefix such as '^'). */
const literal = (text: string, flags = 'i', prefix = '') =>
  new RegExp(prefix + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)

const photo = (id: string, altText: string | null, over: Partial<GalleryPhotoAdmin> = {}): GalleryPhotoAdmin => ({
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

const A = photo('a', 'Wooden bridge in the mist', { caption: 'Sa Pa', takenOn: '2026-09-14' })
const B = photo('b', 'Old quarter at night', { published: false })
const C = photo('c', 'Floating market at dawn')

const onUpload = vi.fn<(form: FormData) => Promise<PhotoOutcome>>()
const onSave = vi.fn<(id: string, fields: PhotoFields) => Promise<PhotoOutcome>>()
const onDelete = vi.fn<(id: string) => Promise<DeleteOutcome>>()
const onReorder = vi.fn<(photoIds: string[]) => Promise<OrderOutcome>>()

function renderManager(photos: GalleryPhotoAdmin[] = [A, B, C]) {
  return render(<GalleryManager photos={photos} onUpload={onUpload} onSave={onSave} onDelete={onDelete} onReorder={onReorder} />)
}

const list = () => screen.getByRole('list', { name: msg('Admin.gallery.manager.orderLabel') })
const rows = () => within(list()).getAllByRole('listitem')
/** The row of an image, found by its thumbnail (name = the saved description). */
const rowOf = (altText: string) => within(list()).getByRole('img', { name: altText }).closest('li')!
const order = () => rows().map((row) => within(row).getByRole('img').getAttribute('alt'))

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:x') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
  prepareUpload.mockImplementation(async (file: File) => file)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('GalleryManager', () => {
  it('each image: thumbnail via /media, edit boxes prefilled with the saved values; a hidden image has a label', () => {
    renderManager()

    expect(order()).toEqual(['Wooden bridge in the mist', 'Old quarter at night', 'Floating market at dawn'])
    const first = rowOf('Wooden bridge in the mist')
    const thumbnail = within(first).getByRole('img', { name: 'Wooden bridge in the mist' })
    const source = new URL(thumbnail.getAttribute('src') ?? '', 'http://localhost').searchParams.get('url')
    expect(source).toBe('/media/a.jpg')
    expect(within(first).getByLabelText(literal(msg('Admin.gallery.fields.altLabel')))).toHaveValue('Wooden bridge in the mist')
    expect(within(first).getByLabelText(msg('Admin.gallery.fields.captionLabel'))).toHaveValue('Sa Pa')
    expect(within(first).getByLabelText(msg('Admin.gallery.fields.dateLabel'))).toHaveValue('2026-09-14')
    expect(within(first).getByLabelText(msg('Admin.gallery.fields.publishedLabel'))).toBeChecked()
    expect(first).not.toHaveTextContent(msg('Admin.gallery.manager.hiddenBadge'))

    const hidden = rowOf('Old quarter at night')
    expect(within(hidden).getByLabelText(msg('Admin.gallery.fields.publishedLabel'))).not.toBeChecked()
    expect(hidden).toHaveTextContent(msg('Admin.gallery.manager.hiddenBadge'))
  })

  it('next to the heading: total image count and hidden image count, counted over the list currently shown', async () => {
    onDelete.mockResolvedValue(null)
    renderManager()

    expect(screen.getByText(msg('Admin.gallery.manager.tallyWithHidden', { count: '3', hidden: '1' }))).toBeInTheDocument()

    const row = rowOf('Old quarter at night')
    await click(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.delete'), 'i', '^') }))
    await click(within(row).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    // Once no image is hidden only the total remains, with no hidden-count text such as "0 hidden".
    expect(screen.getByText(msg('Admin.gallery.manager.tally', { count: '2' }))).toBeInTheDocument()
  })

  it('next to the visibility toggle it says plainly that a hidden image is not a private image', () => {
    renderManager()

    expect(
      within(rowOf('Old quarter at night')).getByLabelText(msg('Admin.gallery.fields.publishedLabel')),
    ).toHaveAccessibleDescription(literal(msg('Admin.gallery.fields.publishedHint')))
  })

  it('editing then "Save" sends all four fields of exactly that image, then shows the values the backend saved', async () => {
    onSave.mockResolvedValue({
      ...A,
      caption: 'Sa Pa, September',
      image: { ...A.image, altText: 'Wooden bridge' },
      published: false,
    })
    renderManager()
    const row = rowOf('Wooden bridge in the mist')

    fireEvent.change(within(row).getByLabelText(literal(msg('Admin.gallery.fields.altLabel'))), {
      target: { value: '  Wooden bridge  ' },
    })
    fireEvent.change(within(row).getByLabelText(msg('Admin.gallery.fields.captionLabel')), {
      target: { value: 'Sa Pa, September' },
    })
    fireEvent.click(within(row).getByLabelText(msg('Admin.gallery.fields.publishedLabel')))
    await click(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.save'), 'i', '^') }))

    expect(onSave).toHaveBeenCalledWith('a', {
      altText: '  Wooden bridge  ',
      caption: 'Sa Pa, September',
      takenOn: '2026-09-14',
      published: false,
    })
    // The trimmed description the backend returns, not the string just typed; the thumbnail name changes with it.
    const saved = rowOf('Wooden bridge')
    expect(within(saved).getByLabelText(literal(msg('Admin.gallery.fields.altLabel')))).toHaveValue('Wooden bridge')
    expect(saved).toHaveTextContent(msg('Admin.gallery.manager.hiddenBadge'))
    expect(screen.getByText(msg('Admin.gallery.manager.photoSaved', { name: 'Wooden bridge' }))).toBeInTheDocument()
  })

  it('an empty description locks the "Save" button of that image', () => {
    renderManager()
    const row = rowOf('Floating market at dawn')

    fireEvent.change(within(row).getByLabelText(literal(msg('Admin.gallery.fields.altLabel'))), { target: { value: '  ' } })

    expect(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.save'), 'i', '^') })).toBeDisabled()
    // Positive counterpart: another image can still be saved.
    expect(
      within(rowOf('Old quarter at night')).getByRole('button', { name: literal(msg('Admin.gallery.manager.save'), 'i', '^') }),
    ).toBeEnabled()
  })

  it('save error → the message appears in the row of that image', async () => {
    onSave.mockResolvedValue({ error: msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND') })
    renderManager()
    const row = rowOf('Floating market at dawn')

    await click(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.save'), 'i', '^') }))

    expect(within(row).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND'))
  })

  it('↑↓ only reorder on screen; "Save order" sends the full permutation of EVERY image in the new order', async () => {
    onReorder.mockImplementation(async (ids) => ids.map((id) => [A, B, C].find((p) => p.id === id)!))
    renderManager()

    await click(
      within(rowOf('Floating market at dawn')).getByRole('button', {
        name: msg('Admin.gallery.manager.moveUpLabel', { name: 'Floating market at dawn' }),
      }),
    )
    expect(order()).toEqual(['Wooden bridge in the mist', 'Floating market at dawn', 'Old quarter at night'])
    await click(
      within(rowOf('Wooden bridge in the mist')).getByRole('button', {
        name: msg('Admin.gallery.manager.moveDownLabel', { name: 'Wooden bridge in the mist' }),
      }),
    )
    expect(order()).toEqual(['Floating market at dawn', 'Wooden bridge in the mist', 'Old quarter at night'])
    expect(onReorder).not.toHaveBeenCalled()
    expect(screen.getByText(msg('Admin.gallery.manager.unsaved'))).toBeInTheDocument()

    await click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))

    // Including hidden images: the backend only accepts a permutation of all images.
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b'])
    expect(screen.queryByText(msg('Admin.gallery.manager.unsaved'))).toBeNull()
    expect(screen.getByText(msg('Admin.series.parts.orderSaved'))).toBeInTheDocument()
  })

  it('saving the order with a stale list (400) → reload-the-page message, on-screen order kept', async () => {
    onReorder.mockResolvedValue({ error: msg('Errors.admin.staleList') })
    renderManager()

    await click(
      within(rowOf('Old quarter at night')).getByRole('button', {
        name: msg('Admin.gallery.manager.moveUpLabel', { name: 'Old quarter at night' }),
      }),
    )
    await click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.staleList'))
    expect(order()).toEqual(['Old quarter at night', 'Wooden bridge in the mist', 'Floating market at dawn'])
    expect(screen.getByText(msg('Admin.gallery.manager.unsaved'))).toBeInTheDocument()
  })

  it('while an action is pending: every button is locked (clicking twice does not send twice), unlocked when done', async () => {
    let finish!: (value: OrderOutcome) => void
    onReorder.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderManager()

    await click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))

    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeDisabled()
    expect(
      within(rowOf('Wooden bridge in the mist')).getByRole('button', {
        name: literal(msg('Admin.gallery.manager.save'), 'i', '^'),
      }),
    ).toBeDisabled()
    expect(
      within(rowOf('Wooden bridge in the mist')).getByRole('button', {
        name: literal(msg('Admin.gallery.manager.delete'), 'i', '^'),
      }),
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))
    expect(onReorder).toHaveBeenCalledTimes(1)

    await act(async () => finish([A, B, C]))
    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeEnabled()
  })

  it('delete needs in-place confirmation (no window.confirm); confirming removes the image from the list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    onDelete.mockResolvedValue(null)
    renderManager()
    const row = rowOf('Old quarter at night')

    await click(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.delete'), 'i', '^') }))

    expect(onDelete).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(
      within(row).getByRole('group', { name: literal(msg('Admin.gallery.manager.deleteQuestion').split('?')[0] + '?') }),
    ).toBeInTheDocument()
    // A second Enter on the same spot must cancel, not delete.
    expect(within(row).getByRole('button', { name: msg('Site.comments.form.cancel') })).toHaveFocus()

    await click(within(row).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    expect(onDelete).toHaveBeenCalledWith('b')
    expect(order()).toEqual(['Wooden bridge in the mist', 'Floating market at dawn'])
    // The button holding focus just vanished with its row: focus goes to the list heading, not
    // falling to <body> (keyboard and screen-reader users would lose their place).
    expect(screen.getByRole('heading', { name: msg('Admin.gallery.manager.heading') })).toHaveFocus()
  })

  it('"Cancel" closes the confirmation step, deletes nothing, returns focus to the delete button', async () => {
    renderManager()
    const row = rowOf('Old quarter at night')

    await click(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.delete'), 'i', '^') }))
    await click(within(row).getByRole('button', { name: msg('Site.comments.form.cancel') }))

    expect(within(row).queryByRole('button', { name: msg('Admin.posts.delete.forever') })).toBeNull()
    expect(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.delete'), 'i', '^') })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('delete error → message in the row, the image is still there', async () => {
    onDelete.mockResolvedValue({ error: msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND') })
    renderManager()
    const row = rowOf('Old quarter at night')

    await click(within(row).getByRole('button', { name: literal(msg('Admin.gallery.manager.delete'), 'i', '^') }))
    await click(within(row).getByRole('button', { name: msg('Admin.posts.delete.forever') }))

    expect(within(row).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.GALLERY_PHOTO_NOT_FOUND'))
    expect(order()).toHaveLength(3)
    // Counterpart of the test above: the row is still there, so focus stays in the row instead of jumping to the heading.
    expect(screen.getByRole('heading', { name: msg('Admin.gallery.manager.heading') })).not.toHaveFocus()
  })

  it('session expired (redirect action) is not shown as an error', async () => {
    onReorder.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/login;307;' }))
    renderManager()

    await click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))

    // The router is navigating to /admin/login by itself; a NEXT_REDIRECT "error" on screen would be wrong.
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a just-uploaded image goes to the top of the list and is part of the permutation sent', async () => {
    const N = photo('n', msg('Site.gallery.photoName', { number: 'just uploaded' }))
    onUpload.mockResolvedValue(N)
    onReorder.mockResolvedValue([N, A, B, C])
    renderManager()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel')), {
        target: { files: [new File([new Uint8Array(8)], 'moi.jpg', { type: 'image/jpeg' })] },
      })
    })
    const queued = screen.getByText('moi.jpg').closest('li')!
    fireEvent.change(within(queued).getByLabelText(literal(msg('Admin.gallery.fields.altLabel'))), {
      target: { value: msg('Site.gallery.photoName', { number: 'just uploaded' }) },
    })
    await click(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') }))

    // The backend puts the new image first (sort_order = MIN - 1): the screen must match, otherwise the next
    // order save misses one image and is rejected as if from a stale tab.
    expect(order()).toEqual([
      msg('Site.gallery.photoName', { number: 'just uploaded' }),
      'Wooden bridge in the mist',
      'Old quarter at night',
      'Floating market at dawn',
    ])
    await click(screen.getByRole('button', { name: msg('Admin.series.parts.save') }))
    expect(onReorder).toHaveBeenCalledWith(['n', 'a', 'b', 'c'])
  })

  it('"Save order" is locked while a batch is uploading, unlocked when the batch finishes', async () => {
    // An image still mid-upload is not in the list yet: saving then sends a permutation missing an image, the backend
    // rejects it as if from a stale tab, and the user is told to reload the page for no reason.
    let finish!: (value: PhotoOutcome) => void
    onUpload.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderManager()
    await act(async () => {
      fireEvent.change(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel')), {
        target: { files: [new File([new Uint8Array(8)], 'moi.jpg', { type: 'image/jpeg' })] },
      })
    })
    const queued = screen.getByText('moi.jpg').closest('li')!
    fireEvent.change(within(queued).getByLabelText(literal(msg('Admin.gallery.fields.altLabel'))), {
      target: { value: msg('Site.gallery.photoName', { number: 'just uploaded' }) },
    })
    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeEnabled()

    await click(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') }))

    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeDisabled()
    await act(async () => finish(photo('n', msg('Site.gallery.photoName', { number: 'just uploaded' }))))
    expect(screen.getByRole('button', { name: msg('Admin.series.parts.save') })).toBeEnabled()
    expect(order()[0]).toBe(msg('Site.gallery.photoName', { number: 'just uploaded' }))
  })

  it('no images yet: says so plainly, no list and no save-order button', () => {
    renderManager([])

    expect(screen.getByText(msg('Site.gallery.empty'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: msg('Admin.gallery.manager.orderLabel') })).toBeNull()
    expect(screen.queryByRole('button', { name: msg('Admin.series.parts.save') })).toBeNull()
    // Positive counterpart: the upload area is still there.
    expect(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel'))).toBeInTheDocument()
  })
})
