import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Backend } from '../support/backend'
import { escapeRegExp } from '../support/admin'
import { expect, test } from '../support/fixtures'
import { E2E_LOCALE, msg } from '../support/i18n'
import { readZipEntries } from '../support/zip'

/**
 * The post import (/admin/posts/import): from the posts list to the page, upload one file that brings a NEW category and a NEW tag,
 * read the preview (a new post, the names that will be created, nothing written yet), confirm, find the imported DRAFT in the posts
 * list, open it in the editor and download its ZIP package, whose article carries the slug and the language, then upload that package
 * again: the preview calls it unchanged. Only the main journey: every edge
 * case (errors, updates, translations, undo) lives at the lower seams. Desktop only: nothing here depends on the viewport.
 *
 * The test leaves the site as it found it: the imported post is deleted at the end, then the category and the tag the import created
 * (the import itself never deletes them), also when the run fails half way. An imported post is a draft, so no public page or cache
 * ever shows it.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the journey does not depend on the viewport')
})

const P = 'Admin.posts.import'

/** Delete what the journey created, ignoring case: the post first (a category in use cannot be deleted), then the category and the tag. */
async function removeCreated(backend: Backend, title: string, categoryName: string, tagName: string): Promise<void> {
  for (const post of (await backend.adminPosts()).filter((candidate) => candidate.title === title)) {
    await backend.deletePost(post.id)
  }
  for (const category of await backend.adminCategories()) {
    if (category.name.toLowerCase() === categoryName.toLowerCase()) await backend.deleteCategory(category.id)
  }
  for (const tag of await backend.adminTags()) {
    if (tag.name.toLowerCase() === tagName.toLowerCase()) await backend.deleteTag(tag.id)
  }
}

test('upload a post file with a new category and tag, preview, confirm, open the draft and download its file', async ({
  adminPage: page,
  backend,
}) => {
  test.setTimeout(180_000)
  const marker = `${Date.now()}-${randomUUID().slice(0, 6)}`
  const title = `E2E import ${marker}`
  const slug = `e2e-import-${marker}`
  const fileName = `${slug}.md`
  const packageName = `${slug}.zip`
  const description = `Imported by the E2E suite (${marker}); deleted when the test ends.`
  const categoryName = `E2E import category ${marker}`
  const tagName = `e2e import tag ${marker}`
  const file = [
    '---',
    `title: ${title}`,
    `slug: ${slug}`,
    `language: ${E2E_LOCALE}`,
    `excerpt: ${description}`,
    `category: ${categoryName}`,
    `tags: ${tagName}`,
    '---',
    '',
    '## First section',
    '',
    `A paragraph of the post imported by the E2E suite (${marker}).`,
    '',
  ].join('\n')

  try {
    // From the posts list: the "Import posts" link of the page header (or of the empty state), not the "Write a post" button.
    await page.goto('/admin')
    await page
      .getByRole('main')
      .getByRole('link', {
        name: new RegExp(`^(${escapeRegExp(msg(`${P}.entry.header`))}|${escapeRegExp(msg(`${P}.entry.empty`))})$`),
      })
      .click()
    await expect(page).toHaveURL(/\/admin\/posts\/import$/)
    await expect(page.getByRole('heading', { level: 1, name: msg(`${P}.page.title`) })).toBeVisible()

    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: fileName, mimeType: 'text/markdown', buffer: Buffer.from(file, 'utf8') })

    // The preview: one new post, ticked, with the names that will be created. Nothing is written yet.
    await expect(page.getByRole('status').filter({ hasText: msg(`${P}.status.previewReady`) })).toBeVisible()
    // The card is the list item that holds the file's own checkbox: the change and note lines inside it are list items too.
    const selectBox = page.getByRole('checkbox', { name: msg(`${P}.preview.select`, { name: fileName }), exact: true })
    const card = page
      .getByRole('list', { name: msg(`${P}.preview.listLabel`) })
      .getByRole('listitem')
      .filter({ has: selectBox })
    await expect(card).toHaveCount(1)
    await expect(card).toContainText(msg(`${P}.preview.state.new`))
    await expect(card).toContainText(msg(`${P}.preview.slug`, { slug }))
    await expect(card).toContainText(msg(`${P}.preview.newCategories`, { names: categoryName }))
    await expect(card).toContainText(msg(`${P}.preview.newTags`, { names: tagName }))
    await expect(selectBox).toBeChecked()
    expect((await backend.adminPosts()).some((post) => post.title === title)).toBe(false)
    expect((await backend.adminCategories()).some((category) => category.name === categoryName)).toBe(false)

    // Confirm: the result says "created as a draft" and links to the post's editor.
    await page.getByRole('button', { name: msg(`${P}.preview.apply`, { count: 1 }), exact: true }).click()
    await expect(page.getByRole('heading', { name: msg(`${P}.result.heading`), exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: msg(`${P}.status.applied`) })).toBeVisible()
    await expect(page.getByText(msg(`${P}.result.file`, { name: fileName, status: 'created' }), { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: msg(`${P}.result.openFor`, { name: fileName }), exact: true })).toBeVisible()

    // The backend has one DRAFT, with the new category and the new tag attached, and the language of the file.
    const stored = (await backend.adminPosts()).filter((post) => post.title === title)
    expect(stored).toHaveLength(1)
    const [post] = stored
    expect(post.status).toBe('DRAFT')
    expect(post.slug).toBe(slug)
    expect(post.category?.name).toBe(categoryName)
    expect(post.tags.map((tag) => tag.name)).toEqual([tagName])

    // The posts list shows the draft under the "Draft" filter, and its title opens the editor.
    await page.goto(`/admin?status=draft&q=${encodeURIComponent(marker)}`)
    const row = page.getByRole('link', { name: title, exact: true })
    await expect(row).toHaveAttribute('href', `/admin/posts/${post.id}/edit`)
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${post.id}/edit$`))
    await expect(page.getByLabel(msg('Admin.editor.titleLabel'), { exact: true })).toHaveValue(title)
    await expect(page.getByLabel(msg('Admin.editor.slugLabel'), { exact: true })).toHaveValue(slug)

    // Download its package: the editor's "Download ZIP" is named after the slug, and its article.md carries the keys the import reads,
    // so the package can be imported again.
    const downloading = page.waitForEvent('download')
    await page.getByRole('link', { name: msg('Admin.editor.download'), exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(packageName)
    const packageBytes = await readFile(await download.path())
    const text = readZipEntries(packageBytes).get('article.md')?.toString('utf8') ?? ''
    expect(text.startsWith('---\n')).toBe(true)
    for (const line of [
      `title: ${title}`,
      `slug: ${slug}`,
      `language: ${E2E_LOCALE}`,
      `category: ${categoryName}`,
      `tags: ${tagName}`,
      'status: DRAFT',
    ]) {
      expect(text.split('\n')).toContain(line)
    }
    expect(text).toContain(`A paragraph of the post imported by the E2E suite (${marker}).`)

    // The downloaded package is the post as it is stored: importing it again changes nothing, so its card says "unchanged" and cannot be ticked.
    await page.goto('/admin/posts/import')
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: packageName, mimeType: 'application/zip', buffer: packageBytes })
    await expect(page.getByRole('status').filter({ hasText: msg(`${P}.status.previewReady`) })).toBeVisible()
    const packageBox = page.getByRole('checkbox', { name: msg(`${P}.preview.select`, { name: packageName }), exact: true })
    const again = page
      .getByRole('list', { name: msg(`${P}.preview.listLabel`) })
      .getByRole('listitem')
      .filter({ has: packageBox })
    await expect(again).toHaveCount(1)
    await expect(again).toContainText(msg(`${P}.preview.state.unchanged`))
    await expect(packageBox).toBeDisabled()
    await expect(packageBox).not.toBeChecked()
  } finally {
    await removeCreated(backend, title, categoryName, tagName)
  }
})
