import type { Page } from '@playwright/test'
import type { Post } from '../../lib/types'
import type { Backend } from '../support/backend'
import { expect, test } from '../support/fixtures'
import { readSeo } from '../support/page'
import { msg, applyLocale } from '../support/i18n'
import { escapeRegExp, msgStart } from '../support/admin'

/** The title as the row actions quote it in accessible names and announcements. */
const quoted = (title: string) => `“${title}”`

/** What a row action's accessible name is: its label plus the screen-reader-only quoted title. */
const rowAction = (key: string, title: string) => `${msg(key)} ${quoted(title)}`

/**
 * The admin post list: full-page preview of a draft, an action right on a row, multi-select posts to publish / unpublish / delete
 * a whole group, and sorting by "Recently edited".
 *
 * Every post here is a temporary draft created directly through the API (a draft is in no cached public
 * data), the title carries the project name and the time. Any step that publishes a post goes through the UI (only a
 * Server Action clears the public cache) and unpublishes via the UI before deleting; the safety net at the end of each test does the same.
 */

/** Temporary drafts with a category (publishable), one post per title. */
async function createDrafts(backend: Backend, titles: string[], marker: string): Promise<Post[]> {
  const drafts: Post[] = []
  for (const title of titles) {
    drafts.push(
      await backend.createDraftPost({
        title,
        excerpt: 'Temporary post of the E2E suite; deleted at the end of the test.',
        // Three entries: the table of contents only shows from three entries (MIN_TOC_ENTRIES in components/site/TocNav.tsx).
        content: `## Section one\n\nParagraph of the E2E post ${marker}.\n\n## Section two\n\nSecond paragraph.\n\n## Section three\n\nThird paragraph.\n`,
      }),
    )
  }
  return drafts
}

/** Safety net: a temporary post still published is unpublished through the editor (so the public cache refreshes), then deleted via the API. */
async function removeDrafts(page: Page, backend: Backend, drafts: Post[]): Promise<void> {
  const left = (await backend.adminPosts()).filter((post) => drafts.some((draft) => draft.id === post.id))
  for (const post of left) {
    if (post.status === 'PUBLISHED') {
      try {
        await page.goto(`/admin/posts/${post.id}/edit`)
        await page.getByRole('button', { name: msg('Admin.posts.row.unpublish'), exact: true }).click()
        await expect(page.getByRole('status').first()).toHaveText(msgStart('Admin.editor.state.unpublishedAt'))
      } catch {
        // If unpublishing through the UI fails, still delete: a stray post on the stack is worse than five minutes of stale cache.
      }
    }
    await backend.deletePost(post.id)
  }
}

/** The list's general notice line when it says exactly the sentence `text`. */
function listStatus(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text })
}

test('preview of a draft: as the reader would see it, only inside the admin; /posts/<draft> is still 404', async ({
  adminPage: page,
  backend,
  browser,
}, testInfo) => {
  const marker = String(Date.now())
  const title = `E2E post preview ${testInfo.project.name} ${marker}`
  const drafts = await createDrafts(backend, [title], marker)
  const [draft] = drafts

  try {
    // From the post list: the "Preview" of exactly that row.
    await page.goto(`/admin?status=draft&q=${marker}`)
    await page.getByRole('link', { name: rowAction('Admin.posts.row.preview', title) }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${draft.id}/preview$`))

    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    const bar = page.getByRole('region', {
      name: `${msg('Admin.posts.preview.heading')} ${msg('Admin.posts.preview.savedVersion')}`,
    })
    await expect(bar).toContainText(msg('Admin.statuses.post.DRAFT'))
    // Draft: there is no path to the public page.
    await expect(bar.getByRole('link', { name: new RegExp(escapeRegExp(msg('Admin.posts.preview.viewOnBlog'))) })).toHaveCount(0)
    await expect(page.getByText('Temporary post of the E2E suite; deleted at the end of the test.')).toBeVisible()
    // The preview is one column with no reading rail, so its table of contents is the collapsed inline <details> at every width:
    // open it by its own label, like a reader on a phone.
    const toc = page.getByRole('navigation', { name: msg('Site.article.toc') })
    await toc.getByText(msg('Site.article.toc'), { exact: true }).click()
    await expect(toc.getByRole('link')).toHaveText(['Section one', 'Section two', 'Section three'])
    // Full width like the editor: no sidebar.
    await expect(page.getByRole('navigation', { name: msg('Admin.shell.navLabel'), includeHidden: true })).toHaveCount(0)
    // Nothing meant for real readers: JSON-LD, comment section. And still noindex like every admin page.
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0)
    await expect(page.locator('#binh-luan')).toHaveCount(0)
    expect((await readSeo(page)).robots).toBe('noindex, nofollow')

    await bar.getByRole('link', { name: msg('Admin.posts.preview.edit') }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/posts/${draft.id}/edit$`))

    // On the public side, the draft still does not exist.
    expect((await page.goto(`/posts/${draft.slug}`))?.status()).toBe(404)

    // Not signed in: the preview is an admin page like any other.
    const guest = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
    try {
      await applyLocale(guest)
      const anon = await guest.newPage()
      await anon.goto(`/admin/posts/${draft.id}/preview`)
      await expect(anon).toHaveURL(/\/admin\/login/)
      await expect(anon.getByRole('heading', { level: 1, name: title })).toHaveCount(0)
    } finally {
      await guest.close()
    }
  } finally {
    await removeDrafts(page, backend, drafts)
  }
})

test('row actions: "Recently edited" puts the just-edited post first; toggle featured, publish, unpublish, delete in place', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(120_000)
  const marker = String(Date.now())
  const title = `E2E post row actions ${testInfo.project.name} ${marker}`
  const drafts = await createDrafts(backend, [title], marker)
  const [draft] = drafts
  const stored = async () => (await backend.adminPosts()).find((post) => post.id === draft.id) ?? null
  const featuredNotice = msg('Admin.posts.row.announceFeatured', { title: quoted(title) })
  const publishedNotice = msg('Admin.posts.row.announcePublished', { title: quoted(title) })
  const unpublishedNotice = msg('Admin.posts.row.announceUnpublished', { title: quoted(title) })
  const deletedNotice = msg('Admin.posts.row.announceDeleted', { title: quoted(title) })
  // The "edited <date>" line of the row: the catalog text before the date, then a year.
  const editedLead = msg('Admin.dashboard.meta.edited', { date: '', time: ((chunks: string) => chunks) as never }).trim()

  try {
    // The just-created post is the most recently edited of the whole blog: first when sorted by "Recently edited", with "edited <date>".
    await page.goto('/admin?sort=updated')
    await expect(page.getByLabel(msg('Admin.dashboard.toolbar.sort'))).toHaveValue('updated')
    const firstRow = page.getByRole('table').locator('tbody > tr').first()
    await expect(firstRow.getByRole('link', { name: title, exact: true })).toBeVisible()
    await expect(firstRow).toContainText(new RegExp(`${escapeRegExp(editedLead)}.*\\d{4}`))

    await page.goto(`/admin?q=${marker}`)
    // Featured post: toggled on then off while the post is still a draft (a draft shows nowhere publicly).
    const featured = page.getByRole('button', { name: rowAction('Admin.posts.row.featured', title) })
    await expect(featured).toHaveAttribute('aria-pressed', 'false')
    await featured.click()
    await expect(listStatus(page, featuredNotice)).toHaveText(featuredNotice)
    await expect(featured).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await stored())?.featured).toBe(true)
    await featured.click()
    await expect(featured).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await stored())?.featured).toBe(false)

    // Publish right on the row: the same button changes its text to "Unpublish", focus stays there; the public page sees it immediately.
    await page.getByRole('button', { name: rowAction('Admin.posts.row.publish', title) }).click()
    await expect(listStatus(page, publishedNotice)).toHaveText(publishedNotice)
    const unpublish = page.getByRole('button', { name: rowAction('Admin.posts.row.unpublish', title) })
    await expect(unpublish).toBeFocused()
    await expect.poll(async () => (await stored())?.status).toBe('PUBLISHED')
    expect((await page.request.get(`/posts/${draft.slug}`)).status()).toBe(200)

    await unpublish.click()
    await expect(listStatus(page, unpublishedNotice)).toHaveText(unpublishedNotice)
    await expect.poll(async () => (await stored())?.status).toBe('DRAFT')
    expect((await page.request.get(`/posts/${draft.slug}`)).status()).toBe(404)

    // Delete: asks again in place, focus on "Cancel"; on confirming the row disappears, focus returns to the notice line.
    await page
      .getByRole('button', {
        name: `${msg('Admin.posts.row.delete')} ${msg('Admin.posts.row.deleteSr', { title: quoted(title) })}`,
      })
      .click()
    const confirm = page.getByRole('group', {
      name: new RegExp(`^${escapeRegExp(msg('Admin.posts.row.confirmQuestion', { title: quoted(title) }))}`),
    })
    await expect(confirm.getByRole('button', { name: msg('Admin.posts.delete.cancel'), exact: true })).toBeFocused()
    await confirm.getByRole('button', { name: msg('Admin.posts.delete.forever'), exact: true }).click()
    const done = listStatus(page, deletedNotice)
    await expect(done).toHaveText(deletedNotice)
    await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0)
    await expect(done).toBeFocused()
    expect(await stored()).toBeNull()
  } finally {
    await removeDrafts(page, backend, drafts)
  }
})

test('multi-select: publish, unpublish then delete a whole group from the list; the public pages follow at each step', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(150_000)
  const marker = String(Date.now())
  const titles = [1, 2].map((n) => `E2E post bulk ${n} ${testInfo.project.name} ${marker}`)
  const drafts = await createDrafts(backend, titles, marker)
  const statuses = async () =>
    (await backend.adminPosts()).filter((post) => drafts.some((draft) => draft.id === post.id)).map((post) => post.status)
  const list = `/admin?q=${marker}`
  const selectAll = page.getByRole('checkbox', { name: msg('Admin.posts.list.selectAllAria', { count: '2' }) })
  const bar = page.getByRole('group', { name: msg('Admin.posts.list.selected', { count: '2' }) })

  try {
    await page.goto(list)
    await expect(page.getByRole('table').locator('tbody > tr')).toHaveCount(2)

    // Publish the whole group.
    await selectAll.check()
    await bar.getByRole('button', { name: msg('Admin.posts.list.publishN', { count: '2' }), exact: true }).click()
    await expect(listStatus(page, msg('Admin.posts.list.doneAll.publish', { count: '2' }))).toHaveText(
      msg('Admin.posts.list.doneAll.publish', { count: '2' }),
    )
    await expect.poll(statuses).toEqual(['PUBLISHED', 'PUBLISHED'])
    for (const draft of drafts) expect((await page.request.get(`/posts/${draft.slug}`)).status(), draft.slug).toBe(200)

    // Unpublish the whole group: only "Unpublish" — every selected post is published, nothing to "Publish".
    await selectAll.check()
    await expect(bar.getByRole('button', { name: msgStart('Admin.posts.list.publishN', 'count') })).toHaveCount(0)
    await bar.getByRole('button', { name: msg('Admin.posts.list.unpublishN', { count: '2' }), exact: true }).click()
    await expect(listStatus(page, msg('Admin.posts.list.doneAll.unpublish', { count: '2' }))).toHaveText(
      msg('Admin.posts.list.doneAll.unpublish', { count: '2' }),
    )
    await expect.poll(statuses).toEqual(['DRAFT', 'DRAFT'])
    for (const draft of drafts) expect((await page.request.get(`/posts/${draft.slug}`)).status(), draft.slug).toBe(404)

    // Delete the whole group: asks again in place with the number of posts and each post name (newest created first, as in the list).
    await selectAll.check()
    await bar.getByRole('button', { name: msg('Admin.posts.list.deleteN', { count: '2' }), exact: true }).click()
    const confirm = page.getByRole('group', {
      name: new RegExp(`^${escapeRegExp(msg('Admin.posts.list.confirmQuestion', { count: '2' }))}`),
    })
    await expect(confirm.getByRole('button', { name: msg('Admin.posts.delete.cancel'), exact: true })).toBeFocused()
    await expect(confirm.getByRole('listitem')).toHaveText([...titles].reverse())
    await confirm.getByRole('button', { name: msg('Admin.posts.list.deleteForeverN', { count: '2' }), exact: true }).click()
    await expect(listStatus(page, msg('Admin.posts.list.doneAll.delete', { count: '2' }))).toHaveText(
      msg('Admin.posts.list.doneAll.delete', { count: '2' }),
    )
    await expect(page.getByText(msg('Admin.dashboard.empty.noMatch'))).toBeVisible()
    expect(await statuses()).toEqual([])
  } finally {
    await removeDrafts(page, backend, drafts)
  }
})
