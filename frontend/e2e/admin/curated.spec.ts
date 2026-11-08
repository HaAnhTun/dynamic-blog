import type { PostSummary } from '../../lib/types'
import { expect, test } from '../support/fixtures'
import { msg } from '../support/i18n'

/** Curated order as the admin sees it: every featured post (any status), rank ascending, unranked last. */
function byRank(posts: PostSummary[]): PostSummary[] {
  return posts
    .filter((post) => post.featured)
    .sort((a, b) => (a.featuredRank ?? Number.MAX_SAFE_INTEGER) - (b.featuredRank ?? Number.MAX_SAFE_INTEGER))
}

test('reordering "Featured posts": /start-here and the home page follow immediately, then the old order is restored', async ({
  adminPage: page,
  backend,
}) => {
  test.setTimeout(90_000)
  const original = byRank(await backend.adminPosts())
  test.skip(original.length < 2, 'At least two posts are needed in "Featured posts" to swap them')
  const originalIds = original.map((post) => post.id)
  const swapped = [original[1], original[0], ...original.slice(2)]
  const published = (posts: PostSummary[]) => posts.filter((post) => post.status === 'PUBLISHED')

  const list = page.getByRole('list', { name: msg('Admin.curated.orderLabel') })
  const save = page.getByRole('button', { name: msg('Admin.series.parts.save') })
  const startHere = page.getByRole('region', { name: msg('Site.startHere.readFirst') }).getByRole('heading', { level: 3 })
  const home = page.getByRole('region', { name: msg('Admin.posts.row.featured') }).getByRole('heading', { level: 3 })

  try {
    await page.goto('/admin/curated')
    await expect(list.locator('[data-title]')).toHaveText(original.map((post) => post.title))
    await list.getByRole('button', { name: msg('Admin.curated.moveDownLabel', { title: original[0].title }) }).click()
    await expect(list.locator('[data-title]')).toHaveText(swapped.map((post) => post.title))
    await expect(page.getByText(msg('Admin.gallery.manager.unsaved'))).toBeVisible()
    await save.click()
    await expect(page.getByText(msg('Admin.series.parts.orderSaved'))).toBeVisible()
    expect(byRank(await backend.adminPosts()).map((post) => post.id)).toEqual(swapped.map((post) => post.id))

    // The Server Action calls updateTag('posts'): both public pages show the new order on the next load.
    await page.goto('/start-here')
    await expect(startHere).toHaveText(published(swapped).map((post) => post.title))
    await page.goto('/')
    await expect(home).toHaveText(
      published(swapped)
        .slice(0, 3)
        .map((post) => post.title),
    )

    // Restore the exact old order, through the UI itself.
    await page.goto('/admin/curated')
    await list.getByRole('button', { name: msg('Admin.curated.moveUpLabel', { title: original[0].title }) }).click()
    await expect(list.locator('[data-title]')).toHaveText(original.map((post) => post.title))
    await save.click()
    await expect(page.getByText(msg('Admin.series.parts.orderSaved'))).toBeVisible()
    expect(byRank(await backend.adminPosts()).map((post) => post.id)).toEqual(originalIds)
    await page.goto('/start-here')
    await expect(startHere).toHaveText(published(original).map((post) => post.title))
  } finally {
    // Safety net: the shared stack's curated order must return to what it was wherever the test breaks.
    const now = byRank(await backend.adminPosts()).map((post) => post.id)
    if (JSON.stringify(now) !== JSON.stringify(originalIds)) await backend.setFeaturedOrder(originalIds)
  }
})
