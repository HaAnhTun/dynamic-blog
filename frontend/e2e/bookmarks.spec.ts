import type { Locator, Page } from '@playwright/test'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import type { UserApi } from './support/backend'
import { expect, test } from './support/fixtures'
import { loginWithGitHub, mockUser } from './support/github'
import { msg, localePath } from './support/i18n'

/**
 * Bookmarking posts: one journey on a temporary post (deleted in `afterAll`, the bookmark goes with the post). The reader is `bob`:
 * the other specs only use bob for likes and comments, and no other spec bookmarks posts.
 */

const LABEL = msg('Site.bookmarkButton.label')

/** The toggle button for a signed-in user: fixed name, state in aria-pressed. */
function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: LABEL, exact: true })
}

/** The bookmark state according to the backend, read with the reader's own token. */
async function bookmarked(api: UserApi, slug: string): Promise<boolean> {
  const response = await api.request('GET', `/api/v1/me/bookmarks/${encodeURIComponent(slug)}`)
  expect(response.status(), 'GET bookmark').toBe(200)
  return ((await response.json()) as { data: { bookmarked: boolean } }).data.bookmarked
}

/** Drop every bookmark left over from a run that broke midway: the empty state at the end must be real. */
async function clearBookmarks(api: UserApi): Promise<void> {
  const response = await api.request('GET', '/api/v1/me/bookmarks?size=50')
  expect(response.status(), 'GET bookmarks').toBe(200)
  const { data } = (await response.json()) as { data: { slug: string }[] }
  for (const saved of data) await api.request('DELETE', `/api/v1/me/bookmarks/${encodeURIComponent(saved.slug)}`)
}

test.describe('Bookmarks', () => {
  let post: TemporaryPost | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'bookmarks')
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  test('a guest sees the sign-in link; a reader bookmarks the post, sees it at /bookmarks, removes it there, the list is empty; the post HTML carries no bookmark state', async ({
    page,
    backend,
    reader,
  }) => {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    const { slug, title } = post
    const login = reader('bob')
    const returnTo = localePath(`/posts/${slug}#luu-bai`)

    // Guest: the sign-in link returns to exactly where the button is, no toggle button (a guest has no state to ask about).
    await page.goto(localePath(`/posts/${slug}`))
    const invite = page.getByRole('link', { name: msg('Site.bookmarkButton.guestName'), exact: true })
    await expect(invite).toBeVisible()
    await expect(invite).toHaveAttribute('href', `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`)
    await expect(invite).toHaveAttribute('rel', 'nofollow')
    await expect(saveButton(page)).toHaveCount(0)

    const tokens = await loginWithGitHub(page, login, { via: invite, returnTo })
    const bob = backend.asUser(tokens.accessToken)
    try {
      await clearBookmarks(bob)
      const button = saveButton(page)
      await expect(button).toHaveAttribute('aria-pressed', 'false')
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('#luu-bai').getByRole('status')).toHaveText(msg('Site.bookmarkButton.saved'))
      expect(await bookmarked(bob, slug), 'backend after saving').toBe(true)

      // The post HTML the reader themself downloads, with their cookie: still the shared version, with only an inert placeholder.
      const html = await (await page.request.get(localePath(`/posts/${slug}`))).text()
      expect(html).toContain('data-bookmark-placeholder')
      expect(html.includes('aria-pressed'), 'bookmark state in the HTML').toBe(false)
      expect(html.includes(mockUser(login).displayName!), 'reader name in the HTML').toBe(false)

      await page.goto(localePath('/bookmarks'))
      const row = page
        .getByRole('main')
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
      await expect(row).toHaveCount(1)
      await row.getByRole('button', { name: msg('Site.bookmarks.unsaveLabel', { title }), exact: true }).click()
      await expect(row).toHaveCount(0)
      await expect(page.getByText(msg('Site.bookmarks.empty'), { exact: true })).toBeVisible()
      expect(await bookmarked(bob, slug), 'backend after removing').toBe(false)
    } finally {
      await bob.request('DELETE', `/api/v1/me/bookmarks/${encodeURIComponent(slug)}`)
    }
  })
})
