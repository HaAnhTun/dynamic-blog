import type { Locator, Page } from '@playwright/test'
import type { CommentPage } from '../lib/types'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import {
  COMMENT_TEXT,
  allThreads,
  commentArticle,
  commentBody,
  commentIds,
  commentLoginLink,
  findComment,
  isCommentPageRequest,
  openComments,
  rootComposer,
} from './support/comments'
import { expect, test } from './support/fixtures'
import {
  loginWithGitHub,
  mockUser,
  newUserContext,
  newVisitorContext,
  readerLogin,
  type ReaderName,
  type SessionTokens,
} from './support/github'
import { msg, localePath } from './support/i18n'

/**
 * Reader comments on the post page.
 *
 * Every write goes into a temporary post published in `beforeAll` and deleted in `afterAll` (comments go with the post, ON
 * DELETE CASCADE). Each content carries `Date.now()`: no run repeats a previous one, and the backend's duplicate-submission
 * guard (same content within 10 minutes) is never the reason a test fails.
 *
 * Bob and Mallory build data through the API, with the token from a real GitHub sign-in in `beforeAll`
 * (the access token lives 15 minutes, the spec runs a few minutes). The people using the page — Alice, Mallory, `bidi`,
 * `spammer` — sign in again in each test. Writes are spread across several people: the comment limit is counted
 * per user and per minute, and a repeated spec run (--repeat-each) or one right after the moderation spec must not
 * push anyone to 429 except `spammer`.
 *
 * The temporary post is shared by the whole spec, so any test that needs a specific comment loads all the pages (the
 * load-more button) before looking, and no test relies on data a previous test left behind: after a failed test,
 * Playwright restarts the worker and `beforeAll` builds a fresh temporary post for the remaining tests.
 */

/** Two readers who build data through the API (token from `beforeAll`); Mallory also uses the page in a few tests. */
type Seeder = Extract<ReaderName, 'bob' | 'mallory'>

/** The response of a BFF route: status and the error code in the `{ error: { code } }` envelope (null on 2xx). */
type BffReply = { status: number; code: string | null }

/**
 * One write straight to the BFF route, from the reader's page: same origin, their cookie — exactly the path the
 * form on the page calls, just without going through the form's checks.
 */
function writeFromPage(page: Page, path: string, body: string): Promise<BffReply> {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      const json = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
      return { status: response.status, code: json?.error?.code ?? null }
    },
    { path, body },
  )
}

/** `prefix` then `filler` (one code point) repeated up to exactly `length` code points. */
function withLength(prefix: string, filler: string, length: number): string {
  return `${prefix}${filler.repeat(length - Array.from(prefix).length)}`
}

/**
 * The content shows exactly character for character as the author typed it, and as plain text only: the content paragraph has no child
 * elements (no `<img>`, `<script>`, `<a>` built from it), comments included, and no code
 * in it has run (`window.__xss` was never assigned).
 *
 * The only `<svg>` allowed is the page's own decorative shape — the heart of the comment like —
 * and every icon of the page is always `aria-hidden="true"` (components/icons.tsx). An `<svg onload>` built
 * from the content lacks that attribute, so it is still caught.
 *
 * The only `<a>` allowed is the page's link to the author's profile: `/u/<slug>`, or `/about` for the site owner.
 */
async function expectPlainText(page: Page, article: Locator, payload: string): Promise<void> {
  const body = commentBody(article, payload.split('\n')[0]!)
  expect(await body.evaluate((node) => ({ text: node.textContent, children: node.childElementCount }))).toEqual({
    text: payload,
    children: 0,
  })
  await expect(
    article.locator(
      `script, iframe, a:not([href^="${localePath('/u/')}"]):not([href="${localePath('/about')}"]), img[src="x"], svg:not([aria-hidden="true"])`,
    ),
  ).toHaveCount(0)
  expect(await page.evaluate(() => (window as Window & { __xss?: unknown }).__xss)).toBeUndefined()
}

const EDITED_AT_PATTERN = new RegExp(`${escapeRegExp(msg('Site.comments.item.edited'))}.*[0-9]{2}:[0-9]{2}`)
const LIKE_LABEL_PREFIX = msg('Site.comments.like.ariaLabel', { author: 'AUTHOR_MARK', n: 0, count: 0 }).split('AUTHOR_MARK')[0]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The like button of a comment (only signed-in users have it). */
function commentLikeButton(article: Locator): Locator {
  return article.getByRole('button', { name: new RegExp(`^${escapeRegExp(LIKE_LABEL_PREFIX)}`) })
}

/** A thread (a root with its replies) in the comment section: a direct `<li>` child of the root list. */
function threadItems(section: Locator): Locator {
  return section.locator(':scope > ol > li')
}

test.describe('Comments', () => {
  let post: TemporaryPost | undefined
  let seeders: Record<Seeder, SessionTokens> | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'comments')
    const tokensOf = async (name: Seeder) => {
      const session = await newUserContext(browser, readerLogin(name, testInfo.project.name), testInfo)
      await session.context.close()
      return session.tokens
    }
    seeders = { bob: await tokensOf('bob'), mallory: await tokensOf('mallory') }
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  /** The temporary post of this spec; if `beforeAll` fails, every test stops here with a clear reason. */
  function tempPost(): TemporaryPost {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    return post
  }

  function seederToken(name: Seeder): string {
    if (!seeders) throw new Error('The seeding users are not signed in (beforeAll failed)')
    return seeders[name].accessToken
  }

  /** The blog name shown for a fake reader (the GitHub name after the backend sanitizes it). */
  function nameOf(login: string): string {
    return mockUser(login).displayName!
  }

  test('guest: an empty post invites the first comment; sees comments and replies with no form, no button; the sign-in invitation returns to the right section', async ({
    page,
    request,
    backend,
    reader,
  }, testInfo) => {
    const { slug } = tempPost()
    // The first test of the spec: the temporary post is still empty. Whoever reorders the tests will meet exactly this sentence.
    expect(
      (await backend.comments(slug)).threads,
      'the temporary post must still be empty: this is the first test of the spec',
    ).toEqual([])
    await page.goto(localePath(`/posts/${slug}`))
    let section = await openComments(page, { signedIn: false })
    await expect(section.getByText(COMMENT_TEXT.empty, { exact: true })).toBeVisible()

    const stamp = Date.now()
    const rootText = `Comment a guest can read ${stamp}`
    const replyText = `Reply a guest can read ${stamp}`
    const bobLogin = readerLogin('bob', testInfo.project.name)
    const malloryLogin = readerLogin('mallory', testInfo.project.name)
    const root = await backend.asUser(seederToken('bob')).addComment(slug, rootText)
    await backend.asUser(seederToken('mallory')).reply(root.id, replyText)

    // The post page HTML (the ISR version shared by everyone) carries no comments: they arrive after
    // hydration, through a no-store BFF route.
    const html = await (await request.get(localePath(`/posts/${slug}`))).text()
    expect(html.includes(rootText), 'comment in the server HTML').toBe(false)

    await page.reload()
    section = await openComments(page, { signedIn: false })
    const rootArticle = commentArticle(section, nameOf(bobLogin), rootText)
    await expect(rootArticle).toBeVisible()
    await expect(rootArticle).toContainText(`@${bobLogin}`)
    await expect(rootArticle.locator('time')).toHaveAttribute('datetime', root.createdAt)
    // The reply sits inside the thread of that very root.
    const thread = threadItems(section).filter({ has: commentArticle(page, nameOf(bobLogin), rootText) })
    await expect(commentArticle(thread, nameOf(malloryLogin), replyText)).toBeVisible()

    // A guest only reads: no input, no button (reply, edit, delete).
    await expect(section.getByRole('textbox')).toHaveCount(0)
    await expect(section.getByRole('button')).toHaveCount(0)

    const returnTo = localePath(`/posts/${slug}#binh-luan`)
    const cta = commentLoginLink(section)
    await expect(cta).toHaveAttribute('href', `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`)
    await expect(cta).toHaveAttribute('rel', 'nofollow')

    // Sign in from the invitation itself: back to the right comment section, the root form is ready, "Reply" is present.
    await loginWithGitHub(page, reader('alice'), { via: cta, returnTo })
    section = await openComments(page, { signedIn: true })
    await expect(commentLoginLink(section)).toHaveCount(0)
    await expect(
      commentArticle(section, nameOf(bobLogin), rootText).getByRole('button', {
        name: msg('Site.comments.item.reply'),
        exact: true,
      }),
    ).toBeVisible()
  })

  test('post, reply, edit ("edited"), delete one\'s own comment: every step matches the backend', async ({
    page,
    backend,
    reader,
  }, testInfo) => {
    const { slug } = tempPost()
    const login = reader('alice')
    const name = nameOf(login)
    const bobName = nameOf(readerLogin('bob', testInfo.project.name))
    const stamp = Date.now()
    const bobText = `Bob starts a thread ${stamp}`
    const bobRoot = await backend.asUser(seederToken('bob')).addComment(slug, bobText)

    await page.goto(localePath(`/posts/${slug}`))
    const alice = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    const asAlice = (after?: string) => alice.comments(slug, after)
    const section = await openComments(page, { signedIn: true, all: true })
    const status = section.getByRole('status')

    // Post: the counter follows the text being typed, the comment shows immediately at the end of the list, the box is empty again, focus goes to it.
    const text = `Alice comments ${stamp}`
    const composer = rootComposer(section)
    const field = composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true })
    await field.fill(text)
    await expect(composer.getByText(`${Array.from(text).length}/2000`, { exact: true })).toBeVisible()
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()
    const mine = commentArticle(section, name, text)
    await expect(mine).toBeFocused()
    await expect(status).toHaveText(msg('Site.comments.announce.posted'))
    await expect(field).toHaveValue('')
    await expect(mine).toContainText(`@${login}`)
    // The posting date and time is the visible text inside <time> (Playwright pins the Asia/Ho_Chi_Minh time zone), the relative
    // time is secondary text after it, outside <time>.
    await expect(mine.locator('time')).toHaveText(/^\d{2}:\d{2}, \d{2}\/\d{2}\/\d{4}$/)
    await expect(mine).toContainText(msg('Site.time.justNow'))
    expect(findComment(await allThreads(asAlice), text)).toMatchObject({
      status: 'VISIBLE',
      edited: false,
      mine: true,
      author: { displayName: name, githubLogin: login },
    })

    // Reply to Bob: a form right under that thread, focus in the box; after sending the form closes, the reply gets focus.
    const bobArticle = commentArticle(section, bobName, bobText)
    const replyButton = bobArticle.getByRole('button', { name: msg('Site.comments.item.reply'), exact: true })
    await replyButton.click()
    await expect(replyButton).toHaveAttribute('aria-expanded', 'true')
    const replyField = section.getByLabel(COMMENT_TEXT.replyLabel, { exact: true })
    await expect(replyField).toBeFocused()
    const replyText = `Alice replies to Bob ${stamp}`
    await replyField.fill(replyText)
    await section.getByRole('button', { name: msg('Site.comments.replyForm.submit'), exact: true }).click()
    const reply = commentArticle(section, name, replyText)
    await expect(reply).toBeFocused()
    await expect(status).toHaveText(msg('Site.comments.announce.replied'))
    await expect(replyField).toHaveCount(0)
    await expect(replyButton).toHaveAttribute('aria-expanded', 'false')
    const bobThread = threadItems(section).filter({ has: commentArticle(page, bobName, bobText) })
    await expect(commentArticle(bobThread, name, replyText)).toBeVisible()
    // One level: a reply has no "Reply" button.
    await expect(reply.getByRole('button', { name: msg('Site.comments.item.reply'), exact: true })).toHaveCount(0)
    const threadOnServer = (await allThreads(asAlice)).find((candidate) => candidate.comment.id === bobRoot.id)
    expect(threadOnServer?.replies.map((candidate) => [candidate.content, candidate.mine])).toEqual([[replyText, true]])

    // Edit: the edit box carries the old text, focus in the box; after saving it shows "edited", focus returns to "Edit".
    await mine.getByRole('button', { name: msg('Site.comments.item.edit'), exact: true }).click()
    const editField = section.getByLabel(COMMENT_TEXT.editLabel, { exact: true })
    await expect(editField).toBeFocused()
    await expect(editField).toHaveValue(text)
    const editedText = `Alice edits her comment ${stamp}`
    await editField.fill(editedText)
    await section.getByRole('button', { name: msg('Site.comments.item.editSave'), exact: true }).click()
    const edited = commentArticle(section, name, editedText)
    await expect(edited.getByRole('button', { name: msg('Site.comments.item.edit'), exact: true })).toBeFocused()
    // The visible edit time: "edited at HH:mm", plus the date if the run spans midnight.
    await expect(edited).toContainText(EDITED_AT_PATTERN)
    await expect(status).toHaveText(msg('Site.comments.announce.saved'))
    await expect(commentArticle(section, name, text)).toHaveCount(0)
    expect(findComment(await allThreads(asAlice), editedText)).toMatchObject({ edited: true, mine: true })

    // Reload: the server's version, still "edited".
    await page.reload()
    const again = await openComments(page, { signedIn: true, all: true })
    const target = commentArticle(again, name, editedText)
    await expect(target).toContainText(EDITED_AT_PATTERN)

    // Delete (no replies): asks again in place with focus on "Cancel", after deleting the comment disappears entirely.
    await target.getByRole('button', { name: msg('Site.comments.item.delete'), exact: true }).click()
    const confirm = target.getByRole('group', { name: msg('Site.comments.item.deleteConfirm') })
    await expect(confirm.getByRole('button', { name: msg('Site.comments.form.cancel'), exact: true })).toBeFocused()
    await confirm.getByRole('button', { name: msg('Site.comments.item.delete'), exact: true }).click()
    await expect(commentArticle(again, name, editedText)).toHaveCount(0)
    await expect(again.getByRole('status')).toHaveText(msg('Site.comments.announce.deleted'))
    expect(findComment(await allThreads(asAlice), editedText), 'deleted comment for a reader').toBeUndefined()
    // The reply in Bob's thread is unrelated, still intact.
    await expect(commentArticle(again, name, replyText)).toBeVisible()
  })

  test('deleting a root comment that still has replies: becomes the "This comment was deleted." placeholder, replies still show, for guests too', async ({
    page,
    browser,
    backend,
    reader,
  }, testInfo) => {
    const { slug } = tempPost()
    // Mallory is the person using the page in this test: writes are spread across several people so nobody hits
    // the per-minute limit when the spec runs repeatedly (--repeat-each) right after the moderation spec.
    const login = reader('mallory')
    const name = nameOf(login)
    const bobName = nameOf(readerLogin('bob', testInfo.project.name))
    const stamp = Date.now()
    const rootText = `Mallory root to be deleted ${stamp}`
    const replyText = `Bob replied before the root was deleted ${stamp}`

    await page.goto(localePath(`/posts/${slug}`))
    const mallory = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    const root = await mallory.addComment(slug, rootText)
    await backend.asUser(seederToken('bob')).reply(root.id, replyText)

    // The comment section may have loaded as soon as the page opened (it is near the screen): reload to get the thread just built.
    await page.reload()
    const section = await openComments(page, { signedIn: true, all: true })
    const article = commentArticle(section, name, rootText)
    await article.getByRole('button', { name: msg('Site.comments.item.delete'), exact: true }).click()
    await article
      .getByRole('group', { name: msg('Site.comments.item.deleteConfirm') })
      .getByRole('button', { name: msg('Site.comments.item.delete'), exact: true })
      .click()
    await expect(section.getByRole('status')).toHaveText(msg('Site.comments.announce.deleted'))

    // Right in place: the root becomes a placeholder — no name, no text, no button — Bob's reply is still there.
    const thread = threadItems(section).filter({ has: commentArticle(page, bobName, replyText) })
    const placeholder = thread.getByRole('article', { name: COMMENT_TEXT.deleted, exact: true })
    await expect(placeholder).toBeVisible()
    await expect(placeholder).not.toContainText(name)
    await expect(placeholder.getByRole('button')).toHaveCount(0)
    await expect(section.getByText(rootText)).toHaveCount(0)
    await expect(commentArticle(thread, bobName, replyText)).toBeVisible()

    // Backend: a DELETED root exposes no content or author; the reply is still visible.
    const seen = (await allThreads((after) => backend.comments(slug, after))).find((item) => item.comment.id === root.id)
    expect(seen?.comment).toMatchObject({ status: 'DELETED', content: null, author: null, mine: false })
    expect(seen?.replies.map((item) => item.content)).toEqual([replyText])

    // A guest opens the post: the same placeholder, the same reply, and the deleted text is nowhere on the page.
    const visitor = await newVisitorContext(browser, testInfo)
    try {
      const guest = await visitor.newPage()
      await guest.goto(localePath(`/posts/${slug}`))
      const guestSection = await openComments(guest, { signedIn: false, all: true })
      const guestThread = threadItems(guestSection).filter({ has: commentArticle(guest, bobName, replyText) })
      await expect(guestThread.getByRole('article').first()).toHaveAccessibleName(COMMENT_TEXT.deleted)
      await expect(guestThread.getByRole('article')).toHaveCount(2)
      expect((await guest.content()).includes(rootText), 'text of the deleted comment in the page').toBe(false)
    } finally {
      await visitor.close()
    }
  })

  test('content is plain text: HTML tags, script, markdown, javascript: links show verbatim and run nothing', async ({
    page,
    browser,
    backend,
    reader,
  }, testInfo) => {
    const { slug } = tempPost()
    const login = reader('mallory')
    const name = nameOf(login)
    const stamp = Date.now()
    const firstLine = `XSS attempt ${stamp}`
    const payload = [
      firstLine,
      '<script>window.__xss = "script"</script>',
      `<img src="x" onerror="window.__xss = 'img'">`,
      `<svg onload="window.__xss = 'svg'"><circle r="4"></circle></svg>`,
      `<iframe srcdoc="<script>parent.__xss = 'iframe'</script>"></iframe>`,
      `<a href="javascript:window.__xss = 'a'">click here</a>`,
      "[link markdown](javascript:window.__xss='md') **bold** `code`",
      '&lt;b&gt;entity&lt;/b&gt; and https://example.com/does-not-become-a-link',
    ].join('\n')

    await page.goto(localePath(`/posts/${slug}`))
    const mallory = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    const section = await openComments(page, { signedIn: true })
    const composer = rootComposer(section)
    await composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true }).fill(payload)
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()

    // Just posted (the server version returned for the POST), then the reloaded version, then a guest: all three paths render. A signed-in
    // user sees the like button (an aria-hidden heart) in this very post: the `<svg>` check must skip
    // exactly that, and only that.
    const posted = commentArticle(section, name, firstLine)
    await expect(commentLikeButton(posted)).toBeVisible()
    await expectPlainText(page, posted, payload)
    expect(findComment(await allThreads((after) => mallory.comments(slug, after)), payload)?.content).toBe(payload)

    await page.reload()
    const reloaded = commentArticle(await openComments(page, { signedIn: true, all: true }), name, firstLine)
    await expect(commentLikeButton(reloaded)).toBeVisible()
    await expectPlainText(page, reloaded, payload)

    const visitor = await newVisitorContext(browser, testInfo)
    try {
      const guest = await visitor.newPage()
      await guest.goto(localePath(`/posts/${slug}`))
      const guestSection = await openComments(guest, { signedIn: false, all: true })
      await expectPlainText(guest, commentArticle(guestSection, name, firstLine), payload)
    } finally {
      await visitor.close()
    }
  })

  test('a name with the bidi override character U+202E: the backend drops it, the page shows the name in <bdi> as the comment name', async ({
    page,
    backend,
  }) => {
    const { slug } = tempPost()
    const bidi = mockUser('bidi')
    const override = String.fromCodePoint(0x202e)
    expect(bidi.name?.includes(override), 'the GitHub name of "bidi" carries U+202E').toBe(true)
    const shown = bidi.displayName!
    expect(shown.includes(override)).toBe(false)
    const text = `Comment by a reversed-name user ${Date.now()}`

    await page.goto(localePath(`/posts/${slug}`))
    const api = backend.asUser((await loginWithGitHub(page, bidi.login)).accessToken)
    const section = await openComments(page, { signedIn: true })
    const composer = rootComposer(section)
    await composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true }).fill(text)
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()

    const article = commentArticle(section, shown, text)
    await expect(article).toBeVisible()
    // The accessible name of the comment is the <bdi> element itself, carrying the sanitized name.
    const label = await article.evaluate((node) => {
      const target = document.getElementById(node.getAttribute('aria-labelledby') ?? '')
      return { tag: target?.tagName ?? null, text: target?.textContent ?? null }
    })
    expect(label).toEqual({ tag: 'BDI', text: shown })
    expect(findComment(await allThreads((after) => api.comments(slug, after)), text)?.author?.displayName).toBe(shown)
  })

  test('length counted by code point like the backend: 2000 (even emoji) can be sent; at 2001 the send button locks, a direct BFF POST gets 400', async ({
    page,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    const login = reader('alice')
    const name = nameOf(login)
    await page.goto(localePath(`/posts/${slug}`))
    const alice = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    const asAlice = (after?: string) => alice.comments(slug, after)
    const section = await openComments(page, { signedIn: true })
    const composer = rootComposer(section)
    const field = composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true })
    const submit = composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true })
    const counter = composer.getByText(/^\d+\/2000$/)

    await field.fill('a')
    await expect(counter).toHaveText('1/2000')
    await expect(submit).toBeDisabled()
    // The locked button leaves the Tab order: the requirement sentence says why, is visible and is in the box description (WCAG 3.3.2).
    await expect(composer.getByText(msg('Site.comments.form.minLength', { min: '2' }), { exact: true })).toBeVisible()
    await expect(field).toHaveAccessibleDescription(`1/2000 ${msg('Site.comments.form.minLength', { min: '2' })}`)

    // An emoji is one code point but two UTF-16 units: the counter measures like the backend, not like `.length`.
    const stamp = Date.now()
    const emoji = String.fromCodePoint(0x1f600)
    const atLimit = withLength(`Exactly 2000 long ${stamp} `, emoji, 2000)
    expect(atLimit.length, 'a string of 2000 code points is longer than 2000 UTF-16 units').toBeGreaterThan(2000)
    await field.fill(atLimit)
    await expect(counter).toHaveText('2000/2000')
    await expect(field).not.toHaveAttribute('aria-invalid', 'true')
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(commentArticle(section, name, `Exactly 2000 long ${stamp}`)).toBeVisible()
    const stored = findComment(await allThreads(asAlice), atLimit)
    expect(Array.from(stored?.content ?? '').length, 'length stored by the backend').toBe(2000)

    const overLimit = withLength(`Length 2001 ${stamp} `, emoji, 2001)
    await field.fill(overLimit)
    await expect(counter).toHaveText('2001/2000')
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(submit).toBeDisabled()

    // Bypass the form, call the BFF route straight from the page: the backend still rejects, nothing is saved.
    const direct = await writeFromPage(page, `/api/posts/${slug}/comments`, JSON.stringify({ content: overLimit }))
    expect(direct).toEqual({ status: 400, code: 'VALIDATION_ERROR' })
    expect(findComment(await allThreads(asAlice), overLimit)).toBeUndefined()
  })

  test('a 20 KB body: the BFF returns 413 PAYLOAD_TOO_LARGE; through the form the length sentence shows and the text is kept', async ({
    page,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    await page.goto(localePath(`/posts/${slug}`))
    const alice = backend.asUser((await loginWithGitHub(page, reader('alice'))).accessToken)
    const section = await openComments(page, { signedIn: true })
    const stamp = Date.now()
    const path = `/api/posts/${slug}/comments`
    const huge = JSON.stringify({ content: `Body 20 KB ${stamp} ${'x'.repeat(20 * 1024)}` })
    expect(Buffer.byteLength(huge)).toBeGreaterThan(20 * 1024)

    expect(await writeFromPage(page, path, huge)).toEqual({ status: 413, code: 'PAYLOAD_TOO_LARGE' })

    // Through the form: the reader types a valid comment, but the body leaving the browser is 20 KB (a tampered
    // client, an extension injecting itself). The request still reaches the real BFF route; only its body is replaced.
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await route.continue({ postData: huge })
    })
    const typed = `Ordinary comment ${stamp}`
    const composer = rootComposer(section)
    const field = composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true })
    await field.fill(typed)
    const response = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === path && candidate.request().method() === 'POST',
    )
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()
    // It is the BFF's 413: the backend's 400 also leads to the same length sentence, and must not count as a pass.
    const answered = await response
    expect(answered.status()).toBe(413)
    expect(((await answered.json()) as { error?: { code?: string } }).error?.code).toBe('PAYLOAD_TOO_LARGE')
    await expect(composer.getByRole('alert')).toHaveText(COMMENT_TEXT.invalidLength)
    await expect(field).toHaveValue(typed)

    const threads = await allThreads((after) => alice.comments(slug, after))
    const saved = threads
      .flatMap((thread) => [thread.comment, ...thread.replies])
      .filter((comment) => comment.content?.includes(String(stamp)))
    expect(saved, 'no comment of this attempt was saved').toEqual([])
  })

  test('double-clicking "Post comment": exactly one request, exactly one comment', async ({ page, backend, reader }) => {
    const { slug } = tempPost()
    const login = reader('alice')
    const name = nameOf(login)
    await page.goto(localePath(`/posts/${slug}`))
    await loginWithGitHub(page, login)
    const section = await openComments(page, { signedIn: true })
    const path = `/api/posts/${slug}/comments`

    // Hold the POST until the test has checked the "sending" state: the second click surely lands while the
    // request is pending, regardless of whether the machine is fast or slow.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const posted: string[] = []
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      posted.push(route.request().postData() ?? '')
      await held
      await route.continue()
    })

    const text = `Double click ${Date.now()}`
    const composer = rootComposer(section)
    const field = composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true })
    const submit = composer.locator('button[type="submit"]')
    await field.fill(text)
    await submit.dblclick()
    await expect(submit).toHaveText(msg('Site.profile.author.form.sending'))
    await expect(submit).toHaveAttribute('aria-disabled', 'true')
    await expect(field).toHaveAttribute('readonly', '')
    // Add one more click while pending. The button is only `aria-disabled` (to keep focus), so the browser still delivers
    // the click: the app must drop it itself. `force`: Playwright treats aria-disabled as not clickable.
    await submit.click({ force: true })
    expect(posted, 'POST request while waiting').toHaveLength(1)
    release()

    await expect(commentArticle(section, name, text)).toHaveCount(1)
    await expect(submit).toHaveText(msg('Site.comments.rootForm.submit'))
    expect(posted, 'POST request after all three clicks').toHaveLength(1)
    const rows = await (await backend.asAdmin()).adminComments({ q: text })
    expect(rows.map((row) => row.content)).toEqual([text])
  })

  test('"Show more comments" right after posting: the next page carries that very comment without showing it twice; focus goes to the first root of each new page', async ({
    page,
    backend,
    reader,
  }) => {
    test.setTimeout(120_000)
    const { slug } = tempPost()
    const login = reader('alice')
    const name = nameOf(login)
    const stamp = Date.now()
    // At least 11 roots when the page opens: the first page (10 roots) surely still has a cursor. Only build what is missing —
    // earlier tests left a few roots; after the worker restarts (a failed test), the temporary post is empty.
    const bob = backend.asUser(seederToken('bob'))
    const mallory = backend.asUser(seederToken('mallory'))
    const existing = (await allThreads((after) => backend.comments(slug, after))).length
    for (let index = 1; index <= 11 - existing; index += 1) {
      await (index % 2 === 0 ? mallory : bob).addComment(slug, `Root for pagination ${stamp} number ${index}`)
    }

    await page.goto(localePath(`/posts/${slug}`))
    const alice = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    const section = await openComments(page, { signedIn: true })
    const roots = section.locator(':scope > ol > li > article')
    const more = section.getByRole('button', { name: COMMENT_TEXT.more, exact: true })
    await expect(roots).toHaveCount(10)
    await expect(more).toBeVisible()

    // The newest comment belongs to the next page on the server; on screen it shows immediately, at the end of the list.
    const text = `Posted between two pages ${stamp}`
    const composer = rootComposer(section)
    await composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true }).fill(text)
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()
    const mine = commentArticle(section, name, text)
    await expect(mine).toBeVisible()
    await expect(roots).toHaveCount(11)
    const mineId = await mine.getAttribute('data-comment-id')
    expect((await commentIds(section)).at(-1)).toBe(mineId)

    const loaded: CommentPage[] = []
    for (let round = 0; round < 20 && (await more.count()) > 0; round += 1) {
      const response = page.waitForResponse(
        (candidate) => candidate.request().method() === 'GET' && isCommentPageRequest(candidate.url(), true),
      )
      await more.click()
      const next = ((await (await response).json()) as { data: CommentPage }).data
      loaded.push(next)
      const first = next.threads[0]
      if (first) await expect(section.locator(`article[data-comment-id="${first.comment.id}"]`)).toBeFocused()
      await expect(section.locator('ol[aria-busy="true"]')).toHaveCount(0)
    }

    expect(loaded.length, 'number of extra pages loaded').toBeGreaterThan(0)
    expect(
      loaded.some((next) => next.threads.some((thread) => thread.comment.id === mineId)),
      'a later page carries the comment just posted',
    ).toBe(true)
    await expect(more).toHaveCount(0)
    await expect(commentArticle(section, name, text)).toHaveCount(1)
    const ids = await commentIds(section)
    expect(new Set(ids).size, 'duplicate id on the page').toBe(ids.length)
    // Exactly the server's roots, in the server's order: the comment just posted is back in its place.
    const shownRoots = await roots.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-comment-id')))
    expect(shownRoots).toEqual((await allThreads((after) => alice.comments(slug, after))).map((thread) => thread.comment.id))
  })

  test('keyboard: focus after posting, opening and cancelling a reply, replying, deleting', async ({ page, backend, reader }) => {
    const { slug } = tempPost()
    const login = reader('alice')
    const name = nameOf(login)
    const stamp = Date.now()
    // A comment that surely comes before the one about to be posted: the focus target when deleting the last one in the list.
    const before = await backend.asUser(seederToken('bob')).addComment(slug, `Comment standing before ${stamp}`)
    await page.goto(localePath(`/posts/${slug}`))
    await loginWithGitHub(page, login)
    const section = await openComments(page, { signedIn: true, all: true })
    const keyboard = page.keyboard

    // Post: type, Tab to "Post comment", Enter → focus is on the comment just posted.
    const rootText = `Posted by keyboard ${stamp}`
    const composer = rootComposer(section)
    await composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true }).focus()
    await keyboard.type(rootText)
    await keyboard.press('Tab')
    await expect(composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true })).toBeFocused()
    await keyboard.press('Enter')
    const root = commentArticle(section, name, rootText)
    await expect(root).toBeFocused()

    // Reply: Enter opens the form with focus in the box; Escape closes it, focus returns to "Reply".
    const replyButton = root.getByRole('button', { name: msg('Site.comments.item.reply'), exact: true })
    await replyButton.focus()
    await keyboard.press('Enter')
    const replyField = section.getByLabel(COMMENT_TEXT.replyLabel, { exact: true })
    await expect(replyField).toBeFocused()
    await keyboard.type('text to be discarded')
    await keyboard.press('Escape')
    await expect(replyField).toHaveCount(0)
    await expect(replyButton).toBeFocused()
    await expect(replyButton).toHaveAttribute('aria-expanded', 'false')

    // Reopening is a fresh form; type, Tab to "Post reply" (then back to the box), and send with Ctrl/⌘+Enter right in
    // the box → focus is on the reply just posted, exactly as when sending with the button.
    await keyboard.press('Enter')
    await expect(replyField).toBeFocused()
    await expect(replyField).toHaveValue('')
    await expect(replyField).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')
    const replyText = `Reply by keyboard ${stamp}`
    await keyboard.type(replyText)
    await keyboard.press('Tab')
    await expect(section.getByRole('button', { name: msg('Site.comments.replyForm.submit'), exact: true })).toBeFocused()
    await keyboard.press('Shift+Tab')
    await expect(replyField).toBeFocused()
    await keyboard.press('ControlOrMeta+Enter')
    const reply = commentArticle(section, name, replyText)
    await expect(reply).toBeFocused()
    // One send, one reply.
    await expect(commentArticle(section, name, replyText)).toHaveCount(1)

    // Delete the reply: Enter opens the confirmation, focus on "Cancel"; Escape cancels, focus returns to "Delete"; next time Shift+Tab goes to
    // the confirmation's "Delete", Enter.
    const deleteReply = reply.getByRole('button', { name: msg('Site.comments.item.delete'), exact: true })
    await deleteReply.focus()
    await keyboard.press('Enter')
    const confirm = reply.getByRole('group', { name: msg('Site.comments.item.deleteConfirm') })
    await expect(confirm.getByRole('button', { name: msg('Site.comments.form.cancel'), exact: true })).toBeFocused()
    await keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(deleteReply).toBeFocused()
    await keyboard.press('Enter')
    await expect(confirm.getByRole('button', { name: msg('Site.comments.form.cancel'), exact: true })).toBeFocused()
    await keyboard.press('Shift+Tab')
    await expect(confirm.getByRole('button', { name: msg('Site.comments.item.delete'), exact: true })).toBeFocused()
    await keyboard.press('Enter')
    await expect(reply).toHaveCount(0)
    await expect(section.getByRole('status')).toHaveText(msg('Site.comments.announce.deleted'))
    // The last reply of a thread has no next comment: focus returns to the comment right before it, the root itself.
    await expect(root).toBeFocused()

    // Delete the root (now with no replies): focus goes to the next comment on the page, and if there is none, the one right
    // before. This root was posted last so it is at the end: there is no next one.
    const ids = await commentIds(section)
    const index = ids.indexOf((await root.getAttribute('data-comment-id')) ?? '')
    expect(index, 'the root just posted is last in the list').toBe(ids.length - 1)
    expect(ids.indexOf(before.id), 'the seeded comment stands before it').toBeGreaterThan(-1)
    expect(ids.indexOf(before.id)).toBeLessThan(index)
    await root.getByRole('button', { name: msg('Site.comments.item.delete'), exact: true }).focus()
    await keyboard.press('Enter')
    await keyboard.press('Shift+Tab')
    await keyboard.press('Enter')
    await expect(root).toHaveCount(0)
    await expect(section.locator(`article[data-comment-id="${ids[index - 1]}"]`)).toBeFocused()
  })

  test('leading whitespace of a pasted code snippet is preserved', async ({ page, backend, reader }) => {
    const { slug } = tempPost()
    const login = reader('mallory')
    const name = nameOf(login)
    const stamp = Date.now()
    const tab = String.fromCharCode(9)
    const firstLine = `Code snippet ${stamp}:`
    const code = [firstLine, '    if (ok) {', '        return 1', '    }', `${tab}indented with a tab`].join('\n')

    await page.goto(localePath(`/posts/${slug}`))
    const author = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    const section = await openComments(page, { signedIn: true })
    const composer = rootComposer(section)
    await composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true }).fill(code)
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()

    // innerText follows CSS `white-space`: with `normal` all leading whitespace would collapse away.
    const rendered = (article: Locator) =>
      commentBody(article, firstLine).evaluate((node) => ({
        text: (node as HTMLElement).innerText,
        whiteSpace: getComputedStyle(node).whiteSpace,
      }))
    expect(await rendered(commentArticle(section, name, firstLine))).toEqual({ text: code, whiteSpace: 'pre-wrap' })
    expect(findComment(await allThreads((after) => author.comments(slug, after)), code)?.content).toBe(code)

    await page.reload()
    const again = await openComments(page, { signedIn: true, all: true })
    expect(await rendered(commentArticle(again, name, firstLine))).toEqual({ text: code, whiteSpace: 'pre-wrap' })
  })

  test('the session is lost while writing a reply (signed out in another tab): signing in again reopens the reply box under the right root, with the full text, sendable at once', async ({
    page,
    backend,
    reader,
  }, testInfo) => {
    const { slug } = tempPost()
    const login = reader('alice')
    const stamp = Date.now()
    const rootText = `Root waiting for a reply when the session is lost ${stamp}`
    const replyText = `Half-written reply when the session is lost ${stamp}`
    const bobName = nameOf(readerLogin('bob', testInfo.project.name))
    await backend.asUser(seederToken('bob')).addComment(slug, rootText)

    await page.goto(localePath(`/posts/${slug}`))
    const alice = backend.asUser((await loginWithGitHub(page, login)).accessToken)
    let section = await openComments(page, { signedIn: true, all: true })
    await commentArticle(section, bobName, rootText)
      .getByRole('button', { name: msg('Site.comments.item.reply'), exact: true })
      .click()
    await section.getByLabel(COMMENT_TEXT.replyLabel, { exact: true }).fill(replyText)

    // Sign out in another tab of the same browser: the session cookie of the whole browser is lost with it.
    await page.context().clearCookies()
    await section.getByRole('button', { name: msg('Site.comments.replyForm.submit'), exact: true }).click()

    // 401: the whole section returns to the guest UI, the reply box goes with it; the session-expired sentence and the sign-in invitation show.
    const cta = commentLoginLink(section)
    await expect(cta).toBeVisible()
    await expect(section.getByRole('alert')).toContainText(msg('Errors.interaction.sessionExpired'))
    await expect(section.getByLabel(COMMENT_TEXT.replyLabel, { exact: true })).toHaveCount(0)

    // Sign in again from the invitation itself: the reply box reopens under the right root, with the text already written, and has focus.
    await loginWithGitHub(page, login, { via: cta, returnTo: localePath(`/posts/${slug}#binh-luan`) })
    section = await openComments(page, { signedIn: true, all: true })
    const thread = threadItems(section).filter({ has: commentArticle(page, bobName, rootText) })
    const box = thread.getByLabel(COMMENT_TEXT.replyLabel, { exact: true })
    await expect(box).toHaveValue(replyText)
    await expect(box).toBeFocused()

    await thread.getByRole('button', { name: msg('Site.comments.replyForm.submit'), exact: true }).click()
    await expect(commentArticle(thread, nameOf(login), replyText)).toBeVisible()
    expect(findComment(await allThreads((after) => alice.comments(slug, after)), replyText)?.content).toBe(replyText)
  })

  test("the owner label: the admin's reply has it, a reader's comment does not — by the API's siteOwner flag", async ({
    page,
    backend,
  }, testInfo) => {
    const { slug } = tempPost()
    const stamp = Date.now()
    const readerText = `Reader asks the blog owner ${stamp}`
    const ownerText = `Blog owner replies ${stamp}`
    const root = await backend.asUser(seederToken('bob')).addComment(slug, readerText)
    const ownerReply = await (await backend.asAdmin()).reply(root.id, ownerText)

    // The flag is computed by the server (the seeded admin account is the site owner), not derived from the name: the API is the only source of the label.
    expect(root.author?.siteOwner, 'the reader is not the blog owner').toBe(false)
    expect(ownerReply.author?.siteOwner, 'the admin is the blog owner').toBe(true)

    await page.goto(localePath(`/posts/${slug}`))
    const section = await openComments(page, { signedIn: false, all: true })
    const ownerArticle = commentArticle(section, ownerReply.author!.displayName, ownerText)
    const readerArticle = commentArticle(section, nameOf(readerLogin('bob', testInfo.project.name)), readerText)
    await expect(ownerArticle.getByText(msg('Site.comments.item.ownerBadge'), { exact: true })).toBeVisible()
    await expect(readerArticle.getByText(msg('Site.comments.item.ownerBadge'), { exact: true })).toHaveCount(0)
    // The <article> name is still just the author name: the locator by name above already found it.
    await expect(ownerArticle).toHaveCount(1)
  })

  // Kept at the end of the file: spammer adds up to dozens of root comments to the shared temporary post.
  test('spammer sends in a burst: the backend returns 429 RATE_LIMITED, the form says "too fast" and keeps the text; the blocked attempt saves nothing', async ({
    page,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    const login = reader('spammer')
    const stamp = Date.now()
    await page.goto(localePath(`/posts/${slug}`))
    await loginWithGitHub(page, login)
    const section = await openComments(page, { signedIn: true })

    // Straight to the BFF route, the exact path the send button takes, one by one until one is not accepted. A cap of 60
    // is far above the QA stack's per-minute limit (the backend default is 5).
    const sent = await page.evaluate(
      async ({ path, stamp }) => {
        const results: { status: number; code: string | null }[] = []
        for (let index = 1; index <= 60; index += 1) {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: `Spam ${stamp} number ${index}` }),
          })
          const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
          results.push({ status: response.status, code: body?.error?.code ?? null })
          if (response.status !== 201) break
        }
        return results
      },
      { path: `/api/posts/${slug}/comments`, stamp },
    )
    const accepted = sent.length - 1
    expect(sent.at(-1), `attempt after ${accepted} accepted comments`).toEqual({ status: 429, code: 'RATE_LIMITED' })
    const admin = await backend.asAdmin()
    expect(await admin.adminComments({ q: `Spam ${stamp}`, size: 100 }), 'spam comments saved').toHaveLength(accepted)

    // Right after, through the form: the Vietnamese sentence, the text intact so it can be resent once the block ends.
    const text = `Spam through the form ${stamp}`
    const composer = rootComposer(section)
    const field = composer.getByLabel(COMMENT_TEXT.rootLabel, { exact: true })
    await field.fill(text)
    await composer.getByRole('button', { name: msg('Site.comments.rootForm.submit'), exact: true }).click()
    await expect(composer.getByRole('alert')).toHaveText(msg('Errors.interaction.byCode.RATE_LIMITED'))
    await expect(field).toHaveValue(text)
    await expect(commentArticle(section, nameOf(login), text)).toHaveCount(0)
    expect(await admin.adminComments({ q: text })).toEqual([])
  })
})
