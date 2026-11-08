import type { Locator, Page } from '@playwright/test'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from '../support/admin'
import { COMMENT_TEXT, allThreads, commentArticle, findComment, openComments } from '../support/comments'
import { expect, test } from '../support/fixtures'
import { mockUser, newUserContext, newVisitorContext, type SessionTokens } from '../support/github'
import { horizontalExtent, readSeo } from '../support/page'
import { msg } from '../support/i18n'

/**
 * Comment moderation at /admin/comments: hide, unhide, delete right in the row, search by author, open the related post,
 * noindex.
 *
 * Each admin action is checked from the side of a real reader: a guest opens the post in a separate context and no
 * longer sees (or sees again) that comment. Comments are built through the API, on a temporary post deleted in `afterAll`.
 * Each content carries `Date.now()`, and the admin page is opened with exactly that timestamp in the search box.
 *
 * The authors are two fake GitHub readers that no other spec uses for writing, `bigid` and `adminmail` (both
 * are USER; one real sign-in in `beforeAll`). The per-project readers (alice, bob...) already wrote a lot in
 * comments.spec.ts: the comment limit is counted per user and per minute, and two specs running back to back (or
 * --repeat-each) must not push them to 429.
 */

type Author = 'bigid' | 'adminmail'

const NAME_MARK = '\u0001'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A catalog message that carries rich-text tags (`<bdi>`, `<strong>`): the tags are dropped, only the text is kept. */
function plainMsg(key: string, args: Record<string, string> = {}): string {
  const keep = (chunks: unknown) => chunks
  return msg(key, { ...args, bdi: keep, strong: keep } as never)
}

/** The caption of the moderation table as a prefix pattern (up to the closing parenthesis, before the page numbers). */
function captionPattern(args: Record<string, string>): RegExp {
  const text = msg('Admin.comments.caption', { onPost: 'no', searched: 'no', page: 1, totalPages: 1, ...args })
  return new RegExp(`^${escapeRegExp(text.slice(0, text.lastIndexOf(')') + 1))}`)
}

/** The start of every moderation table caption, before the filter name. */
const CAPTION_START = msg('Admin.comments.caption', {
  filter: NAME_MARK,
  onPost: 'no',
  searched: 'no',
  page: 1,
  totalPages: 1,
}).split(NAME_MARK)[0]

/** The lower-cased filter name inside the caption, for the visible tab. */
const VISIBLE_FILTER = msg('Admin.comments.filters.visible').toLowerCase()

/** The accessible name of the delete confirmation group. */
const CONFIRM_DELETE = plainMsg('Admin.comments.table.confirmDelete')

/** The start of a row button's target text ("comment by <name>: ..."), before the author name. */
const TARGET_START = msg('Admin.comments.table.target', { name: NAME_MARK, excerpt: '' }).split(NAME_MARK)[0]

/** The moderation table: its accessible name is the sr-only caption "Comments (...), page x/y". */
function moderationTable(page: Page): Locator {
  return page.getByRole('table', { name: new RegExp(`^${escapeRegExp(CAPTION_START)}`) })
}

/** The row of one comment (the delete-confirmation row carries no content, so it is not mixed in). */
function commentRow(page: Page, content: string): Locator {
  return moderationTable(page).locator('tbody > tr').filter({ hasText: content })
}

/** The table's notice (`role="status"` is always present) when it says exactly this sentence. */
function notice(page: Page, text: string): Locator {
  return page.getByRole('status').filter({ hasText: text })
}

/** A row's button by the start of its accessible name (the verb, then "comment by <name>..."). */
function rowButton(row: Locator, verb: string): Locator {
  return row.getByRole('button', { name: new RegExp(`^${escapeRegExp(verb)} ${escapeRegExp(TARGET_START)}`) })
}

test.describe('Comment moderation (admin)', () => {
  let post: TemporaryPost | undefined
  let authors: Record<Author, SessionTokens> | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'moderation')
    const tokensOf = async (login: Author) => {
      const session = await newUserContext(browser, login, testInfo)
      await session.context.close()
      return session.tokens
    }
    authors = { bigid: await tokensOf('bigid'), adminmail: await tokensOf('adminmail') }
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  /** The temporary post of this spec; if `beforeAll` fails, every test stops here with a clear reason. */
  function tempPost(): TemporaryPost {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    return post
  }

  function tokenOf(login: Author): string {
    if (!authors) throw new Error('The comment authors are not signed in (beforeAll failed)')
    return authors[login].accessToken
  }

  /** The blog name shown for the author (the GitHub name after the backend sanitizes it). */
  function nameOf(login: Author): string {
    return mockUser(login).displayName!
  }

  test('hide: guests and the author themself no longer see the comment, a hidden root with replies becomes the "hidden" placeholder; unhiding shows it again', async ({
    adminPage: page,
    browser,
    backend,
  }, testInfo) => {
    const { slug } = tempPost()
    const writer = backend.asUser(tokenOf('bigid'))
    const writerName = nameOf('bigid')
    const otherName = nameOf('adminmail')
    const stamp = Date.now()
    const lone = `Comment that will be hidden ${stamp}`
    const rootText = `Root with a reply that will be hidden ${stamp}`
    const replyText = `Reply that stays visible when the root is hidden ${stamp}`
    await writer.addComment(slug, lone)
    const root = await backend.asUser(tokenOf('adminmail')).addComment(slug, rootText)
    await writer.reply(root.id, replyText)

    const visitor = await newVisitorContext(browser, testInfo)
    try {
      const guest = await visitor.newPage()
      const guestView = async () => {
        await guest.goto(`/posts/${slug}`)
        return openComments(guest, { signedIn: false, all: true })
      }
      let section = await guestView()
      await expect(commentArticle(section, writerName, lone)).toBeVisible()
      await expect(commentArticle(section, otherName, rootText)).toBeVisible()

      await page.goto(`/admin/comments?q=${stamp}`)
      const loneRow = commentRow(page, lone)
      const rootRow = commentRow(page, rootText)
      await expect(loneRow).toContainText(msg('Admin.statuses.comment.VISIBLE'))

      // Hide: the label changes in place, the notice says whose it is, focus moves to the undo button in place of the one that just vanished.
      await rowButton(loneRow, msg('Admin.comments.table.hide')).click()
      await expect(notice(page, plainMsg('Admin.comments.table.notice.hide', { name: writerName }))).toHaveCount(1)
      await expect(loneRow).toContainText(msg('Admin.statuses.comment.HIDDEN'))
      await expect(loneRow).not.toContainText(msg('Admin.statuses.comment.VISIBLE'))
      await expect(rowButton(loneRow, msg('Admin.comments.table.restore'))).toBeFocused()
      await rowButton(rootRow, msg('Admin.comments.table.hide')).click()
      await expect(notice(page, plainMsg('Admin.comments.table.notice.hide', { name: otherName }))).toHaveCount(1)
      await expect(rootRow).toContainText(msg('Admin.statuses.comment.HIDDEN'))
      const admin = await backend.asAdmin()
      const statuses = async () =>
        Object.fromEntries((await admin.adminComments({ q: String(stamp) })).map((row) => [row.content, row.status]))
      expect(await statuses()).toEqual({ [lone]: 'HIDDEN', [rootText]: 'HIDDEN', [replyText]: 'VISIBLE' })

      // Guest: a lone comment disappears entirely; a root with replies becomes a placeholder, the replies stay below it.
      section = await guestView()
      await expect(section.getByText(lone)).toHaveCount(0)
      await expect(section.getByText(rootText)).toHaveCount(0)
      const thread = section.locator(':scope > ol > li').filter({ has: commentArticle(guest, writerName, replyText) })
      await expect(thread.getByRole('article').first()).toHaveAccessibleName(COMMENT_TEXT.hidden)
      // The author also does not see their own hidden comment (not editable to dodge moderation).
      expect(findComment(await allThreads((after) => writer.comments(slug, after)), lone)).toBeUndefined()

      // Unhide both: the guest sees them again exactly as before.
      await rowButton(loneRow, msg('Admin.comments.table.restore')).click()
      await expect(notice(page, plainMsg('Admin.comments.table.notice.restore', { name: writerName }))).toHaveCount(1)
      await expect(rowButton(loneRow, msg('Admin.comments.table.hide'))).toBeFocused()
      await rowButton(rootRow, msg('Admin.comments.table.restore')).click()
      await expect(notice(page, plainMsg('Admin.comments.table.notice.restore', { name: otherName }))).toHaveCount(1)
      await expect(rootRow).toContainText(msg('Admin.statuses.comment.VISIBLE'))
      expect(await statuses()).toEqual({ [lone]: 'VISIBLE', [rootText]: 'VISIBLE', [replyText]: 'VISIBLE' })
      section = await guestView()
      await expect(commentArticle(section, writerName, lone)).toBeVisible()
      await expect(commentArticle(section, otherName, rootText)).toBeVisible()
      await expect(commentArticle(section, writerName, replyText)).toBeVisible()
    } finally {
      await visitor.close()
    }
  })

  test('delete: asks again in place, "Cancel" keeps everything; deleting removes it from the post, the content can still be looked up under "Deleted"', async ({
    adminPage: page,
    browser,
    backend,
  }, testInfo) => {
    const { slug } = tempPost()
    const writerName = nameOf('adminmail')
    const stamp = Date.now()
    const text = `Admin comment that will be deleted ${stamp}`
    await backend.asUser(tokenOf('adminmail')).addComment(slug, text)
    const admin = await backend.asAdmin()
    const status = async () => (await admin.adminComments({ q: text })).map((row) => row.status)

    await page.goto(`/admin/comments?q=${stamp}`)
    const row = commentRow(page, text)
    const remove = rowButton(row, msg('Admin.posts.row.delete'))
    const confirm = page.getByRole('group', { name: CONFIRM_DELETE })

    // Cancel: nothing changes, focus returns to the button that opened the confirmation.
    await remove.click()
    await expect(confirm.getByRole('button', { name: msg('Admin.posts.delete.cancel'), exact: true })).toBeFocused()
    await confirm.getByRole('button', { name: msg('Admin.posts.delete.cancel'), exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(remove).toBeFocused()
    expect(await status()).toEqual(['VISIBLE'])

    // Real delete: the "Deleted" label, the row has no button left, focus returns to that row itself.
    await remove.click()
    await confirm.getByRole('button', { name: msg('Admin.posts.row.delete'), exact: true }).click()
    await expect(notice(page, plainMsg('Admin.comments.table.notice.delete', { name: writerName }))).toHaveCount(1)
    await expect(row).toContainText(msg('Admin.statuses.comment.DELETED'))
    await expect(row.getByRole('button')).toHaveCount(0)
    await expect(row.locator('td').first()).toBeFocused()
    expect(await status()).toEqual(['DELETED'])

    // Reader: it is nowhere any more.
    expect(findComment(await allThreads((after) => backend.comments(slug, after)), text)).toBeUndefined()
    const visitor = await newVisitorContext(browser, testInfo)
    try {
      const guest = await visitor.newPage()
      await guest.goto(`/posts/${slug}`)
      const section = await openComments(guest, { signedIn: false, all: true })
      await expect(section.getByText(text)).toHaveCount(0)
    } finally {
      await visitor.close()
    }

    // The "Deleted" tab (keeping the search box): the content is still here for lookup.
    await page
      .getByRole('navigation', { name: msg('Admin.comments.statusNav') })
      .getByRole('link', { name: msg('Admin.statuses.comment.DELETED') })
      .click()
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('status') === 'deleted' && url.searchParams.get('q') === String(stamp),
    )
    await expect(commentRow(page, text)).toContainText(msg('Admin.statuses.comment.DELETED'))
  })

  test('search by GitHub login: only comments by that person; content with HTML shows as text', async ({
    adminPage: page,
    backend,
  }) => {
    const { slug } = tempPost()
    const login: Author = 'bigid'
    const stamp = Date.now()
    const mark = `Comment by the person to find ${stamp}`
    const xss = `<img src="x" onerror="window.__xss = 'admin'"> ${mark}`
    const otherText = `Someone else who must not show up in the results ${stamp}`
    await backend.asUser(tokenOf('bigid')).addComment(slug, xss)
    await backend.asUser(tokenOf('adminmail')).addComment(slug, otherText)

    await page.goto('/admin/comments')
    await page.getByLabel(msg('Admin.comments.searchLabel')).fill(login)
    await page.getByRole('button', { name: msg('Admin.comments.search'), exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/admin/comments' && url.searchParams.get('q') === login)
    // Pinned on purpose: the default tab is "Visible", no longer "All".
    const table = page.getByRole('table', { name: captionPattern({ filter: VISIBLE_FILTER, searched: 'yes', query: login }) })
    const rows = table.locator('tbody > tr')
    await expect(rows.filter({ hasText: mark })).toHaveCount(1)
    await expect(rows.filter({ hasText: otherText })).toHaveCount(0)
    const count = await rows.count()
    for (let index = 0; index < count; index += 1) {
      await expect(rows.nth(index), `row ${index + 1}`).toContainText(`@${login}`)
    }

    // Plain text: no element is built from the content, no code runs.
    const content = rows.filter({ hasText: mark }).getByText(xss, { exact: true })
    expect(await content.evaluate((node) => node.childElementCount)).toBe(0)
    await expect(table.locator('img[src="x"]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as Window & { __xss?: unknown }).__xss)).toBeUndefined()

    // Clear the search with the chip: back to the full list.
    await page
      .getByRole('link', {
        name: `${msg('Admin.comments.chip.query', { query: login })} ${msg('Admin.comments.chip.removeQuery')}`,
      })
      .click()
    await expect(page).toHaveURL(/\/admin\/comments$/)
    await expect(page.getByLabel(msg('Admin.comments.searchLabel'))).toHaveValue('')
  })

  test('"View post": opens the post in a new tab, at the comment section, with that comment', async ({
    adminPage: page,
    backend,
  }) => {
    const { slug, title } = tempPost()
    const stamp = Date.now()
    const text = `Comment used to open the post from admin ${stamp}`
    await backend.asUser(tokenOf('bigid')).addComment(slug, text)

    await page.goto(`/admin/comments?q=${stamp}`)
    // One link per row: the "Post" column from xl, a secondary line under the content on narrower screens.
    const link = commentRow(page, text).getByRole('link', {
      name: `${title} ${msg('Admin.comments.table.viewCommentsSr')}`,
      exact: true,
    })
    await expect(link).toHaveAttribute('href', `/posts/${slug}#binh-luan`)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    const popup = page.waitForEvent('popup')
    await link.click()
    const opened = await popup
    await opened.waitForLoadState()
    const url = new URL(opened.url())
    expect(`${url.pathname}${url.hash}`).toBe(`/posts/${slug}#binh-luan`)
    await expect(opened.getByRole('heading', { level: 1, name: title })).toBeVisible()
    // The browser scrolls to the comment section (target `#binh-luan`) before the test scrolls anything.
    await expect(opened.locator('#binh-luan')).toBeInViewport()
    const section = await openComments(opened, { all: true })
    await expect(commentArticle(section, nameOf('bigid'), text)).toBeVisible()
    await opened.close()
  })

  test('filter by post: "Only this post comments" from a row, the "Post: ..." chip can be removed; the author name leads to the Users page', async ({
    adminPage: page,
    backend,
  }) => {
    const { id, slug, title } = tempPost()
    const login: Author = 'bigid'
    const stamp = Date.now()
    const text = `Comment used to filter by post ${stamp}`
    await backend.asUser(tokenOf(login)).addComment(slug, text)

    await page.goto(`/admin/comments?q=${stamp}`)
    await commentRow(page, text)
      .getByRole('link', {
        name: `${msg('Admin.comments.table.onlyThisPost')} ${msg('Admin.comments.table.onlyThisPostSr', { title })}`,
        exact: true,
      })
      .click()
    // Keep the status tab being viewed (the default), drop the search box: within one post the whole conversation is needed.
    await expect(page).toHaveURL((url) => url.searchParams.get('post') === id && !url.searchParams.has('q'))
    const chip = page.getByRole('link', {
      name: `${msg('Admin.comments.chip.post', { title })} ${msg('Admin.comments.chip.removePost')}`,
      exact: true,
    })
    await expect(chip).toBeVisible()
    await expect(moderationTable(page)).toHaveAccessibleName(
      captionPattern({ filter: VISIBLE_FILTER, onPost: 'yes', postTitle: title }),
    )
    // Every row is a comment of that post: the post link in EVERY row (including the variant hidden by screen size) points to the right slug.
    await expect(commentRow(page, text)).toBeVisible()
    const postHrefs = await moderationTable(page)
      .locator('a[href^="/posts/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
    expect(postHrefs.length).toBeGreaterThan(0)
    expect(new Set(postHrefs)).toEqual(new Set([`/posts/${slug}#binh-luan`]))

    // Author name: goes to the Users page, searching for exactly that person.
    await commentRow(page, text)
      .getByRole('link', { name: `${nameOf(login)} ${msg('Admin.comments.table.usersPageSr')}`, exact: true })
      .click()
    await expect(page).toHaveURL((url) => url.pathname === '/admin/users' && url.searchParams.get('q') === login)
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.users') })).toBeVisible()
    await expect(page.getByText(`@${login}`).first()).toBeVisible()

    // Remove the chip: back to the list of all posts.
    await page.goBack()
    await chip.click()
    await expect(page).toHaveURL((url) => url.pathname === '/admin/comments' && !url.searchParams.has('post'))
  })

  // admin/navigation.spec.ts measures /admin/comments with the existing data, usually an empty list (comments
  // live only on the temporary post): here the table has real rows, with a long URL that cannot wrap.
  test('the moderation table does not overflow horizontally, even with a long URL and with the delete confirmation open', async ({
    adminPage: page,
    backend,
    isMobile,
  }) => {
    const { slug } = tempPost()
    const stamp = Date.now()
    const long = `Long URL ${stamp} https://example.com/${'duong-dan-rat-dai-'.repeat(12)}?q=${'x'.repeat(80)}`
    await backend.asUser(tokenOf('adminmail')).addComment(slug, long)

    for (const width of isMobile ? [320, 390] : [1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`/admin/comments?q=${stamp}`)
      const row = commentRow(page, long)
      await expect(row).toBeVisible()
      let extent = await horizontalExtent(page)
      expect.soft(extent.scrollWidth, `table @${width}px overflows horizontally`).toBeLessThanOrEqual(extent.clientWidth)

      await rowButton(row, msg('Admin.posts.row.delete')).click()
      const confirm = page.getByRole('group', { name: CONFIRM_DELETE })
      await expect(confirm).toBeVisible()
      extent = await horizontalExtent(page)
      expect
        .soft(extent.scrollWidth, `delete confirmation @${width}px overflows horizontally`)
        .toBeLessThanOrEqual(extent.clientWidth)
      await confirm.getByRole('button', { name: msg('Admin.posts.delete.cancel'), exact: true }).click()
      await expect(confirm).toHaveCount(0)
    }
  })

  test('Comments and Users pages: noindex; four status tabs with the right URLs; the "Comments" entry is highlighted in the nav', async ({
    adminPage: page,
    isMobile,
  }) => {
    for (const [path, heading] of [
      ['/admin/users', msg('Admin.shell.nav.users')],
      ['/admin/comments', msg('Admin.editor.commentsHeading')],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      const seo = await readSeo(page)
      expect(seo.robots, path).toBe('noindex, nofollow')
      expect(seo.counts.robots, path).toBe(1)
    }

    // Pinned on purpose: the bare URL is the "Visible" tab (what readers currently see); "All"
    // has its own URL ?status=all. The order of the four tabs stays as designed.
    const tabs = page.getByRole('navigation', { name: msg('Admin.comments.statusNav') })
    await expect(tabs.getByRole('link')).toHaveText([
      msg('Admin.dashboard.filters.all'),
      msg('Admin.statuses.comment.VISIBLE'),
      msg('Admin.statuses.comment.HIDDEN'),
      msg('Admin.statuses.comment.DELETED'),
    ])
    const hrefs = await tabs.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))
    expect(hrefs).toEqual([
      '/admin/comments?status=all',
      '/admin/comments',
      '/admin/comments?status=hidden',
      '/admin/comments?status=deleted',
    ])
    await expect(tabs.locator('[aria-current="page"]')).toHaveText([msg('Admin.statuses.comment.VISIBLE')])
    await tabs.getByRole('link', { name: msg('Admin.statuses.comment.HIDDEN') }).click()
    await expect(page).toHaveURL(/\/admin\/comments\?status=hidden$/)
    await expect(tabs.locator('[aria-current="page"]')).toHaveText([msg('Admin.statuses.comment.HIDDEN')])

    // Below lg the nav sits behind the "Menu" button.
    if (isMobile) await page.getByRole('button', { name: 'Menu' }).click()
    const nav = page.getByRole('list', { name: msg('Admin.shell.sectionsLabel') })
    await expect(nav.getByRole('link', { name: msg('Admin.editor.commentsHeading') })).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
  })
})
