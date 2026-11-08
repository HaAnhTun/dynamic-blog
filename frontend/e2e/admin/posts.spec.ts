import type { Page } from '@playwright/test'
import type { Backend } from '../support/backend'
import { expect, test } from '../support/fixtures'
import { msg, localePath } from '../support/i18n'
import { msgAtTime, msgStart } from '../support/admin'

/**
 * Lifecycle of a post through the editor, checked in all three places: the admin UI, the backend, the public pages. The post
 * is a temporary one (the title carries the project name and the time), unpublished and then DELETED THROUGH THE UI at the end of the test, so the shared
 * stack keeps no stray post and the public page cache no longer points at it.
 *
 * Includes the "cache consistency" part: on publish the post shows immediately on the post page, the search
 * results, the category page, the tag page, the feed and the sitemap; on unpublish it disappears from all of them immediately —
 * without waiting out the 60-300 second cache. Search results used to be a gap (nobody invalidated the 'search' tag).
 *
 * The post's tag is a NEW tag, created right in the editor, so only this draft carries it. An
 * unpublished topic must not leak: the tag page is 404 and the sitemap lacks it until the post is published (it opens immediately,
 * thanks to `updateTag('tags')`), then closes again as soon as the post is unpublished. The tag is deleted at the end of the test.
 *
 * Between publish and unpublish the post's path changes. The old link returns 308 to the new link (the backend remembers the old slug of a
 * published post, the post page redirects); once the post is unpublished the old link is 404 too, never redirecting to a draft.
 */

/** The editor's status line ("Saved", "Unsaved changes", "Published at …"): the first
 *  status region of the page, on the top bar, before the cover image field. */
const saveState = (page: Page) => page.getByRole('status').first()

/** Safety net: a temporary post still published is unpublished through the UI (so the public cache refreshes), then deleted via the API. */
async function removeTemporary(page: Page, backend: Backend, title: string): Promise<void> {
  const left = (await backend.adminPosts()).filter((post) => post.title === title)
  for (const post of left) {
    if (post.status === 'PUBLISHED') {
      try {
        await page.goto(`/admin/posts/${post.id}/edit`)
        await page.getByRole('button', { name: msg('Admin.posts.row.unpublish') }).click()
        await expect(saveState(page)).toHaveText(msgStart('Admin.editor.state.unpublishedAt'))
      } catch {
        // If unpublishing through the UI fails, still delete: a stray post on the stack is worse than five minutes of stale cache.
      }
    }
    await backend.deletePost(post.id)
  }
}

/** Whether the public page at `path` has a link to the post (page just loaded, no browser cache). */
async function listsPost(page: Page, path: string, slug: string): Promise<boolean> {
  await page.goto(localePath(path))
  return (await page.locator(`main a[href="${localePath(`/posts/${slug}`)}"]`).count()) > 0
}

async function bodyOf(page: Page, path: string): Promise<string> {
  const response = await page.request.get(path)
  expect(response.status(), path).toBe(200)
  return response.text()
}

test('write a new post → save → edit (Ctrl/⌘+S) → publish → change the path (308) → unpublish → delete: admin, backend and every public page follow each step', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(180_000)
  const marker = String(Date.now())
  const title = `E2E post ${testInfo.project.name} ${marker}`
  const tagName = `draft tag e2e ${testInfo.project.name} ${marker}`
  const stored = async () => (await backend.adminPosts()).find((post) => post.title === title) ?? null

  try {
    // From the post list: the page's main "Write a post" button (not the sidebar entry).
    await page.goto('/admin')
    await page
      .getByRole('main')
      .getByRole('link', { name: msg('Admin.shell.newPost'), exact: true })
      .click()
    await expect(page).toHaveURL(/\/admin\/posts\/new$/)
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.editor.titleNew') })).toBeVisible()
    // Full-screen writing desk: no sidebar.
    await expect(page.getByRole('navigation', { name: msg('Admin.shell.navLabel'), includeHidden: true })).toHaveCount(0)

    await page.getByLabel(msg('Admin.editor.titleLabel')).fill(title)
    await expect(page.getByLabel(msg('Admin.editor.slugLabel'), { exact: true })).toHaveValue(/^e2e-post-/)
    await page
      .getByLabel(msg('Admin.editor.excerptLabel'))
      .fill('Temporary post of the E2E suite; deleted at the end of the test.')
    await page.getByLabel(msg('Admin.editor.contentLabel')).fill(`## Section one\n\nFirst paragraph of the E2E post ${marker}.\n`)
    const category = page.getByLabel(msg('Admin.editor.categoryLabel'))
    const firstCategory = (await category.locator('option').nth(1).textContent())?.trim()
    expect(firstCategory, 'needs at least one category to publish').toBeTruthy()
    await category.selectOption({ label: firstCategory! })
    const firstCategoryId = await category.locator('option').nth(1).getAttribute('value')
    // A new tag, created right in the editor (selected once created), to check the public tag page at
    // every step: only this draft carries it.
    const tagGroup = page.getByRole('group', { name: msg('Admin.editor.tagsLegend') })
    await tagGroup.getByRole('button', { name: msg('Admin.editor.addTag') }).click()
    await tagGroup.getByLabel(msg('Admin.editor.tagName'), { exact: true }).fill(tagName)
    await tagGroup.getByRole('button', { name: msg('Admin.editor.inlineCreate.add'), exact: true }).click()
    await expect(tagGroup.locator('label', { hasText: tagName }).locator('input[type="checkbox"]')).toBeChecked()
    await page.getByRole('button', { name: msg('Admin.editor.save'), exact: true }).click()

    // The first save creates the post and moves to its own edit page.
    await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]{36}\/edit$/)
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.posts.preview.edit') })).toBeVisible()
    await expect(saveState(page)).toHaveText(msg('Admin.editor.state.saved'))
    const draft = await stored()
    expect(draft?.status).toBe('DRAFT')
    // By id: the label of the editor is the name in one language, the API returns the name in the post's language.
    expect(draft?.category?.id).toBe(firstCategoryId)
    expect(draft?.tags).toHaveLength(1)
    expect(draft?.tags[0]?.name).toBe(tagName)
    const { id, slug } = draft!
    const categorySlug = draft!.category!.slug
    const tagSlug = draft!.tags[0]!.slug
    const tagLoc = `/tags/${tagSlug}</loc>`

    // Edit: the status line reports unsaved changes; Ctrl/⌘+S saves without touching the mouse.
    await page
      .getByLabel(msg('Admin.editor.excerptLabel'))
      .fill('Temporary post of the E2E suite, edited; deleted at the end of the test.')
    await expect(saveState(page)).toHaveText(msg('Admin.editor.state.unsaved'))
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveState(page)).toHaveText(msgAtTime('Admin.editor.state.savedAt'))
    await expect
      .poll(async () => (await stored())?.excerpt)
      .toBe('Temporary post of the E2E suite, edited; deleted at the end of the test.')

    // The draft leaks nowhere, including the tag only it carries: the name of the unpublished topic is on no
    // page, in the sitemap or in the public API.
    expect((await page.goto(localePath(`/posts/${slug}`)))?.status()).toBe(404)
    expect(await listsPost(page, `/search?q=${marker}`, slug)).toBe(false)
    expect((await page.goto(localePath(`/tags/${tagSlug}`)))?.status(), 'tag page of a draft-only tag').toBe(404)
    expect(await bodyOf(page, '/sitemap.xml'), 'sitemap while the tag only has a draft').not.toContain(tagLoc)

    // Publish: the status changes, there is a view link on the blog.
    await page.goto(`/admin/posts/${id}/edit`)
    await page.getByRole('button', { name: msg('Admin.posts.row.publish'), exact: true }).click()
    await expect(saveState(page)).toHaveText(msgStart('Admin.editor.state.publishedAt'))
    await expect(page.getByRole('link', { name: msg('Admin.posts.preview.viewOnBlog') })).toHaveAttribute(
      'href',
      `/posts/${slug}`,
    )
    await expect.poll(async () => (await stored())?.status).toBe('PUBLISHED')

    // ...and every public page sees the post IMMEDIATELY (updateTag), without waiting for the cache to expire.
    await page.goto(localePath(`/posts/${slug}`))
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByText('Temporary post of the E2E suite, edited; deleted at the end of the test.')).toBeVisible()
    expect(await listsPost(page, `/search?q=${marker}`, slug), 'search').toBe(true)
    expect(await listsPost(page, `/categories/${categorySlug}`, slug), 'category page').toBe(true)
    expect(await listsPost(page, `/tags/${tagSlug}`, slug), 'tag page').toBe(true)
    expect(await bodyOf(page, localePath('/feed.xml')), 'feed').toContain(`/posts/${slug}`)
    const sitemapPublished = await bodyOf(page, '/sitemap.xml')
    expect(sitemapPublished, 'sitemap').toContain(`/posts/${slug}`)
    expect(sitemapPublished, 'sitemap has the tag that just got its first post').toContain(tagLoc)

    // Change the path of the PUBLISHED post: the hint under the field says the old link redirects by itself; after saving, the old link
    // returns 308 to the new link immediately (updateTag), and the new link is the post page. The post has a changed slug from here on: later
    // steps check against `renamed`.
    const renamed = `${slug}-doi-ten`
    await page.goto(`/admin/posts/${id}/edit`)
    await expect(page.getByText(msg('Admin.editor.slugHintPublished'))).toBeVisible()
    await page.getByLabel(msg('Admin.editor.slugLabel'), { exact: true }).fill(renamed)
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveState(page)).toHaveText(msgAtTime('Admin.editor.state.savedAt'))
    await expect.poll(async () => (await stored())?.slug).toBe(renamed)
    // Do not follow the redirect: the status and the target are what must be seen. 308, not 307: shared links and
    // search ranking move wholesale to the new URL.
    const moved = await page.request.get(localePath(`/posts/${slug}`), { maxRedirects: 0 })
    expect(moved.status(), 'old link after the path change').toBe(308)
    expect(moved.headers()['location'], 'target of the old link').toMatch(new RegExp(`/posts/${renamed}$`))
    // The browser follows the redirect to the right post.
    await page.goto(localePath(`/posts/${slug}`))
    await expect(page).toHaveURL(new RegExp(`/posts/${renamed}$`))
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    // The sitemap has only the new URL: `</loc>` right after the slug, because the old slug is a prefix of the new one.
    const sitemapRenamed = await bodyOf(page, '/sitemap.xml')
    expect(sitemapRenamed, 'sitemap has the new URL').toContain(`/posts/${renamed}</loc>`)
    expect(sitemapRenamed, 'sitemap no longer has the old URL').not.toContain(`/posts/${slug}</loc>`)

    // Unpublish: back to a draft, and gone from every place immediately — including the old link, which stops redirecting to a draft.
    await page.goto(`/admin/posts/${id}/edit`)
    await page.getByRole('button', { name: msg('Admin.posts.row.unpublish') }).click()
    await expect(saveState(page)).toHaveText(msgStart('Admin.editor.state.unpublishedAt'))
    await expect(page.getByRole('button', { name: msg('Admin.posts.row.publish'), exact: true })).toBeVisible()
    await expect.poll(async () => (await stored())?.status).toBe('DRAFT')
    expect((await page.goto(localePath(`/posts/${renamed}`)))?.status()).toBe(404)
    expect(
      (await page.request.get(localePath(`/posts/${slug}`), { maxRedirects: 0 })).status(),
      'old link of the unpublished post',
    ).toBe(404)
    expect(await listsPost(page, `/search?q=${marker}`, renamed), 'search after unpublishing').toBe(false)
    expect(await listsPost(page, `/categories/${categorySlug}`, renamed), 'category page after unpublishing').toBe(false)
    expect(await listsPost(page, `/tags/${tagSlug}`, renamed), 'tag page after unpublishing').toBe(false)
    // The tag's only post is a draft again: the tag is an unpublished topic once more, closed immediately instead of waiting for the cache.
    expect((await page.goto(localePath(`/tags/${tagSlug}`)))?.status(), 'tag page after unpublishing its only post').toBe(404)
    // `slug` is a prefix of `renamed`: one absence assert covers both URLs.
    expect(await bodyOf(page, localePath('/feed.xml')), 'feed after unpublishing').not.toContain(`/posts/${slug}`)
    const sitemapUnpublished = await bodyOf(page, '/sitemap.xml')
    expect(sitemapUnpublished, 'sitemap after unpublishing').not.toContain(`/posts/${slug}`)
    expect(sitemapUnpublished, 'sitemap after unpublishing the only post of the tag').not.toContain(tagLoc)

    // Leaving the page with unsaved changes: asks again in place; "Stay" keeps the text, "Leave page" discards it.
    await page.goto(`/admin/posts/${id}/edit`)
    await page.getByLabel(msg('Admin.editor.excerptLabel')).fill('Unsaved text')
    await page.getByRole('link', { name: msg('Admin.posts.preview.back'), exact: true }).click()
    const prompt = page.getByRole('group', { name: msg('Admin.editor.leaveQuestion') })
    await expect(prompt.getByRole('button', { name: msg('Admin.editor.stay') })).toBeFocused()
    await prompt.getByRole('button', { name: msg('Admin.editor.stay') }).click()
    await expect(page).toHaveURL(/\/edit$/)
    await expect(page.getByLabel(msg('Admin.editor.excerptLabel'))).toHaveValue('Unsaved text')
    await page.getByRole('link', { name: msg('Admin.posts.preview.back'), exact: true }).click()
    await page
      .getByRole('group', { name: msg('Admin.editor.leaveQuestion') })
      .getByRole('link', { name: msg('Admin.editor.leave') })
      .click()
    await expect(page).toHaveURL(/\/admin$/)
    expect((await stored())?.excerpt).toBe('Temporary post of the E2E suite, edited; deleted at the end of the test.')

    // Post list: the post is under the "Draft" filter and can be found without diacritics. `exact`: each row also has
    // "Preview “…”" and "Download ZIP “…”" carrying the title in their name, and Playwright's string name matches partially.
    await page.goto(`/admin?status=draft&q=${encodeURIComponent('e2e post')}`)
    await expect(page.getByRole('link', { name: title, exact: true })).toHaveAttribute('href', `/admin/posts/${id}/edit`)

    // Delete through the UI: confirm in place, back to the list with the sentence "The post was deleted", the backend no longer has the post.
    await page.goto(`/admin/posts/${id}/edit`)
    const remove = page.getByRole('region', { name: msg('Admin.posts.delete.heading') })
    await remove.getByRole('button', { name: msg('Admin.posts.delete.heading') }).click()
    await expect(remove.getByRole('button', { name: msg('Admin.posts.delete.cancel') })).toBeFocused()
    await remove.getByRole('button', { name: msg('Admin.posts.delete.forever') }).click()
    await expect(page).toHaveURL(/\/admin\?deleted=/)
    await expect(page.getByRole('status').filter({ hasText: msg('Admin.shell.postDeleted') })).toHaveText(
      msg('Admin.shell.postDeleted'),
    )
    expect(await stored()).toBeNull()
    // The edit page of a deleted post is the 404 UI (the HTTP status is 200 because the loading shell was already streamed
    // — a known trade-off).
    await page.goto(`/admin/posts/${id}/edit`)
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.shell.notFound.title') })).toBeVisible()
  } finally {
    await removeTemporary(page, backend, title)
    // After the post: the tag has no post left, so it has left the public list (the unpublish and the UI delete clear the cache).
    for (const tag of await backend.adminTags()) {
      if (tag.name === tagName) await backend.deleteTag(tag.id)
    }
  }
})
