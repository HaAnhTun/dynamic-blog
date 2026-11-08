import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalleryPhotoAdmin } from '@/lib/types'

// Only prepareUpload is replaced (the part that touches the canvas); UploadRejectedError keeps the real one so the component
// recognizes it with instanceof as it does in the browser.
const { prepareUpload } = vi.hoisted(() => ({ prepareUpload: vi.fn() }))
vi.mock('@/lib/prepare-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prepare-upload')>()),
  prepareUpload,
}))

import { UploadRejectedError } from '@/lib/prepare-upload'
import GalleryUploader, { type PhotoOutcome } from './GalleryUploader'
import { msg } from '@/test/render-intl'

/** A case-insensitive regex matching a catalog message literally. */
const literal = (text: string, flags = 'i', prefix = '') =>
  new RegExp(prefix + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)

const onUpload = vi.fn<(form: FormData) => Promise<PhotoOutcome>>()
const onUploaded = vi.fn<(photo: GalleryPhotoAdmin) => void>()

const saved = (id: string): GalleryPhotoAdmin => ({
  id,
  image: { id: `m-${id}`, fileName: `${id}.jpg`, width: 1600, height: 1200, altText: `Photo ${id}`, dominantColor: null },
  caption: null,
  takenOn: null,
  published: true,
  sortOrder: 0,
  originalFilename: `${id}.jpg`,
  byteSize: 1000,
  createdAt: '2026-10-06T01:00:00Z',
  updatedAt: '2026-10-06T01:00:00Z',
})

const photo = (name: string) => new File([new Uint8Array(64)], name, { type: 'image/jpeg' })

// jsdom has no URL.createObjectURL/revokeObjectURL: replaced with a countable version.
let created: string[] = []
const revokeObjectURL = vi.fn<(url: string) => void>()
beforeEach(() => {
  created = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((file: File) => {
      const url = `blob:http://localhost/${encodeURIComponent(file.name)}`
      created.push(url)
      return url
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
  prepareUpload.mockImplementation(async (file: File) => file)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

function renderUploader() {
  return render(<GalleryUploader onUpload={onUpload} onUploaded={onUploaded} />)
}

async function choose(...files: File[]) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel')), { target: { files } })
  })
}

/** The row of a file in the queue, found by the file name shown on the row. */
const rowOf = (name: string) => screen.getByText(name).closest('li')!

function describeAs(name: string, altText: string) {
  fireEvent.change(within(rowOf(name)).getByLabelText(literal(msg('Admin.gallery.fields.altLabel'))), {
    target: { value: altText },
  })
}

async function clickUpload() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') }))
  })
}

/** A controllable promise: keeps one upload "running" so the in-between state can be observed. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('GalleryUploader', () => {
  it('the file input accepts several images, exactly three formats, and has NO name', () => {
    renderUploader()

    const input = screen.getByLabelText(msg('Admin.editor.cover.chooseLabel'))
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveAttribute('multiple')
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp')
    // The image only travels through the action, one file at a time and after being downsized; never through a form.
    expect(input).not.toHaveAttribute('name')
    // The real input is hidden from sight (the choose-images button is its label) but is still where Tab stops, and is still
    // read together with the format explanation sentence.
    expect(input).not.toHaveAttribute('tabindex')
    expect(input).toHaveAccessibleDescription(literal(msg('Admin.gallery.uploader.chooseHint'), ''))
  })

  it('choosing several files → a queue, each file with a preview from its own blob', async () => {
    renderUploader()

    await choose(photo('ho-tay.jpg'), photo('pho-co.jpg'))

    const queue = screen.getByRole('list', { name: msg('Admin.gallery.uploader.queueLabel') })
    expect(within(queue).getAllByRole('listitem')).toHaveLength(2)
    const preview = within(rowOf('ho-tay.jpg')).getByRole('img', {
      name: literal(msg('Admin.gallery.uploader.previewAlt', { name: 'ho-tay.jpg' })),
    })
    // With blob: next/image skips optimization and uses the URL directly, not through /_next/image.
    expect(preview).toHaveAttribute('src', created[0])
    expect(
      within(rowOf('pho-co.jpg')).getByRole('img', {
        name: literal(msg('Admin.gallery.uploader.previewAlt', { name: 'pho-co.jpg' })),
      }),
    ).toHaveAttribute('src', created[1])
  })

  it('description (alt) is required: missing on any image locks the upload button', async () => {
    renderUploader()
    // No image yet: nothing to upload.
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeDisabled()

    await choose(photo('ho-tay.jpg'), photo('pho-co.jpg'))
    expect(within(rowOf('ho-tay.jpg')).getByLabelText(literal(msg('Admin.gallery.fields.altLabel')))).toBeRequired()
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeDisabled()

    describeAs('ho-tay.jpg', 'Lake in the morning')
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeDisabled()

    describeAs('pho-co.jpg', '   ')
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeDisabled()

    // Positive counterpart: with every description filled the button can be clicked.
    describeAs('pho-co.jpg', 'Old quarter at night')
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeEnabled()
  })

  it('uploads SEQUENTIALLY: one action call per file, the next file starts only when the previous is done; progress "2/3" in the live region', async () => {
    const calls = [deferred<PhotoOutcome>(), deferred<PhotoOutcome>(), deferred<PhotoOutcome>()]
    for (const call of calls) onUpload.mockReturnValueOnce(call.promise)
    renderUploader()
    await choose(photo('a.jpg'), photo('b.jpg'), photo('c.jpg'))
    describeAs('a.jpg', msg('Site.gallery.photoName', { number: 'A' }))
    describeAs('b.jpg', msg('Site.gallery.photoName', { number: 'B' }))
    describeAs('c.jpg', msg('Site.gallery.photoName', { number: 'C' }))

    await clickUpload()

    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('1/3')

    await act(async () => calls[0].resolve(saved('a')))
    expect(onUpload).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('2/3')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')

    await act(async () => calls[1].resolve(saved('b')))
    await act(async () => calls[2].resolve(saved('c')))

    expect(onUpload).toHaveBeenCalledTimes(3)
    // In the chosen order, one file at a time.
    expect(onUpload.mock.calls.map(([form]) => (form.get('file') as File).name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(onUpload.mock.calls.map(([form]) => form.getAll('file').length)).toEqual([1, 1, 1])
    expect(onUploaded.mock.calls.map(([saved]) => saved.id)).toEqual(['a', 'b', 'c'])
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.gallery.uploader.done', { uploaded: '3', total: '3' }))
    // An uploaded image leaves the queue (the existing-images grid takes it), and the preview blob is released.
    expect(screen.queryByRole('list', { name: msg('Admin.gallery.uploader.queueLabel') })).toBeNull()
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(created)
  })

  it('sends the DOWNSIZED copy with the description, caption, capture date and visibility flag', async () => {
    const prepared = new File([new Uint8Array(16)], 'ho-tay.jpg', { type: 'image/jpeg' })
    prepareUpload.mockResolvedValue(prepared)
    onUpload.mockResolvedValue(saved('a'))
    renderUploader()
    const original = photo('ho-tay.jpg')
    await choose(original)
    const row = rowOf('ho-tay.jpg')
    describeAs('ho-tay.jpg', 'Lake in the morning')
    fireEvent.change(within(row).getByLabelText(msg('Admin.gallery.fields.captionLabel')), {
      target: { value: 'West Lake, September' },
    })
    fireEvent.change(within(row).getByLabelText(msg('Admin.gallery.fields.dateLabel')), { target: { value: '2026-09-14' } })
    fireEvent.click(within(row).getByLabelText(msg('Admin.gallery.fields.publishedLabel')))

    await clickUpload()

    expect(prepareUpload).toHaveBeenCalledWith(original)
    const form = onUpload.mock.calls[0][0]
    // An 8 MB original dies at the 5 MiB limit of the Server Action before the action even runs.
    expect(form.get('file')).toBe(prepared)
    expect(form.get('altText')).toBe('Lake in the morning')
    expect(form.get('caption')).toBe('West Lake, September')
    expect(form.get('takenOn')).toBe('2026-09-14')
    expect(form.get('published')).toBe('false')
  })

  describe('empty capture date box: takes the capture date recorded in the image, as the form promises', () => {
    /** A real JPEG with EXIF DateTimeOriginal, generated with sharp like the phone image of the e2e. */
    async function phoneJpeg(name: string): Promise<File> {
      const { default: sharp } = await import('sharp')
      const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#87b6e8' } })
        .jpeg()
        .withExifMerge({ IFD2: { DateTimeOriginal: '2026:09:14 17:30:00' } })
        .toBuffer()
      return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })
    }
    /** The canvas redraw: a new JPEG with no EXIF left. */
    const reencoded = (name: string) => new File([new Uint8Array(16)], name, { type: 'image/jpeg' })

    async function uploadLeavingDateBlank(original: File, date = '') {
      onUpload.mockResolvedValue(saved('a'))
      renderUploader()
      await choose(original)
      describeAs(original.name, msg('Site.gallery.photoName', { number: 'taken with a phone' }))
      const dateField = within(rowOf(original.name)).getByLabelText(msg('Admin.gallery.fields.dateLabel'))
      // Choosing an image does not fill in the date box: the promise is "if left empty, use the date in the image".
      expect(dateField).toHaveValue('')
      if (date !== '') fireEvent.change(dateField, { target: { value: date } })
      await clickUpload()
      return onUpload.mock.calls[0][0]
    }

    it('downsized image (redrawn through canvas): sends the date read from the ORIGINAL file EXIF', async () => {
      // QA e2e bug: a phone image > 4 MB is always redrawn, the new JPEG loses EXIF, the backend stores takenOn = null.
      const original = await phoneJpeg('IMG_0001.jpg')
      prepareUpload.mockResolvedValue(reencoded('IMG_0001.jpg'))

      const form = await uploadLeavingDateBlank(original)

      expect(form.get('file')).not.toBe(original)
      expect(form.get('takenOn')).toBe('2026-09-14')
    })

    it('a date the user typed always wins over the EXIF date', async () => {
      const original = await phoneJpeg('IMG_0002.jpg')
      prepareUpload.mockResolvedValue(reencoded('IMG_0002.jpg'))

      const form = await uploadLeavingDateBlank(original, '2025-01-02')

      expect(form.get('takenOn')).toBe('2025-01-02')
    })

    it('file sent as is (not downsized): left empty, the backend reads the EXIF of that very file', async () => {
      const original = await phoneJpeg('IMG_0003.jpg')

      const form = await uploadLeavingDateBlank(original)

      expect(form.get('file')).toBe(original)
      expect(form.get('takenOn')).toBe('')
    })

    it('downsized image without EXIF: still left empty, no invented date', async () => {
      prepareUpload.mockResolvedValue(reencoded('so-do.png'))

      const form = await uploadLeavingDateBlank(new File([new Uint8Array(64)], 'so-do.png', { type: 'image/png' }))

      expect(form.get('takenOn')).toBe('')
    })
  })

  it('visibility is on by default; next to the toggle it says plainly that a hidden image is not a private image', async () => {
    renderUploader()
    await choose(photo('ho-tay.jpg'))

    const toggle = within(rowOf('ho-tay.jpg')).getByLabelText(msg('Admin.gallery.fields.publishedLabel'))
    expect(toggle).toBeChecked()
    // Images are served publicly by a hard-to-guess UUID: hiding only means not listing.
    expect(toggle).toHaveAccessibleDescription(literal(msg('Admin.gallery.fields.publishedHint')))
  })

  it('one failed file does not block the next; the error shows next to that file, the file stays in the queue for a retry', async () => {
    onUpload.mockResolvedValueOnce({ error: msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED') }).mockResolvedValueOnce(saved('b'))
    renderUploader()
    await choose(photo('a.jpg'), photo('b.jpg'))
    describeAs('a.jpg', msg('Site.gallery.photoName', { number: 'A' }))
    describeAs('b.jpg', msg('Site.gallery.photoName', { number: 'B' }))

    await clickUpload()

    expect(onUpload).toHaveBeenCalledTimes(2)
    expect(within(rowOf('a.jpg')).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED'))
    expect(screen.queryByText('b.jpg')).toBeNull()
    expect(onUploaded).toHaveBeenCalledTimes(1)
    expect(onUploaded).toHaveBeenCalledWith(saved('b'))
    expect(screen.getByRole('status')).toHaveTextContent(msg('Admin.gallery.uploader.done', { uploaded: '1', total: '2' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      msg('Admin.gallery.uploader.doneWithFailures', { uploaded: '1', total: '2', failed: '1' }),
    )

    // Retry: only the failed file is left in the queue, and it is sent again.
    onUpload.mockResolvedValueOnce(saved('a'))
    await clickUpload()
    expect(onUpload).toHaveBeenCalledTimes(3)
    expect((onUpload.mock.calls[2][0].get('file') as File).name).toBe('a.jpg')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('prepareUpload rejects (HEIC) → error next to that file, no action called for it, the next file still goes', async () => {
    prepareUpload.mockImplementation(async (file: File) => {
      if (file.type === 'image/heic') throw new UploadRejectedError(msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE'))
      return file
    })
    onUpload.mockResolvedValue(saved('b'))
    renderUploader()
    await choose(new File([new Uint8Array(8)], 'IMG_0002.heic', { type: 'image/heic' }), photo('b.jpg'))
    describeAs('IMG_0002.heic', msg('Site.gallery.photoName', { number: 'HEIC' }))
    describeAs('b.jpg', msg('Site.gallery.photoName', { number: 'B' }))

    await clickUpload()

    expect(within(rowOf('IMG_0002.heic')).getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE'))
    expect(onUpload).toHaveBeenCalledTimes(1)
    expect((onUpload.mock.calls[0][0].get('file') as File).name).toBe('b.jpg')
  })

  it('while uploading: the upload button, the file input and the queue boxes are locked; unlocked when done', async () => {
    const call = deferred<PhotoOutcome>()
    onUpload.mockReturnValue(call.promise)
    renderUploader()
    await choose(photo('a.jpg'))
    describeAs('a.jpg', msg('Site.gallery.photoName', { number: 'A' }))

    await clickUpload()

    // Clicking twice on a slow network gives two copies of the same image in the gallery.
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeDisabled()
    expect(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel'))).toBeDisabled()
    expect(within(rowOf('a.jpg')).getByLabelText(literal(msg('Admin.gallery.fields.altLabel')))).toBeDisabled()

    await act(async () => call.resolve({ error: msg('Errors.admin.codes.MEDIA_BUSY') }))

    expect(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel'))).toBeEnabled()
    expect(screen.getByRole('button', { name: literal(msg('Admin.gallery.uploader.upload'), 'i', '^') })).toBeEnabled()
  })

  it('session expired (redirect action) → the queue stops, not shown as an error', async () => {
    onUpload.mockRejectedValue(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/login;307;' }))
    renderUploader()
    await choose(photo('a.jpg'), photo('b.jpg'))
    describeAs('a.jpg', msg('Site.gallery.photoName', { number: 'A' }))
    describeAs('b.jpg', msg('Site.gallery.photoName', { number: 'B' }))

    await clickUpload()

    // The router is navigating to /admin/login by itself: no further file is sent, and there is no "error".
    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('action rejected for another reason (network to Next dropped) → error next to the file, never silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onUpload.mockRejectedValue(new TypeError('Failed to fetch'))
    renderUploader()
    await choose(photo('a.jpg'))
    describeAs('a.jpg', msg('Site.gallery.photoName', { number: 'A' }))

    await clickUpload()

    expect(within(rowOf('a.jpg')).getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
  })

  it('"Remove" removes a file from the queue and releases its preview blob', async () => {
    renderUploader()
    await choose(photo('a.jpg'), photo('b.jpg'))

    fireEvent.click(
      within(rowOf('a.jpg')).getByRole('button', {
        name: literal(msg('Admin.gallery.uploader.removeFromQueueLabel', { name: 'a.jpg' })),
      }),
    )

    expect(screen.queryByText('a.jpg')).toBeNull()
    expect(screen.getByText('b.jpg')).toBeInTheDocument()
    expect(revokeObjectURL).toHaveBeenCalledWith(created[0])
    expect(revokeObjectURL).not.toHaveBeenCalledWith(created[1])
  })

  describe('dragging and dropping images onto the frame', () => {
    /** Text inside the drop frame: a drag event fires here, then bubbles to the frame, as when the pointer is over the text. */
    const zoneText = () => screen.getByText(msg('Admin.gallery.uploader.dropPrompt'))
    const zoneIsLit = () => zoneText().closest('[data-dragging]') !== null
    /** jsdom has no DataTransfer: a plain object, enough for what the component reads and writes. */
    const carrying = (...files: File[]) => ({ types: ['Files'], files, dropEffect: 'none' })

    it('dropping files on the frame: they enter the queue as when chosen by the button, and still go through prepareUpload on upload', async () => {
      onUpload.mockResolvedValue(saved('a'))
      renderUploader()
      const dropped = photo('ho-tay.jpg')
      const transfer = carrying(dropped)

      fireEvent.dragEnter(zoneText(), { dataTransfer: transfer })
      // Cancelling the default on dragover is what lets the browser allow the drop (dispatchEvent returns false).
      expect(fireEvent.dragOver(zoneText(), { dataTransfer: transfer })).toBe(false)
      expect(transfer.dropEffect).toBe('copy')
      await act(async () => {
        fireEvent.drop(zoneText(), { dataTransfer: transfer })
      })

      const queue = screen.getByRole('list', { name: msg('Admin.gallery.uploader.queueLabel') })
      expect(within(queue).getAllByRole('listitem')).toHaveLength(1)
      expect(
        within(rowOf('ho-tay.jpg')).getByRole('img', {
          name: literal(msg('Admin.gallery.uploader.previewAlt', { name: 'ho-tay.jpg' })),
        }),
      ).toHaveAttribute('src', created[0])
      expect(zoneIsLit()).toBe(false)

      describeAs('ho-tay.jpg', 'Lake in the morning')
      await clickUpload()

      // Same path as the file input: downsized in the browser, then the action.
      expect(prepareUpload).toHaveBeenCalledWith(dropped)
      expect(onUploaded).toHaveBeenCalledWith(saved('a'))
    })

    it('the frame lights up while dragging files over it, also while passing over the text and button inside; it turns off when leaving the frame entirely', () => {
      renderUploader()
      const transfer = carrying(photo('a.jpg'))
      const chooser = screen.getByText(msg('Admin.editor.cover.chooseLabel'))

      fireEvent.dragEnter(zoneText(), { dataTransfer: transfer })
      expect(zoneIsLit()).toBe(true)
      // From text to button: the browser fires dragenter on the button BEFORE dragleave on the text. The frame must not
      // flicker between those two events.
      fireEvent.dragEnter(chooser, { dataTransfer: transfer })
      fireEvent.dragLeave(zoneText(), { dataTransfer: transfer })
      expect(zoneIsLit()).toBe(true)
      fireEvent.dragLeave(chooser, { dataTransfer: transfer })
      expect(zoneIsLit()).toBe(false)
    })

    it('dragging a piece of text (not a file) over the frame: it does not light up, does not accept', () => {
      renderUploader()
      const text = { types: ['text/plain'], files: [], dropEffect: 'none' }

      fireEvent.dragEnter(zoneText(), { dataTransfer: text })

      expect(zoneIsLit()).toBe(false)
      expect(fireEvent.dragOver(zoneText(), { dataTransfer: text })).toBe(true)
    })

    it('while uploading: the frame accepts no more drops, like the file input being locked', async () => {
      const call = deferred<PhotoOutcome>()
      onUpload.mockReturnValue(call.promise)
      renderUploader()
      await choose(photo('a.jpg'))
      describeAs('a.jpg', msg('Site.gallery.photoName', { number: 'A' }))
      await clickUpload()

      const transfer = carrying(photo('b.jpg'))
      fireEvent.dragEnter(zoneText(), { dataTransfer: transfer })
      fireEvent.dragOver(zoneText(), { dataTransfer: transfer })
      expect(zoneIsLit()).toBe(false)
      // The "drop not allowed" cursor, not "copy".
      expect(transfer.dropEffect).toBe('none')
      await act(async () => {
        fireEvent.drop(zoneText(), { dataTransfer: transfer })
      })
      expect(screen.queryByText('b.jpg')).toBeNull()

      await act(async () => call.resolve(saved('a')))
      expect(onUpload).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('b.jpg')).toBeNull()
    })

    it('a file dropped outside the frame: the browser must not open it (leaving the page and losing the half-filled queue)', async () => {
      renderUploader()
      await choose(photo('a.jpg'))

      // dispatchEvent returns false when the default was cancelled.
      expect(fireEvent.dragOver(document.body, { dataTransfer: carrying() })).toBe(false)
      expect(fireEvent.drop(document.body, { dataTransfer: carrying(photo('b.jpg')) })).toBe(false)
      // Outside the frame it does not enter the queue either: only the frame is the drop target.
      expect(screen.queryByText('b.jpg')).toBeNull()
      expect(screen.getByText('a.jpg')).toBeInTheDocument()
      // Negative counterpart: dragging text, the page does not interfere.
      expect(fireEvent.dragOver(document.body, { dataTransfer: { types: ['text/plain'] } })).toBe(true)
    })
  })
})
