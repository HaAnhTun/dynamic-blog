import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaRef, PostSummary } from '@/lib/types'

// Only prepareUpload is replaced (the part that touches the canvas); UploadRejectedError keeps the real one so the component
// recognizes it with instanceof as it does in the browser.
const { prepareUpload } = vi.hoisted(() => ({ prepareUpload: vi.fn() }))
vi.mock('@/lib/prepare-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prepare-upload')>()),
  prepareUpload,
}))

import { UploadRejectedError } from '@/lib/prepare-upload'
import CoverPanel, { type CoverOutcome } from './CoverPanel'
import { COVER_MIN_WIDTH, COVER_RECOMMENDED_WIDTH } from '@/lib/image-quality'
import { msg } from '@/test/render-intl'

/** A case-insensitive regex matching a catalog message literally. */
const literal = (text: string, flags = 'i', prefix = '') =>
  new RegExp(prefix + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)

const COVER: MediaRef = {
  id: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a',
  fileName: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a.jpg',
  width: 2400,
  height: 1600,
  altText: msg('Site.article.tableNumbered', { n: 'white with three boxes' }),
  dominantColor: '#5b6c7d',
}

const NEW_COVER: MediaRef = { ...COVER, id: 'b1', fileName: '7d6e5f40-1a2b-4c3d-8e9f-0a1b2c3d4e5f.jpg', altText: null }

type PanelPost = Pick<PostSummary, 'status' | 'cover'>
const published = (cover: MediaRef | null = null): PanelPost => ({ status: 'PUBLISHED', cover })
const draft = (cover: MediaRef | null = null): PanelPost => ({ status: 'DRAFT', cover })

const onUpload = vi.fn<(form: FormData) => Promise<CoverOutcome>>()
const onSaveAlt = vi.fn<(altText: string) => Promise<CoverOutcome>>()
const onRemove = vi.fn<() => Promise<CoverOutcome>>()

function renderPanel(post: PanelPost | null) {
  return render(<CoverPanel post={post} onUpload={onUpload} onSaveAlt={onSaveAlt} onRemove={onRemove} />)
}

const photo = (name = 'dien-thoai.jpg') => new File([new Uint8Array(64)], name, { type: 'image/jpeg' })

async function choose(file: File) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel')), { target: { files: [file] } })
  })
}

async function click(name: RegExp | string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

/** The `url` value that next/image's default loader writes into src: the original image path. */
const sourceOf = (img: HTMLElement) => new URL(img.getAttribute('src') ?? '', 'http://localhost').searchParams.get('url')

/** The `redirect()` error of an action reaching the client: the promise is rejected while the router navigates by itself. */
const redirectRejection = () => Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/login;307;' })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('CoverPanel', () => {
  it('renders nothing for an unsaved post: there is no post to attach an image to yet', () => {
    const { container } = renderPanel(null)

    expect(container).toBeEmptyDOMElement()
  })

  it('existing post: a cover image region with a file input that has NO name', () => {
    renderPanel(published())

    const region = screen.getByRole('region', { name: msg('Admin.editor.cover.heading') })
    const input = within(region).getByLabelText(msg('Admin.editor.cover.chooseLabel'))
    expect(input).toHaveAttribute('type', 'file')
    // No name: a file input with a name inside some form would send the image bytes with every
    // save of the post. The image only travels through its own action, after being downsized.
    expect(input).not.toHaveAttribute('name')
    // Positive counterpart: the input still accepts exactly the three formats the backend can read.
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp')
  })

  it('no cover image but the slug is known: shows the exact automatic cover art the public page draws (decorative)', () => {
    const { container } = render(
      <CoverPanel
        post={{ status: 'PUBLISHED', cover: null, slug: 'sample-post-05-cedar', category: null, series: null }}
        onUpload={onUpload}
        onSaveAlt={onSaveAlt}
        onRemove={onRemove}
      />,
    )

    const art = container.querySelector('svg.cover-art')
    expect(art).not.toBeNull()
    // Decorative: the sentence right below already says what it is, so there is no img role to announce.
    expect(art).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(literal(msg('Admin.editor.cover.none')))).toBeInTheDocument()
  })

  it('Ctrl/⌘+S in the description box is "Save description" (default prevented), not letting the page-wide shortcut save the post', async () => {
    onSaveAlt.mockResolvedValue({ cover: { ...COVER, altText: 'New description' } })
    renderPanel(published(COVER))
    const alt = screen.getByLabelText(msg('Admin.editor.cover.altLabel'))
    fireEvent.change(alt, { target: { value: 'New description' } })

    let notPrevented = true
    await act(async () => {
      notPrevented = fireEvent.keyDown(alt, { key: 's', ctrlKey: true })
    })

    // preventDefault: PostEditor ignores keys already handled by someone, so this is not a post save.
    expect(notPrevented).toBe(false)
    expect(onSaveAlt).toHaveBeenCalledWith('New description')
    expect(screen.getByRole('status')).toHaveTextContent(literal(msg('Admin.editor.cover.altSaved')))
  })

  it('Ctrl+S in the description box when there is no cover image: only blocks, calls no action', async () => {
    renderPanel(published())

    let notPrevented = true
    await act(async () => {
      notPrevented = fireEvent.keyDown(screen.getByLabelText(msg('Admin.editor.cover.altLabel')), { key: 's', ctrlKey: true })
    })

    expect(notPrevented).toBe(false)
    expect(onSaveAlt).not.toHaveBeenCalled()
  })

  it('no cover image: says so clearly, no remove or save-description button', () => {
    renderPanel(published())

    expect(screen.getByText(literal(msg('Admin.editor.cover.none')))).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button', { name: literal(msg('Admin.editor.cover.remove')) })).toBeNull()
    expect(screen.queryByRole('button', { name: literal(msg('Admin.editor.cover.saveAlt')) })).toBeNull()
    // Positive counterpart: upload is always there, and cannot be clicked until a file is chosen.
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.upload')) })).toBeDisabled()
  })

  it('has a cover image: preview via /media, current description in the box, remove and save-description buttons', () => {
    renderPanel(published(COVER))

    const preview = screen.getByRole('img', { name: msg('Admin.editor.cover.currentAlt') })
    expect(sourceOf(preview)).toBe(`/media/${COVER.fileName}`)
    expect(screen.getByLabelText(literal(msg('Admin.editor.cover.altLabel')))).toHaveValue(
      msg('Site.article.tableNumbered', { n: 'white with three boxes' }),
    )
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.remove')) })).toBeEnabled()
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.saveAlt')) })).toBeEnabled()
    expect(screen.queryByText(literal(msg('Admin.editor.cover.none')))).toBeNull()
  })

  it('choose a file then upload: downsized through prepareUpload first, then sends the DOWNSIZED FILE with the description', async () => {
    const original = photo('IMG_0001.jpg')
    const prepared = new File([new Uint8Array(16)], 'IMG_0001.jpg', { type: 'image/jpeg' })
    prepareUpload.mockResolvedValue(prepared)
    onUpload.mockResolvedValue({ cover: NEW_COVER })
    renderPanel(published())

    await choose(original)
    fireEvent.change(screen.getByLabelText(literal(msg('Admin.editor.cover.altLabel'))), {
      target: { value: msg('Site.gallery.photoName', { number: 'whiteboard shot' }) },
    })
    await click(literal(msg('Admin.editor.cover.upload')))

    expect(prepareUpload).toHaveBeenCalledWith(original)
    expect(onUpload).toHaveBeenCalledTimes(1)
    const form = onUpload.mock.calls[0][0]
    // The downsized copy, not the original: an 8 MB original dies at the 5 MiB limit of the Server
    // Action before the action even runs.
    expect(form.get('file')).toBe(prepared)
    expect(form.get('altText')).toBe(msg('Site.gallery.photoName', { number: 'whiteboard shot' }))
    expect(prepareUpload.mock.invocationCallOrder[0]).toBeLessThan(onUpload.mock.invocationCallOrder[0])
  })

  it('after uploading: shows the new image, has a remove button, reports success, the file input is empty again', async () => {
    prepareUpload.mockImplementation(async (file: File) => file)
    onUpload.mockResolvedValue({ cover: NEW_COVER })
    renderPanel(published())

    await choose(photo())
    await click(literal(msg('Admin.editor.cover.upload')))

    expect(sourceOf(screen.getByRole('img', { name: msg('Admin.editor.cover.currentAlt') }))).toBe(`/media/${NEW_COVER.fileName}`)
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.remove')) })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(literal(msg('Admin.editor.cover.uploaded')))
    // Without a new file chosen there is nothing to upload again: an accidental second click does not resend the old image.
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.upload')) })).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('prepareUpload rejects (HEIC, broken image) → in-place message, no action called', async () => {
    prepareUpload.mockRejectedValue(new UploadRejectedError(msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE')))
    renderPanel(published())

    await choose(new File([new Uint8Array(8)], 'IMG_0002.heic', { type: 'image/heic' }))
    await click(literal(msg('Admin.editor.cover.upload')))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.MEDIA_UNSUPPORTED_TYPE'))
    expect(onUpload).not.toHaveBeenCalled()
  })

  it('action returns {error} → shows exactly that message in role="alert"', async () => {
    prepareUpload.mockImplementation(async (file: File) => file)
    onUpload.mockResolvedValue({ error: msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED') })
    renderPanel(published())

    await choose(photo())
    await click(literal(msg('Admin.editor.cover.upload')))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.codes.MEDIA_QUOTA_EXCEEDED'))
    // On error the old image (here: no image) is still the right state, and the file remains so it can be retried.
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.upload')) })).toBeEnabled()
  })

  it('while an action is pending: every button and the file input are locked, unlocked when done', async () => {
    prepareUpload.mockImplementation(async (file: File) => file)
    let finish!: (outcome: CoverOutcome) => void
    onUpload.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderPanel(published(COVER))

    await choose(photo())
    await click(literal(msg('Admin.editor.cover.upload')))

    // Clicking twice on a slow network uploads two images, and the first one is deleted by the second.
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.upload')) })).toBeDisabled()
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.saveAlt')) })).toBeDisabled()
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.remove')) })).toBeDisabled()
    expect(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel'))).toBeDisabled()

    await act(async () => finish({ cover: NEW_COVER }))

    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.saveAlt')) })).toBeEnabled()
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.remove')) })).toBeEnabled()
    expect(screen.getByLabelText(msg('Admin.editor.cover.chooseLabel'))).toBeEnabled()
  })

  it('"Save description" sends the box content and shows the description the backend saved', async () => {
    onSaveAlt.mockResolvedValue({ cover: { ...COVER, altText: 'Trimmed description' } })
    renderPanel(published(COVER))

    fireEvent.change(screen.getByLabelText(literal(msg('Admin.editor.cover.altLabel'))), {
      target: { value: '  Trimmed description  ' },
    })
    await click(literal(msg('Admin.editor.cover.saveAlt')))

    expect(onSaveAlt).toHaveBeenCalledWith('  Trimmed description  ')
    expect(screen.getByLabelText(literal(msg('Admin.editor.cover.altLabel')))).toHaveValue('Trimmed description')
    expect(screen.getByRole('status')).toHaveTextContent(literal(msg('Admin.editor.cover.altSaved')))
  })

  it('"Remove cover image" calls the action and drops the preview when done', async () => {
    onRemove.mockResolvedValue({ cover: null })
    renderPanel(published(COVER))

    await click(literal(msg('Admin.editor.cover.remove')))

    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(literal(msg('Admin.editor.cover.none')))).toBeInTheDocument()
    expect(screen.getByLabelText(literal(msg('Admin.editor.cover.altLabel')))).toHaveValue('')
  })

  it('session expired (redirect action) is not shown as an error', async () => {
    onRemove.mockRejectedValue(redirectRejection())
    renderPanel(published(COVER))

    await click(literal(msg('Admin.editor.cover.remove')))

    // The router is navigating to /admin/login by itself; a NEXT_REDIRECT "error" on screen would be wrong.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('action rejected for another reason (network to Next dropped) → there is still a message, never silent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    onSaveAlt.mockRejectedValue(new TypeError('Failed to fetch'))
    renderPanel(published(COVER))

    await click(literal(msg('Admin.editor.cover.saveAlt')))

    expect(screen.getByRole('alert')).toHaveTextContent(msg('Errors.admin.unreachable'))
    expect(screen.getByRole('button', { name: literal(msg('Admin.editor.cover.saveAlt')) })).toBeEnabled()
  })

  it('unpublished post: the image note says it is only hidden from the site, not private', () => {
    renderPanel(draft(COVER))

    // Images are served publicly by UUID: a draft's cover image does not appear anywhere on the site,
    // but anyone with the /media/… path can still open it.
    expect(screen.getByText(literal(msg('Admin.editor.cover.draftNote')))).toBeInTheDocument()
  })

  it('published post: no such note, because the cover image is shown on the page', () => {
    renderPanel(published(COVER))

    expect(screen.queryByText(literal(msg('Admin.editor.cover.draftNote')))).toBeNull()
    // Positive counterpart: the region still renders all the rest.
    expect(screen.getByRole('region', { name: msg('Admin.editor.cover.heading') })).toBeInTheDocument()
  })

  it('tells the author when the current cover is narrower than the frame it is shown in, and stays quiet for a large one', () => {
    const { unmount } = renderPanel(published({ ...COVER, width: 275, height: 183 }))
    expect(screen.getByRole('note')).toHaveTextContent(
      msg('Admin.editor.cover.lowResolution', { width: 275, min: COVER_MIN_WIDTH, recommended: COVER_RECOMMENDED_WIDTH }),
    )
    unmount()

    renderPanel(published(COVER))
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('names the recommended width next to the file box', () => {
    renderPanel(published())

    expect(
      screen.getByText(msg('Admin.editor.cover.fileHint', { min: COVER_MIN_WIDTH, recommended: COVER_RECOMMENDED_WIDTH })),
    ).toBeInTheDocument()
  })
})
