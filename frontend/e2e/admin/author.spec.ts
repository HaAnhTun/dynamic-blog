import type { Page } from '@playwright/test'
import { removeTemporaryPost, type TemporaryPost } from '../support/admin'
import { expect, test } from '../support/fixtures'
import { loginWithGitHub, mockUser } from '../support/github'
import { msg } from '../support/i18n'

/**
 * Journey of an author. The GitHub reader `dave-<project>` is promoted to AUTHOR by an admin via the role-change
 * API. The token they hold still carries the USER role, so /admin still rejects it, and the refresh token has been revoked:
 * the "Sign in with GitHub" path on /admin/login takes them straight into "My posts". There they write, edit and publish
 * their own post (the public page shows their name), cannot open other people's posts or admin-only pages, then delete it.
 *
 * `dave` is used by this spec only. `finally` always cleans up the post and demotes back to USER, even if the test breaks
 * midway, so the shared stack does not keep a stray author.
 */

/** The editor's status line: the first status region of the page (as in posts.spec.ts). */
const saveState = (page: Page) => page.getByRole('status').first()

const TIME_MARK = '\u0001'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The status line "Saved at hh:mm" and "Published at ..." as patterns built from the catalog messages. */
const [SAVED_START, SAVED_END] = msg('Admin.editor.state.savedAt', { time: TIME_MARK }).split(TIME_MARK)
const SAVED_AT = new RegExp(`^${escapeRegExp(SAVED_START)}\\d{2}:\\d{2}${escapeRegExp(SAVED_END)}$`)
const PUBLISHED_AT = new RegExp(
  `^${escapeRegExp(msg('Admin.editor.state.publishedAt', { time: TIME_MARK }).split(TIME_MARK)[0])}`,
)

const EXCERPT = 'Temporary post by the E2E author; deleted at the end of the test.'
const EXCERPT_EDITED = 'Temporary post by the E2E author, edited; deleted at the end of the test.'
const CONTENT = '## Section one\n\nFirst paragraph by the E2E author.\n'

test("author: signs in again after promotion; writes, edits and publishes own post; is denied on others' posts and admin-only pages", async ({
  page,
  browser,
  backend,
  reader,
  isMobile,
}, testInfo) => {
  test.setTimeout(150_000)
  const login = reader('dave')
  const user = mockUser(login)
  const title = `E2E author post ${testInfo.project.name} ${Date.now()}`

  await page.goto('/')
  const asReader = await loginWithGitHub(page, login)
  const userId = (await backend.asUser(asReader.accessToken).me()).id
  let created: TemporaryPost | null = null

  try {
    expect((await (await backend.asAdmin()).setUserRole(userId, 'AUTHOR')).role).toBe('AUTHOR')

    // The token in hand is still USER: /admin rejects it. Sign in again with GitHub right on that page.
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login\?reason=forbidden$/)
    await loginWithGitHub(page, login, {
      via: page.getByRole('main').getByRole('link', { name: msg('Admin.login.github'), exact: true }),
      returnTo: '/admin',
    })

    // "My posts", with a trimmed menu: no ADMIN-only entries. "Security" is the author's own sign-in (two-step verification, sign out everywhere).
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.myPosts') })).toBeVisible()
    if (isMobile) await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('list', { name: msg('Admin.shell.sectionsLabel') }).getByRole('link')).toHaveText([
      msg('Admin.shell.nav.myPosts'),
      msg('Admin.shell.nav.analytics'),
      msg('Admin.shell.nav.security'),
    ])

    // Write: the first save creates the post and moves to its own edit page.
    await page.goto('/admin/posts/new')
    await page.getByLabel(msg('Admin.editor.titleLabel')).fill(title)
    await page.getByLabel(msg('Admin.editor.excerptLabel')).fill(EXCERPT)
    await page.getByLabel(msg('Admin.editor.contentLabel')).fill(CONTENT)
    const category = page.getByLabel(msg('Admin.editor.categoryLabel'))
    const firstCategory = (await category.locator('option').nth(1).textContent())?.trim()
    expect(firstCategory, 'at least one category is needed to publish').toBeTruthy()
    await category.selectOption({ label: firstCategory! })
    await page.getByRole('button', { name: msg('Admin.editor.save'), exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/posts\/[0-9a-f-]{36}\/edit$/)
    await expect(saveState(page)).toHaveText(msg('Admin.editor.state.saved'))
    const postId = new URL(page.url()).pathname.split('/')[3]!
    created = { id: postId, slug: '', title }

    // Edit, then publish.
    await page.getByLabel(msg('Admin.editor.excerptLabel')).fill(EXCERPT_EDITED)
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveState(page)).toHaveText(SAVED_AT)
    await page.getByRole('button', { name: msg('Admin.posts.row.publish'), exact: true }).click()
    await expect(saveState(page)).toHaveText(PUBLISHED_AT)
    const slug = await page.getByLabel(msg('Admin.editor.slugLabel'), { exact: true }).inputValue()
    created = { id: postId, slug, title }

    // The newsletter of an author's post is held for an administrator, not sent; the admin refuses it so that nothing stays waiting.
    const held = await backend.heldNewsletterIssues()
    expect(held.map((issue) => issue.postId)).toContain(postId)
    await backend.discardNewsletterIssue(postId)

    // The public page names the right author, not the site owner.
    await page.goto(`/posts/${slug}`)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByText(EXCERPT_EDITED)).toBeVisible()
    await expect(page.getByRole('main')).toContainText(user.displayName!)

    // Someone else's post: an "unavailable" state inside the admin frame, not a single word of that post.
    const other = (await backend.adminPosts()).find((post) => post.id !== postId)
    expect(other, 'the E2E stack needs at least one post by someone else').toBeDefined()
    await page.goto(`/admin/posts/${other!.id}/edit`)
    await expect(page.getByText(msg('Admin.common.noAccess.post.title'))).toBeVisible()
    await expect(page.getByText(other!.title, { exact: true })).toHaveCount(0)

    // Admin-only page, opened by URL.
    await page.goto('/admin/users')
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.users') })).toBeVisible()
    await expect(page.getByText(msg('Admin.common.adminOnly.title'))).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)

    // Deleting one's own post through the UI: the public cache is refreshed and the post link turns 404 immediately.
    await page.goto(`/admin/posts/${postId}/edit`)
    const remove = page.getByRole('region', { name: msg('Admin.posts.delete.heading') })
    await remove.getByRole('button', { name: msg('Admin.posts.delete.heading') }).click()
    // The author is told the post only leaves their list and the site: an administrator keeps it (no "permanently").
    await expect(remove.getByRole('group')).toContainText(msg('Admin.posts.delete.author.consequences'))
    await expect(remove.getByRole('button', { name: msg('Admin.posts.delete.forever') })).toHaveCount(0)
    await remove.getByRole('button', { name: msg('Admin.posts.delete.author.confirm') }).click()
    await expect(page).toHaveURL(/\/admin\?deleted=/)
    expect((await page.goto(`/posts/${slug}`))?.status()).toBe(404)
    // An author's delete only hides the post (V49): it is gone from the author's list, and the safety net below deletes it for good
    // as an administrator, so that the shared stack keeps no stray post.
    await page.goto('/admin')
    await expect(page.getByRole('link', { name: title })).toHaveCount(0)
  } finally {
    // The post is hidden (the author's delete) or still there (a failure): the admin deletes it for good through the UI (refreshing
    // the public cache), then via the API.
    if (created !== null) await removeTemporaryPost(browser, backend, testInfo, created)
    await (await backend.asAdmin()).setUserRole(userId, 'USER')
  }
})
