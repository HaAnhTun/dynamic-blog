import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import type { Page } from '@playwright/test'
import type { Backend } from '../support/backend'
import { expect, test } from '../support/fixtures'
import { msg } from '../support/i18n'
import { msgAtTime, msgStart } from '../support/admin'
import { waitForHydration } from '../support/page'
import { readZipEntries } from '../support/zip'

/**
 * Post editor: inline body images, local draft, ZIP download and duplicate,
 * history. Each test uses a temporary DRAFT created directly through the API (a draft is in no public
 * cache) and deletes it at the end; deleting a post also deletes its body images and history (CASCADE foreign key).
 *
 * Body images and history need a backend with two new route groups (`/admin/posts/{id}/images`,
 * `/revisions`); the local draft, ZIP download and duplicate do not.
 */

/** The editor's status line: the first status region of the page (top bar). */
const saveState = (page: Page) => page.getByRole('status').first()

/** A small PNG diagram, generated on the spot: no image file committed to the repo (as in e2e/support/photos.ts). */
function diagramPng(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 360, channels: 3, background: '#3d7a5a' } })
    .png()
    .toBuffer()
}

async function removeDrafts(backend: Backend, titlePrefix: string): Promise<void> {
  for (const post of (await backend.adminPosts()).filter((p) => p.title.startsWith(titlePrefix))) {
    await backend.deletePost(post.id)
  }
}

test('"Insert image": uploads, inserts at the cursor, is served at /media, saved with the post, can be deleted', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(120_000)
  const title = `Image post E2E ${testInfo.project.name} ${Date.now()}`
  const draft = await backend.createDraftPost({ title, content: 'Opening paragraph.\n\nClosing paragraph.' })

  try {
    await page.goto(`/admin/posts/${draft.id}/edit`)
    const content = page.getByLabel(msg('Admin.editor.contentLabel'))
    // Hydration first: it can reset the caret of the box, and the image would land at the top instead of at the cursor.
    await waitForHydration(content)
    // The cursor is right after the first paragraph: the image must land exactly there, as its own paragraph.
    await content.evaluate((node: HTMLTextAreaElement) => {
      node.focus()
      node.setSelectionRange('Opening paragraph.'.length, 'Opening paragraph.'.length)
    })

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: msg('Admin.editor.insertImage') }).click()
    await (await chooser).setFiles({ name: 'so-do-e2e.png', mimeType: 'image/png', buffer: await diagramPng() })
    await expect(page.getByText(msg('Admin.postImages.insertedOne'))).toBeVisible({ timeout: 60_000 })

    const value = await content.inputValue()
    // With a size hint #<width>x<height>: the post page reads it as the <img> width/height.
    const inserted =
      /^Opening paragraph\.\n\n!\[so do e2e\]\(\/media\/([0-9a-f-]{36}\.png)#(\d+)x(\d+)\)\n\nClosing paragraph\.$/.exec(value)
    expect(inserted, value).not.toBeNull()
    const fileName = inserted![1]
    const [width, height] = [inserted![2], inserted![3]]
    await expect(saveState(page)).toHaveText(msg('Admin.editor.state.unsaved'))

    // The image is served same-origin, and appears in "Images in the post".
    const media = await page.request.get(`/media/${fileName}`)
    expect(media.status()).toBe(200)
    expect(media.headers()['content-type']).toBe('image/png')
    const panel = page.getByRole('region', { name: msg('Admin.postImages.heading') })
    await expect(panel.getByText('so do e2e', { exact: true })).toBeVisible()

    // Save: the saved version (read through the legacy Markdown export, `?format=md`) has the image.
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveState(page)).toHaveText(msgStart('Admin.editor.state.savedAt'))
    const exported = await page.request.get(`/admin/posts/${draft.id}/export?format=md`)
    expect(await exported.text()).toContain(`![so do e2e](/media/${fileName}#${width}x${height})`)

    // The preview builds the body like the public page (ArticleView): the hint becomes width/height, src is clean.
    const preview = await page.context().newPage()
    await preview.goto(`/admin/posts/${draft.id}/preview`)
    const shown = preview.locator(`img[src="/media/${fileName}"]`)
    await expect(shown).toHaveAttribute('width', width)
    await expect(shown).toHaveAttribute('height', height)
    await preview.close()

    // Delete the image through the confirmation step: the content using it is named in the prompt; once deleted, the image URL is 404.
    await panel.getByRole('button', { name: msg('Admin.postImages.deleteAria', { label: 'so do e2e' }) }).click()
    const prompt = panel.getByRole('group', { name: msg('Admin.postImages.deleteQuestion', { label: 'so do e2e' }) })
    await expect(prompt).toContainText(msg('Admin.postImages.deleteDetailsInUse'))
    await prompt.getByRole('button', { name: msg('Admin.posts.delete.forever') }).click()
    await expect(panel.getByText('so do e2e', { exact: true })).toHaveCount(0)
    expect((await page.request.get(`/media/${fileName}`)).status()).toBe(404)
  } finally {
    await backend.deletePost(draft.id)
  }
})

test('local draft: reloading the tab with unsaved text restores it; after saving, the draft disappears', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  const draft = await backend.createDraftPost({
    title: `Local draft post E2E ${testInfo.project.name} ${Date.now()}`,
    content: 'Saved text.',
  })
  // The key carries the signed-in account (bai-viet:nhap:<userId>:<postId>), so the test finds it by the post id.
  const stored = () =>
    page.evaluate((postId) => {
      const key = Object.keys(window.localStorage).find((k) => k.startsWith('bai-viet:nhap:') && k.endsWith(`:${postId}`))
      return key === undefined ? null : window.localStorage.getItem(key)
    }, draft.id)

  try {
    await page.goto(`/admin/posts/${draft.id}/edit`)
    const content = page.getByLabel(msg('Admin.editor.contentLabel'))
    // Hydration first: a value filled before it is replayed over the saved text (on a slow start the box ended with the draft followed by
    // "Saved text.", and the draft offered after the reload was that mixed text).
    await waitForHydration(content)
    await content.fill('Saved text.\n\nHalf-written paragraph, not saved.')
    await expect(saveState(page)).toHaveText(msg('Admin.editor.state.unsaved'))
    // Written one second after the last keystroke, under the account that typed it.
    await expect.poll(stored).not.toBeNull()
    expect(JSON.parse((await stored())!)).toMatchObject({ v: 2, owner: expect.stringMatching(/^[0-9a-f-]{36}$/) })

    // Reload the tab: the browser asks "leave the page?" (unsaved changes), the writer agrees.
    page.once('dialog', (dialog) => void dialog.accept())
    await page.reload()

    const offer = page.getByRole('group', { name: msgAtTime('Admin.editor.draftOffer', false) })
    await expect(offer).toBeVisible()
    await expect(content).toHaveValue('Saved text.')
    await offer.getByRole('button', { name: msg('Admin.revisions.restore') }).click()
    await expect(content).toHaveValue('Saved text.\n\nHalf-written paragraph, not saved.')
    await expect(saveState(page)).toHaveText(msg('Admin.editor.state.unsaved'))

    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveState(page)).toHaveText(msgStart('Admin.editor.state.savedAt'))
    await expect.poll(stored).toBeNull()
  } finally {
    await backend.deletePost(draft.id)
  }
})

test('"Download ZIP" downloads the saved version as a post package; "Duplicate" opens a new draft', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  const title = `Export post E2E ${testInfo.project.name} ${Date.now()}`
  const draft = await backend.createDraftPost({
    title,
    content: '## Section\n\nParagraph.',
    excerpt: 'Short description of the export post E2E.',
  })

  try {
    await page.goto(`/admin/posts/${draft.id}/edit`)

    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: msg('Admin.editor.download') }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe(`${draft.slug}.zip`)
    // The package the post import reads: the article at the root of the ZIP.
    const entries = readZipEntries(readFileSync(await file.path()))
    expect([...entries.keys()]).toContain('article.md')
    const text = entries.get('article.md')!.toString('utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain(`\ntitle: ${title}\n`)
    expect(text).toContain('\nexcerpt: Short description of the export post E2E.\n')
    expect(text).toContain('\nstatus: DRAFT\n')
    expect(text.endsWith('\n---\n\n## Section\n\nParagraph.\n')).toBe(true)

    await page.getByRole('button', { name: msg('Admin.editor.duplicate') }).click()
    await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]{36}\/edit$/)
    await expect(page).not.toHaveURL(new RegExp(draft.id))
    await expect(page.getByLabel(msg('Admin.editor.titleLabel'))).toHaveValue(`${title} ${msg('Admin.posts.actions.copySuffix')}`)
    await expect(page.getByLabel(msg('Admin.editor.contentLabel'))).toHaveValue('## Section\n\nParagraph.')
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.posts.preview.edit') })).toBeVisible()
  } finally {
    await removeDrafts(backend, title)
  }
})

test('history: saving a change keeps the previous version; restoring it goes through a confirmation step', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(90_000)
  const draft = await backend.createDraftPost({
    title: `History post E2E ${testInfo.project.name} ${Date.now()}`,
    content: 'First version.',
  })

  try {
    await page.goto(`/admin/posts/${draft.id}/edit`)
    const content = page.getByLabel(msg('Admin.editor.contentLabel'))
    // Hydration first, for the same reason as the local draft case: a value filled before it is replayed over the saved text.
    await waitForHydration(content)
    await content.fill('Second version.')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveState(page)).toHaveText(msgStart('Admin.editor.state.savedAt'))

    // After saving the page is rebuilt (updateTag): the pre-save version is already in the history.
    const history = page.getByRole('region', { name: msg('Admin.revisions.heading') })
    const view = history.getByRole('button', { name: msgStart('Admin.revisions.viewAria') }).first()
    await expect(view).toBeVisible()
    await view.click()
    await expect(history.getByRole('region', { name: msgStart('Admin.revisions.textRegionAria') })).toHaveText('First version.')

    await history.getByRole('button', { name: msg('Admin.revisions.restoreThis') }).click()
    const prompt = history.getByRole('group', { name: msgStart('Admin.revisions.restoreQuestion') })
    await expect(prompt.getByRole('button', { name: msg('Admin.posts.delete.cancel') })).toBeFocused()
    await prompt.getByRole('button', { name: msg('Admin.revisions.restore') }).click()

    await expect(page).toHaveURL(new RegExp(`/admin/posts/${draft.id}/edit\\?restored=`))
    await expect(content).toHaveValue('First version.')
    await expect(saveState(page)).toHaveText(msg('Admin.editor.restoredNotice'))
  } finally {
    await backend.deletePost(draft.id)
  }
})
