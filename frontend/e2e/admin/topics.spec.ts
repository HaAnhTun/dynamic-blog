import type { APIRequestContext, APIResponse } from '@playwright/test'
import type { Post, Tag } from '../../lib/types'
import type { Backend } from '../support/backend'
import { adminAccessToken } from '../support/admin-session'
import { API_URL } from '../support/env'
import { expect, test } from '../support/fixtures'
import { msg } from '../support/i18n'

/**
 * The Topics page: create, rename, delete a temporary category and a tag through the UI, checked again
 * through the admin API; a category that has posts has no delete button but a link to exactly those posts. Everything
 * created carries the project name and the time, and is cleaned up at the end wherever the test breaks.
 */

const NAME_MARK = '\u0001'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The start of the region name of a manager section (its heading is the section title). */
function titled(title: string): RegExp {
  return new RegExp(`^${escapeRegExp(title)}`)
}

async function cleanup(backend: Backend, names: string[]): Promise<void> {
  for (const category of await backend.adminCategories()) {
    if (names.includes(category.name)) await backend.deleteCategory(category.id)
  }
  for (const tag of await backend.adminTags()) {
    if (names.includes(tag.name)) await backend.deleteTag(tag.id)
  }
}

test('create, rename, delete a category and a tag; a category in use cannot be deleted', async ({
  adminPage: page,
  backend,
}, testInfo) => {
  test.setTimeout(120_000)
  const stamp = `${testInfo.project.name} ${Date.now()}`
  const categoryName = `Category E2E ${stamp}`
  const categoryRenamed = `${categoryName} (renamed)`
  const tagName = `tag e2e ${stamp}`
  const tagRenamed = `${tagName} renamed`
  const all = [categoryName, categoryRenamed, tagName, tagRenamed]

  try {
    await page.goto('/admin/topics')
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.topics') })).toBeVisible()
    const categories = page.getByRole('region', { name: titled(msg('Admin.topics.manager.category.title')) })
    const tags = page.getByRole('region', { name: titled(msg('Admin.topics.manager.tag.title')) })

    // A category that already has posts (the sample posts always include at least one): no delete button, a link to the posts.
    const used = (await backend.adminPosts()).find((post) => post.category !== null)!.category!
    const [viewStart, viewEnd] = msg('Admin.topics.manager.viewPosts', { count: NAME_MARK }).split(NAME_MARK)
    const usedRow = categories.getByRole('listitem').filter({ hasText: `/categories/${used.slug}` })
    await expect(usedRow.getByRole('button', { name: titled(msg('Admin.topics.manager.delete')) })).toHaveCount(0)
    await expect(
      usedRow.getByRole('link', {
        name: new RegExp(
          `^${escapeRegExp(viewStart)}\\d+${escapeRegExp(viewEnd)} ${escapeRegExp(msg('Admin.topics.manager.viewPostsSr', { name: used.name }))}`,
        ),
      }),
    ).toHaveAttribute('href', `/admin?cat=${used.slug}`)

    // Create a category, rename it (the slug stays), delete it.
    await categories.getByLabel(msg('Admin.topics.manager.category.newNameLabel')).fill(categoryName)
    await categories.getByRole('button', { name: msg('Admin.editor.addCategory') }).click()
    await expect(categories.getByRole('status')).toHaveText(msg('Admin.topics.manager.category.added', { name: categoryName }))
    const created = (await backend.adminCategories()).find((category) => category.name === categoryName)!
    expect(created).toBeDefined()

    await categories
      .getByRole('button', {
        name: `${msg('Admin.topics.manager.edit')} ${msg('Admin.topics.manager.category.subject', { name: categoryName })}`,
      })
      .click()
    await categories.getByLabel(msg('Admin.editor.categoryName'), { exact: true }).fill(categoryRenamed)
    await categories.getByRole('button', { name: msg('Admin.editor.save'), exact: true }).click()
    await expect(categories.getByRole('status')).toHaveText(msg('Admin.topics.manager.renamed', { name: categoryRenamed }))
    const renamed = (await backend.adminCategories()).find((category) => category.id === created.id)!
    expect(renamed.name).toBe(categoryRenamed)
    expect(renamed.slug).toBe(created.slug)

    await categories
      .getByRole('button', {
        name: `${msg('Admin.topics.manager.delete')} ${msg('Admin.topics.manager.category.subject', { name: categoryRenamed })}`,
      })
      .click()
    await categories.getByRole('button', { name: msg('Admin.posts.delete.forever') }).click()
    await expect(categories.getByRole('status')).toHaveText(
      msg('Admin.topics.manager.category.deleted', { name: categoryRenamed }),
    )
    expect((await backend.adminCategories()).some((category) => category.id === created.id)).toBe(false)

    // Tag: create, rename, delete.
    await tags.getByLabel(msg('Admin.topics.manager.tag.newNameLabel')).fill(tagName)
    await tags.getByRole('button', { name: msg('Admin.editor.addTag') }).click()
    await expect(tags.getByRole('status')).toHaveText(msg('Admin.topics.manager.tag.added', { name: tagName }))
    await tags
      .getByRole('button', {
        name: `${msg('Admin.topics.manager.edit')} ${msg('Admin.topics.manager.tag.subject', { name: tagName })}`,
      })
      .click()
    await tags.getByLabel(msg('Admin.editor.tagName'), { exact: true }).fill(tagRenamed)
    await tags.getByRole('button', { name: msg('Admin.editor.save'), exact: true }).click()
    await expect(tags.getByRole('status')).toHaveText(msg('Admin.topics.manager.renamed', { name: tagRenamed }))
    await tags
      .getByRole('button', {
        name: `${msg('Admin.topics.manager.delete')} ${msg('Admin.topics.manager.tag.subject', { name: tagRenamed })}`,
      })
      .click()
    await tags.getByRole('button', { name: msg('Admin.posts.delete.forever') }).click()
    await expect(tags.getByRole('status')).toHaveText(msg('Admin.topics.manager.tag.deleted', { name: tagRenamed }))
    expect((await backend.adminTags()).some((tag) => tag.name === tagRenamed || tag.name === tagName)).toBe(false)
  } finally {
    await cleanup(backend, all)
  }
})

/**
 * Calls the admin API with the token of the password admin account: builds data the shared client (support/backend.ts)
 * cannot build — a draft that already carries a tag. A draft is in no cached public data,
 * so creating it directly in the backend is harmless.
 */
async function adminApi(http: APIRequestContext) {
  // The administrator's API session (support/admin-session.ts): a password alone no longer signs in.
  const headers = { authorization: `Bearer ${await adminAccessToken()}` }
  const data = async <T>(response: APIResponse, what: string): Promise<T> => {
    expect(response.ok(), `${what}: HTTP ${response.status()}`).toBe(true)
    return ((await response.json()) as { data: T }).data
  }
  return {
    createTag: async (name: string) => data<Tag>(await http.post('/api/v1/admin/tags', { headers, data: { name } }), 'POST tag'),
    createDraft: async (title: string, categoryId: string, tagIds: string[]) =>
      data<Post>(
        await http.post('/api/v1/admin/posts', {
          headers,
          data: { title, content: `## Temporary post\n\n${title}\n`, categoryId, tagIds },
        }),
        'POST post',
      ),
  }
}

test('merge tags: every post of the source tag carries the target tag, the source tag disappears', async ({
  adminPage: page,
  backend,
  playwright,
}, testInfo) => {
  test.setTimeout(90_000)
  const stamp = `${testInfo.project.name} ${Date.now()}`
  const sourceName = `merge source tag ${stamp}`
  const targetName = `merge target tag ${stamp}`
  const http = await playwright.request.newContext({ baseURL: API_URL })
  let draftId: string | null = null

  try {
    const api = await adminApi(http)
    const source = await api.createTag(sourceName)
    const target = await api.createTag(targetName)
    const [category] = await backend.adminCategories()
    expect(category, 'at least one category is needed').toBeDefined()
    draftId = (await api.createDraft(`E2E tag merge post ${stamp}`, category.id, [source.id])).id

    await page.goto('/admin/topics')
    const tags = page.getByRole('region', { name: titled(msg('Admin.topics.manager.tag.title')) })
    await tags
      .getByRole('button', {
        name: `${msg('Admin.topics.manager.merge')} ${msg('Admin.topics.manager.tag.mergeSr', { name: sourceName })}`,
        exact: true,
      })
      .click()
    const select = tags.getByLabel(msg('Admin.topics.manager.tag.mergeLabel', { name: sourceName, count: 1 }), { exact: true })
    await expect(select).toBeFocused()
    await select.selectOption({ value: target.id })
    const submit = tags.getByRole('button', {
      name: msg('Admin.topics.manager.tag.mergeSubmitInto', { target: targetName }),
      exact: true,
    })
    // The consequence sentence names both names and the number of posts, read together with the confirm button.
    await expect(submit).toHaveAccessibleDescription(
      msg('Admin.topics.manager.tag.consequence', {
        count: 1,
        name: sourceName,
        target: targetName,
        path: `/tags/${source.slug}`,
      }),
    )
    await submit.click()
    await expect(tags.getByRole('status')).toHaveText(
      msg('Admin.topics.manager.tag.merged', { name: sourceName, target: targetName, moved: 1 }),
    )

    // Backend: the source tag is gone; the draft carries the target tag.
    expect((await backend.adminTags()).some((tag) => tag.id === source.id)).toBe(false)
    const draft = (await backend.adminPosts()).find((post) => post.id === draftId)
    expect(draft?.tags.map((tag) => tag.id)).toEqual([target.id])
    // Screen: the source row disappears, the target tag counts exactly the posts just moved over.
    await expect(tags.getByRole('listitem').filter({ hasText: sourceName })).toHaveCount(0)
    await expect(tags.getByRole('listitem').filter({ hasText: targetName })).toContainText(
      msg('Admin.topics.manager.usageAll', { count: '1' }),
    )
  } finally {
    if (draftId !== null) await backend.deletePost(draftId)
    await cleanup(backend, [sourceName, targetName])
    await http.dispose()
  }
})
