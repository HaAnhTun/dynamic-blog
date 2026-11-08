import type { APIRequestContext } from '@playwright/test'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import { expect, test } from './support/fixtures'
import { msg } from './support/i18n'

/**
 * ISR and `updateTag` under both locales: a post page is cached per locale (revalidate 300), and a save in the admin (a Server Action
 * that calls `updateTag('posts')`) must refresh the page of every locale at once, not after the 5 minute window.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'cache checks do not depend on the viewport')
})

async function description(
  request: APIRequestContext,
  path: string,
): Promise<{ text: string | null; cache: string | undefined }> {
  const response = await request.get(path)
  expect(response.status(), path).toBe(200)
  const html = await response.text()
  return {
    text: /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? null,
    cache: response.headers()['x-nextjs-cache'],
  }
}

/** The editor status after a save: the catalog message with a clock time. */
const SAVED_STATUS = new RegExp(`^${msg('Admin.editor.state.savedAt', { time: '@@' })}$`.replace('@@', String.raw`\d{2}:\d{2}`))

test('a save in the admin refreshes the post page of both locales immediately; repeated reads are served from the cache', async ({
  adminPage: page,
  backend,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000)
  const post: TemporaryPost = await createTemporaryPost(browser, backend, testInfo, 'locale-cache')
  try {
    // The excerpt the helper stored, read back from the editor (the helper owns its wording).
    await page.goto(`/admin/posts/${post.id}/edit`)
    const excerptField = page.getByLabel(msg('Admin.editor.excerptLabel'))
    const before = await excerptField.inputValue()
    expect(before.length, 'the temporary post has an excerpt').toBeGreaterThan(0)
    for (const path of [`/posts/${post.slug}`, `/en/posts/${post.slug}`]) {
      expect((await description(request, path)).text, `${path} before the save`).toBe(before)
      const again = await description(request, path)
      expect(['HIT', 'STALE'], `${path} is served from the cache the second time`).toContain(again.cache)
    }

    const after = `Cache check ${Date.now()}`
    await page.goto(`/admin/posts/${post.id}/edit`)
    await excerptField.fill(after)
    await page.keyboard.press('ControlOrMeta+s')
    await expect(page.getByRole('status').first()).toHaveText(SAVED_STATUS)

    for (const path of [`/posts/${post.slug}`, `/en/posts/${post.slug}`]) {
      expect((await description(request, path)).text, `${path} after the save`).toBe(after)
    }
  } finally {
    await removeTemporaryPost(browser, backend, testInfo, post)
  }
})
