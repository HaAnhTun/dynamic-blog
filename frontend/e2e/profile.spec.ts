import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import { COMMENT_TEXT, allThreads, commentArticle, findComment, openComments, rootComposer } from './support/comments'
import { API_URL } from './support/env'
import { expect, test } from './support/fixtures'
import { MOCK_EMAIL_DOMAIN, loginWithGitHub, mockUser } from './support/github'
import { readSeo } from './support/page'
import { msg } from './support/i18n'

/** "Joined <month>/<year>" from the catalog, with the month and year as digits. */
const JOINED_TEXT = new RegExp(
  `^${msg('Site.userProfile.joined', {
    date: msg('Meta.profile.joinedMonth', { month: '@M@', year: '@Y@' }),
    time: ((chunks: string) => chunks) as never,
  })
    .replace('@M@', String.raw`\d{1,2}`)
    .replace('@Y@', String.raw`\d{4}`)}$`,
)

/**
 * The public profile /u/<slug>: clicking a commenter's name goes to their profile, the profile has only what the comment
 * already made public, reader profiles are noindex; the site owner's name leads to /about.
 *
 * Bob: a reader no spec renames, suspends or changes the role of (carol gets suspended, dave changes role, noemail changes login).
 * Every comment goes into a temporary post, deleted in `afterAll` together with its comments.
 */
test.describe('Public profile', () => {
  let post: TemporaryPost | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'profile')
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  function tempPost(): TemporaryPost {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    return post
  }

  test('a reader comments; clicking the name in the comment opens /u/<slug>: name, @login, no email; the profile is noindex, still follow', async ({
    page,
    request,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    const login = reader('bob')
    const user = mockUser(login)
    const name = user.displayName!
    const text = `Bob visits a profile ${Date.now()}`

    await page.goto(`/posts/${slug}`)
    await loginWithGitHub(page, login)
    const section = await openComments(page, { signedIn: true })
    const composer = rootComposer(section)
    await composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true }).fill(text)
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()
    const article = commentArticle(section, name, text)
    await expect(article).toBeVisible()

    const profileSlug = findComment(await allThreads((after) => backend.comments(slug, after)), text)?.author?.profileSlug
    expect(profileSlug, 'the API returns profileSlug for the author (T-003)').toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    const path = `/u/${profileSlug}`

    // A single link, its name is its text, the avatar sits inside the same link; @login is still text.
    const link = article.getByRole('link', { name, exact: true })
    await expect(link).toHaveAttribute('href', path)
    await expect(link.locator('img')).toHaveAttribute('alt', '')
    await link.click()
    await page.waitForURL(`**${path}`)

    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(name)
    await expect(main.getByRole('link', { name: `@${login}`, exact: true })).toHaveAttribute(
      'href',
      `https://github.com/${login}`,
    )
    await expect(main.getByText(JOINED_TEXT)).toBeVisible()
    // A reader with no posts yet: no author label, no posts section, no comment history.
    await expect(main.getByText(msg('Site.authorBox.eyebrow'), { exact: true })).toHaveCount(0)
    await expect(main.getByRole('region', { name: msg('Site.about.readNextLinks.writing') })).toHaveCount(0)
    await expect(main).not.toContainText(text)

    // Loaded directly (what a crawler sees): 200, noindex but follow, canonical is itself; the whole document (including the
    // RSC payload) has no email.
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    const seo = await readSeo(page)
    expect(seo.robots).toContain('noindex')
    expect(seo.robots).not.toContain('nofollow')
    expect(new URL(seo.canonical!).pathname).toBe(path)
    const html = await page.content()
    expect(html).not.toContain(MOCK_EMAIL_DOMAIN)
    if (user.email) expect(html).not.toContain(user.email)

    // The public API: exactly the seven fields of the contract, no id, email, role or status.
    const api = await request.get(`${API_URL}/api/v1/users/${profileSlug}`)
    expect(api.status()).toBe(200)
    const data = ((await api.json()) as { data: Record<string, unknown> }).data
    expect(Object.keys(data).sort()).toEqual(
      ['avatarUrl', 'displayName', 'githubLogin', 'joinedAt', 'publishedPosts', 'siteOwner', 'slug'].sort(),
    )
    expect(data).toMatchObject({ slug: profileSlug, displayName: name, githubLogin: login, siteOwner: false, publishedPosts: 0 })
  })

  test("the site owner's name in a comment leads to /about; the owner's /u/<slug> redirects to /about", async ({
    page,
    backend,
  }) => {
    const { slug } = tempPost()
    const text = `The blog owner greets a profile ${Date.now()}`
    const own = await (await backend.asAdmin()).addComment(slug, text)
    expect(own.author?.siteOwner).toBe(true)
    const ownerSlug = own.author?.profileSlug
    expect(ownerSlug, 'the API returns profileSlug for the blog owner too').toBeTruthy()

    await page.goto(`/posts/${slug}`)
    const section = await openComments(page, { signedIn: false, all: true })
    const link = commentArticle(section, own.author!.displayName, text).getByRole('link', {
      name: own.author!.displayName,
      exact: true,
    })
    await expect(link).toHaveAttribute('href', '/about')
    await link.click()
    await page.waitForURL('**/about')

    await page.goto(`/u/${ownerSlug}`)
    expect(new URL(page.url()).pathname).toBe('/about')
  })
})
