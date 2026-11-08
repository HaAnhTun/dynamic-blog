import type { Page } from '@playwright/test'
import { LANGUAGE_NAMES } from '../components/site/language-names'
import { createTemporaryPost, msgAtTime, removeTemporaryPost } from './support/admin'
import { expect, test } from './support/fixtures'
import { msg } from './support/i18n'

/**
 * The bilingual journey: a published Vietnamese post gets an English translation made in the admin (translations panel),
 * which is written and published; then the public site follows: the article offers the other language, the alternates and
 * canonicals are per language, each language lists only its own posts, and unpublishing the translation takes it out of
 * every public place again, immediately. Paths are explicit for both languages, so the journey does not depend on E2E_LOCALE.
 * Desktop project only: nothing here depends on the viewport, and the post is shared state.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the journey does not depend on the viewport')
})

// The article text is in the language of the page, not of the run: the Vietnamese page carries the Vietnamese label.
const saveState = (page: Page) => page.getByRole('status').first()

test('create a post in each language, link them, switch language from the article and follow the alternate', async ({
  adminPage: page,
  browser,
  backend,
}, testInfo) => {
  test.setTimeout(240_000)
  const marker = String(Date.now())
  const viPost = await createTemporaryPost(browser, backend, testInfo, 'translation', 'vi')
  let translationId: string | null = null

  try {
    // The Vietnamese post has no translation yet: no link, and the page says nothing about another language.
    await page.goto(`/posts/${viPost.slug}`)
    await expect(page.getByRole('navigation', { name: msg('Site.article.translations.label', undefined, 'vi') })).toHaveCount(0)

    // Admin: create the English draft from the translations panel of the editor.
    await page.goto(`/admin/posts/${viPost.id}/edit`)
    await expect(page.getByRole('heading', { name: msg('Admin.posts.translations.heading') })).toBeVisible()
    await page.getByLabel(msg('Admin.posts.translations.createLanguage')).selectOption('en')
    await page.getByRole('button', { name: msg('Admin.posts.translations.create'), exact: true }).click()
    // The editor of the NEW draft: the URL changes from the Vietnamese post's id to the translation's.
    await page.waitForURL((url) => /\/admin\/posts\/[0-9a-f-]{36}\/edit$/.test(url.pathname) && !url.pathname.includes(viPost.id))
    translationId = page.url().match(/\/admin\/posts\/([0-9a-f-]{36})\/edit/)![1]!
    expect(translationId).not.toBe(viPost.id)
    await expect(page.getByLabel(msg('Admin.editor.languageLabel'))).toHaveValue('en')

    // The draft is not public: the Vietnamese article still shows no other language, and the draft slug is 404.
    const englishSlug = `${viPost.slug}-en`
    expect((await page.goto(`/en/posts/${englishSlug}`))?.status()).toBe(404)
    await page.goto(`/posts/${viPost.slug}`)
    await expect(page.getByRole('navigation', { name: msg('Site.article.translations.label', undefined, 'vi') })).toHaveCount(0)

    // Write and publish the translation through the editor.
    const englishTitle = `E2E English ${marker}`
    await page.goto(`/admin/posts/${translationId}/edit`)
    await page.getByLabel(msg('Admin.editor.titleLabel')).fill(englishTitle)
    await page
      .getByLabel(msg('Admin.editor.contentLabel'))
      .fill(`## English version\n\nThe English text of the E2E translation ${marker}.\n`)
    await page.getByRole('button', { name: msg('Admin.editor.save'), exact: true }).click()
    await expect(saveState(page)).toHaveText(msgAtTime('Admin.editor.state.savedAt'))
    await page.getByRole('button', { name: msg('Admin.posts.row.publish'), exact: true }).click()
    await expect(saveState(page)).toHaveText(/./)
    await expect
      .poll(async () => (await backend.adminPosts()).find((post) => post.id === translationId)?.status)
      .toBe('PUBLISHED')

    // Both sides of the link are in the API: each lists the other, published only.
    const english = await backend.post(englishSlug)
    const vietnamese = await backend.post(viPost.slug)
    expect(english.language).toBe('en')
    expect(vietnamese.language).toBe('vi')
    expect(english.translations?.map((item) => item.slug)).toEqual([viPost.slug])
    expect(vietnamese.translations?.map((item) => item.slug)).toEqual([englishSlug])

    // The Vietnamese article offers the English one; following the link lands on the English article, which offers the way back.
    await page.goto(`/posts/${viPost.slug}`)
    const other = page.getByRole('navigation', { name: msg('Site.article.translations.label', undefined, 'vi') })
    await expect(other).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
    const alternate = page.locator('link[rel="alternate"][hreflang="en"]')
    await expect(alternate).toHaveAttribute('href', new RegExp(`/en/posts/${englishSlug}$`))
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/posts/${viPost.slug}$`))
    await other.getByRole('link', { name: englishTitle }).click()
    await expect(page).toHaveURL(new RegExp(`/en/posts/${englishSlug}$`))
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { level: 1, name: englishTitle })).toBeVisible()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/en/posts/${englishSlug}$`))
    const back = page.getByRole('navigation', { name: msg('Site.article.translations.label', undefined, 'en') })
    await expect(back.getByRole('link', { name: viPost.title })).toHaveAttribute('href', `/posts/${viPost.slug}`)
    // The language switcher of the header leads to the translation too (not to the same slug under the other prefix).
    const switcher = page.getByRole('banner').getByRole('navigation', { name: msg('Admin.language.label', undefined, 'en') })
    await switcher.locator('summary').click()
    await expect(switcher.getByRole('link', { name: LANGUAGE_NAMES.vi })).toHaveAttribute('href', `/posts/${viPost.slug}`)

    // Each language lists only its own posts, in the pages and in the feeds, and the sitemap pairs the two.
    const fetchText = async (path: string) => {
      const response = await page.request.get(path)
      expect(response.status(), path).toBe(200)
      return response.text()
    }
    expect(await fetchText('/en/feed.xml')).toContain(`/en/posts/${englishSlug}`)
    expect(await fetchText('/en/feed.xml')).not.toContain(`/posts/${viPost.slug}<`)
    expect(await fetchText('/feed.xml')).toContain(`/posts/${viPost.slug}`)
    expect(await fetchText('/feed.xml')).not.toContain(`/en/posts/${englishSlug}`)
    const sitemap = await fetchText('/sitemap.xml')
    expect(sitemap).toContain(`/posts/${viPost.slug}</loc>`)
    expect(sitemap).toContain(`/en/posts/${englishSlug}</loc>`)
    expect(sitemap).toMatch(new RegExp(`hreflang="en" href="[^"]*/en/posts/${englishSlug}"`))

    // Unpublish the translation: it leaves every public place at once and the Vietnamese article offers no link any more.
    await page.goto(`/admin/posts/${translationId}/edit`)
    await page.getByRole('button', { name: msg('Admin.posts.row.unpublish') }).click()
    await expect.poll(async () => (await backend.adminPosts()).find((post) => post.id === translationId)?.status).toBe('DRAFT')
    expect((await page.goto(`/en/posts/${englishSlug}`))?.status()).toBe(404)
    await page.goto(`/posts/${viPost.slug}`)
    await expect(page.getByRole('navigation', { name: msg('Site.article.translations.label', undefined, 'vi') })).toHaveCount(0)
    expect(await fetchText('/sitemap.xml')).not.toContain(`/en/posts/${englishSlug}`)
    expect(await fetchText('/en/feed.xml')).not.toContain(englishSlug)
  } finally {
    if (translationId) await backend.deletePost(translationId)
    await removeTemporaryPost(browser, backend, testInfo, viPost)
  }
})
