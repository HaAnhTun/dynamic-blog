import type { Locator, Page } from '@playwright/test'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from '../support/admin'
import { expect, test } from '../support/fixtures'
import { clickThrough, headerLoginLink, loginWithGitHub, mockUser, sessionOf, setMockUser } from '../support/github'
import { msg } from '../support/i18n'
import { SESSION_COOKIES } from '../support/session-cookies'

/**
 * The admin Users page: search and filter, no button on an ADMIN row, and suspending a reader really takes effect on
 * the reader side: on the next page load they become a guest, every write with the old token is blocked, and
 * signing in again is rejected,
 * until they are unsuspended.
 *
 * The suspended user is `carol-<project>`, used by this spec only; `finally` always unsuspends, even if the test
 * breaks midway, so the shared stack does not keep a suspended reader. The like and comment attempts go into
 * a temporary post (deleted in `afterAll`), never into a sample post.
 */

const NAME_MARK = '\u0001'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A catalog message that carries rich-text tags (`<bdi>`, `<strong>`): the tags are dropped, only the text is kept. */
function plainMsg(key: string, args: Record<string, string> = {}): string {
  const keep = (chunks: unknown) => chunks
  return msg(key, { ...args, bdi: keep, strong: keep } as never)
}

/** The start of the like button's accessible name (before the count), for a signed-in reader and for a guest. */
const LIKE_START = new RegExp(`^${escapeRegExp(msg('Site.like.ariaLabel', { count: NAME_MARK, n: 0 }).split(NAME_MARK)[0])}`)
const GUEST_LIKE_START = new RegExp(
  `^${escapeRegExp(msg('Site.like.guestAriaLabel', { count: NAME_MARK, n: 0 }).split(NAME_MARK)[0])}`,
)

/** The start of the users table caption, before the role filter. */
const CAPTION_START = msg('Admin.users.caption', {
  role: NAME_MARK,
  status: '',
  searched: 'no',
  page: 1,
  totalPages: 1,
}).split(NAME_MARK)[0]

/** A row's suspend or unsuspend button name: the verb, then the "@login" handle. */
function handleButton(verbKey: string, login: string): string {
  return `${msg(verbKey)} @${login}`
}

/** The users table: its accessible name is the sr-only caption "Users (...), page x/y". */
function usersTable(page: Page): Locator {
  return page.getByRole('table', { name: new RegExp(`^${escapeRegExp(CAPTION_START)}`) })
}

/** The data rows of the table (excluding the header row). */
function dataRows(table: Locator): Locator {
  return table.locator('tbody > tr')
}

/** The choices of the two filter boxes, exactly as the user sees the text, and the value each sends to the URL (empty means "all..."). */
const ROLE: Record<string, string> = {
  [msg('Admin.statuses.filter.anyRole')]: '',
  [msg('Admin.statuses.role.USER')]: 'user',
  [msg('Admin.statuses.role.ADMIN')]: 'admin',
}
const STATUS: Record<string, string> = {
  [msg('Admin.statuses.filter.anyStatus')]: '',
  [msg('Admin.statuses.user.ACTIVE')]: 'active',
  [msg('Admin.statuses.user.SUSPENDED')]: 'suspended',
}

/**
 * Filter with the toolbar (a GET form usually sends all three fields, even the empty one), then wait for the page to have ALL three new
 * parameters: waiting on `q` alone makes a second filter with the same search box return immediately on the old page.
 */
async function filterUsers(
  page: Page,
  { query = '', role, status }: { query?: string; role: keyof typeof ROLE; status: keyof typeof STATUS },
): Promise<void> {
  await page.getByLabel(msg('Admin.users.searchLabel')).fill(query)
  await page.getByLabel(msg('Admin.users.roleLabel'), { exact: true }).selectOption({ label: role })
  await page.getByLabel(msg('Admin.dashboard.table.status'), { exact: true }).selectOption({ label: status })
  await page.getByRole('button', { name: msg('Admin.dashboard.toolbar.filter'), exact: true }).click()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/admin/users' &&
      url.searchParams.get('q') === query &&
      url.searchParams.get('role') === ROLE[role] &&
      url.searchParams.get('status') === STATUS[status],
  )
}

function pathAndQuery(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

test.describe('Users (admin)', () => {
  let post: TemporaryPost | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'users')
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  test('search by login, filter by role and status; an ADMIN row has no suspend button', async ({
    adminPage: page,
    userContext,
    reader,
    isMobile,
  }) => {
    const login = reader('alice')
    const user = mockUser(login)
    // This reader certainly has an account, just signed in.
    await userContext(login)

    await page.goto('/admin/users')
    await expect(page.getByRole('heading', { level: 1, name: msg('Admin.shell.nav.users') })).toBeVisible()
    if (isMobile) await page.getByRole('button', { name: 'Menu' }).click()
    await expect(
      page
        .getByRole('list', { name: msg('Admin.shell.sectionsLabel') })
        .getByRole('link', { name: msg('Admin.shell.nav.users') }),
    ).toHaveAttribute('aria-current', 'page')
    const table = usersTable(page)
    await expect(table).toBeVisible()

    // Search by login: exactly one row, of exactly that person.
    await filterUsers(page, {
      query: login,
      role: msg('Admin.statuses.filter.anyRole'),
      status: msg('Admin.statuses.filter.anyStatus'),
    })
    const found = dataRows(table)
    await expect(found).toHaveCount(1)
    await expect(found).toContainText(user.displayName!)
    await expect(found).toContainText(`@${login}`)
    await expect(found).toContainText(msg('Admin.statuses.role.USER'))
    await expect(found).toContainText(msg('Admin.statuses.user.ACTIVE'))
    await expect(found.getByRole('button', { name: handleButton('Admin.users.table.suspend', login), exact: true })).toBeVisible()

    // Admin: only the ADMIN row, and no row has a suspend or unsuspend button. The row of the person
    // currently signed in carries the label "You". Pinned on purpose: another admin has a "Change role" button, so only the
    // suspend and unsuspend buttons are counted.
    await filterUsers(page, { role: msg('Admin.shell.navLabel'), status: msg('Admin.statuses.filter.anyStatus') })
    const admins = dataRows(table)
    await expect(admins.first()).toBeVisible()
    const adminCount = await admins.count()
    for (let index = 0; index < adminCount; index += 1) {
      await expect(admins.nth(index)).toContainText(msg('Admin.shell.navLabel'))
      await expect(admins.nth(index)).not.toContainText(msg('Admin.statuses.role.USER'))
    }
    await expect(
      table.getByRole('button', {
        name: new RegExp(
          `^(${escapeRegExp(msg('Admin.users.table.suspend'))}|${escapeRegExp(msg('Admin.users.table.unsuspend'))}) `,
        ),
      }),
    ).toHaveCount(0)
    await expect(admins.filter({ hasText: msg('Admin.users.table.you') })).toHaveCount(1)

    // Active readers: every row has the right role and status, each row has one "Suspend" button.
    await filterUsers(page, { role: msg('Admin.statuses.role.USER'), status: msg('Admin.statuses.user.ACTIVE') })
    const readers = dataRows(table)
    await expect(readers.filter({ hasText: `@${login}` })).toHaveCount(1)
    const readerCount = await readers.count()
    for (let index = 0; index < readerCount; index += 1) {
      const row = readers.nth(index)
      await expect(row).toContainText(msg('Admin.statuses.role.USER'))
      await expect(row).toContainText(msg('Admin.statuses.user.ACTIVE'))
      await expect(
        row.getByRole('button', { name: new RegExp(`^${escapeRegExp(msg('Admin.users.table.suspend'))} @`) }),
      ).toHaveCount(1)
    }
  })

  test('suspending carol: the old page cannot like, on the next load carol is a guest, the old token is blocked, signing in again is rejected; unsuspending lets them in again', async ({
    adminPage: page,
    backend,
    userContext,
    reader,
  }) => {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    const { slug } = post
    const login = reader('carol')
    const carol = await userContext(login, { path: `/posts/${slug}` })
    const admin = await backend.asAdmin()
    const carolId = (await backend.asUser(carol.tokens.accessToken).me()).id
    const like = carol.page.getByRole('button', { name: LIKE_START })
    await expect(like).toHaveAttribute('aria-pressed', 'false')

    try {
      // The admin suspends carol, through the in-place confirmation step.
      await page.goto(`/admin/users?q=${encodeURIComponent(login)}`)
      const table = usersTable(page)
      const row = dataRows(table).filter({ hasText: `@${login}` })
      await expect(row).toContainText(msg('Admin.statuses.user.ACTIVE'))
      await row.getByRole('button', { name: handleButton('Admin.users.table.suspend', login), exact: true }).click()
      const confirm = page.getByRole('group', {
        name: new RegExp(`^${escapeRegExp(plainMsg('Admin.users.table.confirmSuspend', { handle: `@${login}` }))}`),
      })
      await expect(confirm.getByRole('button', { name: msg('Admin.posts.delete.cancel') })).toBeFocused()
      await confirm.getByRole('button', { name: msg('Admin.users.table.suspend'), exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: plainMsg('Admin.users.table.notice.suspended', { handle: `@${login}` }) }),
      ).toHaveCount(1)
      await expect(row).toContainText(msg('Admin.statuses.user.SUSPENDED'))
      await expect(
        row.getByRole('button', { name: handleButton('Admin.users.table.unsuspend', login), exact: true }),
      ).toBeFocused()
      expect((await admin.adminUsers({ q: login })).map((user) => user.status)).toEqual(['SUSPENDED'])

      // The "Suspended" filter has carol.
      await page.goto('/admin/users?status=suspended')
      await expect(dataRows(table).filter({ hasText: `@${login}` })).toContainText(msg('Admin.statuses.user.SUSPENDED'))

      // The page carol already had open: the suspension revoked her access token, so clicking like is refused with 401,
      // the refresh is refused too, and the session ends on the spot: the header becomes the guest header and nothing is liked.
      await like.click()
      await expect(headerLoginLink(carol.page)).toBeVisible()
      await expect(carol.page.getByRole('button', { name: LIKE_START })).toHaveCount(0)

      // The next page load: /api/session clears the session, the header becomes the guest header, the like button becomes a sign-in invitation.
      await carol.page.reload()
      await expect(headerLoginLink(carol.page)).toBeVisible()
      expect(await sessionOf(carol.page)).toBeNull()
      const sessionCookies = (await carol.context.cookies())
        .filter((cookie) => SESSION_COOKIES.includes(cookie.name))
        .map((cookie) => cookie.name)
      expect(sessionCookies, 'carol session cookies after the suspension').toEqual([])
      const cta = carol.page.getByRole('link', { name: GUEST_LIKE_START })
      await expect(cta).toBeVisible()
      await expect(cta).toHaveAttribute(
        'href',
        `/api/auth/github/start?returnTo=${encodeURIComponent(`/posts/${slug}#luot-thich`)}`,
      )
      await expect(carol.page.getByRole('button', { name: LIKE_START })).toHaveCount(0)

      // Carol's old access token is revoked by the suspension and can write nothing, and refresh cannot rotate.
      const stale = backend.asUser(carol.tokens.accessToken)
      for (const [method, path, body] of [
        ['PUT', `/api/v1/posts/${slug}/like`, undefined],
        ['POST', `/api/v1/posts/${slug}/comments`, { content: `Suspended carol still comments ${Date.now()}` }],
        ['GET', '/api/v1/auth/me', undefined],
      ] as const) {
        const response = await stale.request(method, path, body)
        // The suspension revoked the access token (tokens_valid_after), so it is refused as unauthenticated.
        expect(response.status(), `${method} ${path}`).toBe(401)
      }
      const refresh = await backend.refresh(carol.tokens.refreshToken)
      expect(refresh.status(), 'refresh of the suspended user').toBe(403)
      const fresh = await (await backend.asAdmin()).adminComments({ q: 'Suspended carol still comments' })
      expect(fresh, 'no comment by carol was written').toEqual([])

      // Signing in again with GitHub while suspended: /login?error=suspended, no session.
      const beforeRefusedLogin = (await admin.adminUsers({ q: login })).find((user) => user.id === carolId)
      await setMockUser(carol.context, login)
      const landed = await clickThrough(carol.page, headerLoginLink(carol.page))
      expect(pathAndQuery(landed)).toBe(`/login?error=suspended&returnTo=${encodeURIComponent(`/posts/${slug}`)}`)
      await expect(carol.page.getByRole('main').getByRole('alert')).toHaveText(msg('Site.login.errors.suspended'))
      expect(await sessionOf(carol.page)).toBeNull()
      // The rejected sign-in writes nothing to the account: the admin page's "Last sign-in" does not
      // change, nor do the name, login and avatar that carol's comments still show.
      const afterRefusedLogin = (await admin.adminUsers({ q: login })).find((user) => user.id === carolId)
      expect(afterRefusedLogin, 'carol account after the refused sign-in').toEqual(beforeRefusedLogin)

      // Unsuspend through the UI: carol can sign in again, returns to the right post, and can like.
      await page.goto(`/admin/users?q=${encodeURIComponent(login)}`)
      await dataRows(table)
        .filter({ hasText: `@${login}` })
        .getByRole('button', { name: handleButton('Admin.users.table.unsuspend', login), exact: true })
        .click()
      await expect(
        page.getByRole('status').filter({ hasText: plainMsg('Admin.users.table.notice.unsuspended', { handle: `@${login}` }) }),
      ).toHaveCount(1)
      await expect(dataRows(table).filter({ hasText: `@${login}` })).toContainText(msg('Admin.statuses.user.ACTIVE'))

      await loginWithGitHub(carol.page, login, {
        via: carol.page.getByRole('main').getByRole('link', { name: msg('Site.login.continueWithGithub') }),
        returnTo: `/posts/${slug}`,
      })
      const likeAgain = carol.page.getByRole('button', { name: LIKE_START })
      await likeAgain.click()
      await expect(likeAgain).toHaveAttribute('aria-pressed', 'true')
    } finally {
      // Safety net: carol is never left in the suspended state on the shared stack.
      const current = (await admin.adminUsers({ q: login })).find((user) => user.id === carolId)
      if (current?.status === 'SUSPENDED') await admin.setUserStatus(carolId, 'ACTIVE')
    }
  })
})
