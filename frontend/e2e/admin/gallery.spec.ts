import type { Page } from '@playwright/test'
import { deleteFromGallery, uploadToGallery } from '../support/admin'
import type { Backend } from '../support/backend'
import { expect, test } from '../support/fixtures'
import { naturalSize } from '../support/page'
import { exifTakenOn, markerAtTopLeft, phonePhoto, usesGeneratedPhoto } from '../support/photos'
import { msg } from '../support/i18n'

/** Delete the temporary photo: through the UI (so /gallery refreshes its cache), the API only when the UI cannot. */
async function removeTemporary(page: Page, backend: Backend, altText: string): Promise<void> {
  const left = (await backend.adminGallery()).filter((photo) => photo.image.altText === altText)
  if (left.length === 0) return
  try {
    await deleteFromGallery(page, altText)
  } catch {
    for (const photo of left) await backend.deleteGalleryPhoto(photo.id)
  }
}

test('portrait phone photo in the gallery: first on /gallery, right orientation, can be opened, can be deleted', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(120_000)
  const altText = `Photo E2E ${testInfo.project.name} ${Date.now()}`
  const caption = 'QA - temporary E2E photo, deleted at the end of the test'
  const shownBefore = (await backend.gallery()).length

  try {
    await uploadToGallery(page, [await phonePhoto()], [{ altText, caption }])
    // The new photo is first in the admin list immediately, no page reload needed.
    const rows = page.getByRole('list', { name: msg('Admin.gallery.manager.orderLabel') }).locator(':scope > li')
    await expect(rows.first().getByRole('img')).toHaveAttribute('alt', altText)

    const created = (await backend.adminGallery()).find((photo) => photo.image.altText === altText)!
    expect(created.published).toBe(true)
    expect(created.image.height, `${created.image.width}×${created.image.height}`).toBeGreaterThan(created.image.width)
    if (usesGeneratedPhoto) {
      const stored = await page.request.get(`/media/${created.image.fileName}`)
      expect(await markerAtTopLeft(await stored.body()), 'rotated the right way, not only "portrait"').toBe(true)
    }

    // Public page: the first cell is the photo just uploaded, the downloaded photo stands upright, the counter goes up by one.
    await page.goto('/gallery')
    await expect(page.getByText(msg('Site.gallery.count', { count: shownBefore + 1 }), { exact: true })).toBeVisible()
    const first = page.locator('a[data-gallery-index="0"]')
    await expect(first.getByRole('img')).toHaveAttribute('alt', altText)
    const size = await naturalSize(first.getByRole('img'))
    expect(size.height, `${size.width}×${size.height}`).toBeGreaterThan(size.width)

    await first.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('figcaption')).toContainText(caption)
    const large = await naturalSize(dialog.getByRole('img'))
    expect(large.height).toBeGreaterThan(large.width)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Delete through the in-place confirmation step: gone from the backend and from the public page.
    await deleteFromGallery(page, altText)
    expect((await backend.adminGallery()).some((photo) => photo.id === created.id)).toBe(false)
    await page.goto('/gallery')
    // With no photo at all (fresh stack, no gallery photos yet) the page shows the empty message, with no "0 photos" counter.
    await expect(
      shownBefore === 0
        ? page.getByText(msg('Admin.gallery.manager.emptyTitle'), { exact: true })
        : page.getByText(msg('Site.gallery.count', { count: shownBefore }), { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('img', { name: altText })).toHaveCount(0)
  } finally {
    await removeTemporary(page, backend, altText)
  }
})

// This used to be the FINDING "capture date lost when downsizing in the browser": a photo > 4 MB or with a side > 2400px (so almost
// every photo taken straight from a phone) was redrawn through a canvas by lib/prepare-upload.ts before sending,
// and the new JPEG no longer has EXIF, so the backend could not read DateTimeOriginal: takenOn = null, contrary to the
// hint right under the date field. Now GalleryUploader reads DateTimeOriginal from the ORIGINAL file (lib/exif-date.ts)
// and sends it as takenOn when the date field is empty; this test keeps the form's promise true all the way to the backend.
test('"Date taken" left empty: takes the capture date recorded in the photo, as the form promises', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(120_000)
  const photo = await phonePhoto()
  const taken = await exifTakenOn(photo)
  test.skip(taken === null, 'the test photo has no EXIF DateTimeOriginal')
  const altText = `Photo E2E capture date ${testInfo.project.name} ${Date.now()}`

  try {
    await page.goto('/admin/gallery')
    const uploader = page.getByRole('region', { name: msg('Admin.gallery.uploader.heading') })
    await uploader.getByLabel(msg('Admin.gallery.uploader.choose')).setInputFiles(photo)
    const queued = uploader
      .getByRole('list', { name: msg('Admin.gallery.uploader.queueLabel') })
      .getByRole('listitem')
      .first()
    // The form's promise, right under the empty date field.
    await expect(queued.getByLabel(msg('Admin.gallery.fields.dateLabel'))).toHaveValue('')
    await expect(queued.getByLabel(msg('Admin.gallery.fields.dateLabel'))).toHaveAccessibleDescription(
      msg('Admin.gallery.uploader.dateHint'),
    )
    await queued.getByLabel(msg('Admin.gallery.fields.altLabel')).fill(altText)
    await uploader.getByRole('button', { name: msg('Admin.gallery.uploader.upload'), exact: true }).click()
    await expect(uploader.getByRole('status')).toHaveText(msg('Admin.gallery.uploader.done', { uploaded: '1', total: '1' }), {
      timeout: 60_000,
    })

    const created = (await backend.adminGallery()).find((item) => item.image.altText === altText)!
    expect(created.takenOn, `photo records DateTimeOriginal ${taken}`).toBe(taken)
  } finally {
    await removeTemporary(page, backend, altText)
  }
})
