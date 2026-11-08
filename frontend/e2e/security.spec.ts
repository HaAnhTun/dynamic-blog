import { randomBytes } from 'node:crypto'
import type { APIResponse, Page } from '@playwright/test'
import type { PublicComment } from '../lib/types'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import type { Method } from './support/backend'
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_URL, MOCK_GITHUB_URL } from './support/env'
import { expect, test } from './support/fixtures'
import { loginWithGitHub, mockUser, sessionOf } from './support/github'
import { randomClientAddress } from './support/network'
import { msg } from './support/i18n'
import { ACCESS_COOKIE, LEGACY_SESSION_COOKIES, REFRESH_COOKIE, SESSION_COOKIES } from './support/session-cookies'

/**
 * Security of reader accounts, comments and likes.
 *
 * Every write goes into a temporary post published in `beforeAll` and deleted in `afterAll` (comments and likes are deleted
 * with the post). The read-only part (the cache headers of an ISR page) uses one prerendered sample post. No token
 * is printed: comparisons on tokens are always boolean, because the log of a run is scanned for them.
 */

/** The accessible name of the like button starts with this text; the like count follows it in parentheses. */
const LIKE_LABEL = new RegExp(
  '^' +
    msg('Site.like.ariaLabel', { n: 0, count: 0 })
      .split(' (')[0]!
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
)

/** The admin sign-in page explains why a reader cannot enter (the rich tag renders as its inner text). */
const FORBIDDEN_MESSAGE = msg('Admin.login.forbidden', { home: (chunks: string) => chunks } as never)

/** The first sentence of the newsletter confirmation notice. */
const NEWSLETTER_ACCEPTED_SENTENCE = msg('Site.newsletter.form.accepted').split('.')[0]! + '.'

/** The part of the rate-limit message that precedes the number of minutes. */
const TOO_MANY_ATTEMPTS_PREFIX = msg('Admin.login.tooManyAttempts', { minutes: 'MINUTES' }).split('MINUTES')[0]!

/** The error envelope of the backend and of the BFF (`{ error: { code } }`). */
async function errorCode(response: APIResponse): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
  return body?.error?.code
}

/** The `exp` claim (seconds) of a JWT, read without checking the signature. */
function expiryOf(jwt: string): number {
  const payload = jwt.split('.')[1] ?? ''
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number }).exp
}

/**
 * The same token but with `exp` changed to `exp`: like an access token that has expired in the browser. The signature
 * no longer matches, and does not need to: the BFF (like proxy.ts) decides to refresh only from the `exp` claim, before
 * sending anything to the backend (lib/user-api.ts, `isExpiringWithin`).
 */
function withExpiry(jwt: string, exp: number): string {
  const [header, payload, signature] = jwt.split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  return [header, Buffer.from(JSON.stringify({ ...claims, exp }), 'utf8').toString('base64url'), signature].join('.')
}

/** A comment in the page's comment section, by the author name (the accessible name of the `<article>`) and the content. */
function commentArticle(page: Page, author: string, content: string) {
  return page.locator('#binh-luan').getByRole('article', { name: author, exact: true }).filter({ hasText: content })
}

/** The value of a cookie in the `Cookie` header of a request that was sent. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * Open a REAL page of another site: the fake GitHub on 127.0.0.1, a different site from localhost like github.com
 * is from the blog. It must be a page returned by a real loopback socket: a page built with `route.fulfill` has no
 * network address, and Chrome blocks every request from it to localhost with Local Network Access
 * (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS) even before the site's headers are considered — the probe would then
 * be green for another reason.
 */
async function openOtherSite(page: Page): Promise<void> {
  await page.goto(`${MOCK_GITHUB_URL}/__e2e/health`)
}

/**
 * From a page of another site, submit a `<form method="post" enctype="text/plain">` to `action`: the body is
 * `fields` as JSON (the trick `name='{"a":"…","pad":"' value='"}'`), something a cross-site form can send without
 * a CORS preflight. Returns the response the browser received for that POST.
 */
async function submitFromOtherSite(page: Page, action: string, fields: Record<string, string>) {
  await openOtherSite(page)
  const posted = page.waitForResponse((response) => response.url() === action && response.request().method() === 'POST')
  await page.evaluate(
    ({ action, name }) => {
      const form = document.createElement('form')
      form.method = 'post'
      form.enctype = 'text/plain'
      form.action = action
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = name
      input.value = '"}'
      form.append(input)
      document.body.append(form)
      form.submit()
    },
    { action, name: JSON.stringify(fields).slice(0, -2) },
  )
  return posted
}

/** The names of the cookies a response sets (Set-Cookie), never the values. */
function setCookieNames(response: APIResponse): string[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value.slice(0, header.value.indexOf('=')))
    .sort()
}

test.describe('Security', () => {
  let post: TemporaryPost | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'security')
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  /** The temporary post of this spec; if `beforeAll` fails, every test stops here with a clear reason. */
  function tempPost(): TemporaryPost {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    return post
  }

  test('a reader (USER) entering /admin: every page goes to /admin/login?reason=forbidden, no admin nav, the reader session survives', async ({
    page,
    reader,
  }) => {
    const login = reader('mallory')
    await page.goto('/')
    await loginWithGitHub(page, login)

    for (const path of ['/admin', '/admin/topics', '/admin/posts/new', '/admin/comments', '/admin/users']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(/\/admin\/login\?reason=forbidden$/)
      await expect(page.getByRole('main').getByRole('alert')).toContainText(FORBIDDEN_MESSAGE)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg('Site.account.signIn'))
      await expect(page.getByRole('list', { name: msg('Admin.shell.sectionsLabel'), includeHidden: true }), path).toHaveCount(0)
    }

    // An RSC request (client-side navigation, prefetch) also gets only a redirect, not the payload
    // of the admin frame.
    const rsc = await page.request.get('/admin/comments', { headers: { rsc: '1' }, maxRedirects: 0 })
    expect(rsc.status(), 'RSC /admin/comments').toBe(307)
    const location = new URL(rsc.headers()['location'] ?? '', page.url())
    expect(`${location.pathname}${location.search}`).toBe('/admin/login?reason=forbidden')
    expect((await rsc.text()).includes(msg('Admin.shell.sectionsLabel')), 'RSC payload of the admin frame').toBe(false)

    // Being rejected from /admin does not sign the reader out of the public part.
    expect((await sessionOf(page))?.githubLogin).toBe(login)
  })

  test('a reader token calling the admin API directly: 403 FORBIDDEN in every group, nothing changes', async ({
    page,
    backend,
    reader,
  }) => {
    const { id: postId, slug } = tempPost()
    await page.goto('/')
    const tokens = await loginWithGitHub(page, reader('mallory'))
    const api = backend.asUser(tokens.accessToken)
    const me = await api.me()
    // The person's OWN comment: the moderation API is still not theirs.
    const own = await api.addComment(slug, `Comment to try the moderation API ${Date.now()}`)
    const categoryId = (await backend.adminCategories())[0]?.id

    const calls: [Method, string, unknown?][] = [
      ['GET', '/api/v1/admin/posts?page=0&size=1'],
      ['POST', '/api/v1/admin/posts', { title: 'A reader post', content: 'x', categoryId, tagIds: [] }],
      ['DELETE', `/api/v1/admin/posts/${postId}`],
      ['PUT', '/api/v1/admin/posts/featured-order', { postIds: [] }],
      ['GET', '/api/v1/admin/categories'],
      ['POST', '/api/v1/admin/categories', { name: 'A reader category' }],
      ['GET', '/api/v1/admin/tags'],
      ['GET', '/api/v1/admin/series'],
      ['GET', '/api/v1/admin/gallery'],
      ['GET', '/api/v1/admin/comments'],
      ['PATCH', `/api/v1/admin/comments/${own.id}/status`, { status: 'HIDDEN' }],
      ['DELETE', `/api/v1/admin/comments/${own.id}`],
      ['GET', '/api/v1/admin/users'],
      ['PATCH', `/api/v1/admin/users/${me.id}/status`, { status: 'SUSPENDED' }],
    ]
    for (const [method, path, body] of calls) {
      const response = await api.request(method, path, body)
      expect(response.status(), `${method} ${path}`).toBe(403)
      expect(await errorCode(response), `${method} ${path}`).toBe('FORBIDDEN')
    }

    expect((await backend.post(slug)).id, 'the temporary post is intact').toBe(postId)
    const seen = (await api.comments(slug)).threads.find((thread) => thread.comment.id === own.id)
    expect(seen?.comment.status, 'the comment is still visible').toBe('VISIBLE')
    expect((await api.me()).status, 'the caller cannot suspend themselves').toBe('ACTIVE')
  })

  test('A cannot edit or delete B\'s comment: through the BFF and straight to the backend both 403; A does not see the "Edit"/"Delete" buttons', async ({
    backend,
    userContext,
    reader,
  }) => {
    const { slug } = tempPost()
    const bob = await userContext(reader('bob'), { path: `/posts/${slug}` })
    const mallory = await userContext(reader('mallory'), { path: `/posts/${slug}` })
    const bobName = mockUser(reader('bob')).displayName!
    const content = `Comment by Bob ${Date.now()}`
    const comment = await backend.asUser(bob.tokens.accessToken).addComment(slug, content)

    // Straight to the backend, with A's Bearer.
    const asMallory = backend.asUser(mallory.tokens.accessToken)
    for (const [method, body] of [
      ['PUT', { content: 'Mallory secretly edits' }],
      ['DELETE', undefined],
    ] as const) {
      const response = await asMallory.request(method, `/api/v1/comments/${comment.id}`, body)
      expect(response.status(), `backend ${method}`).toBe(403)
      expect(await errorCode(response), `backend ${method}`).toBe('FORBIDDEN')
    }

    // Through the BFF, from A's own page: same origin, A's cookie, exactly how the button on the page would call.
    const viaBff = await mallory.page.evaluate(async (id) => {
      const codeOf = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code ?? null
      const put = await fetch(`/api/comments/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'Mallory secretly edits through the BFF' }),
      })
      const del = await fetch(`/api/comments/${id}`, { method: 'DELETE' })
      return { put: [put.status, await codeOf(put)], delete: [del.status, await codeOf(del)] }
    }, comment.id)
    expect(viaBff).toEqual({ put: [403, 'FORBIDDEN'], delete: [403, 'FORBIDDEN'] })

    const after = (await backend.asUser(bob.tokens.accessToken).comments(slug)).threads.find(
      (thread) => thread.comment.id === comment.id,
    )
    expect(after?.comment, 'the comment of B is intact').toMatchObject({ content, status: 'VISIBLE', edited: false, mine: true })

    // A's UI: sees B's comment, can reply, but has no "Edit" / "Delete" buttons.
    await mallory.page.reload()
    await mallory.page.locator('#binh-luan').scrollIntoViewIfNeeded()
    const malloryView = commentArticle(mallory.page, bobName, content)
    await expect(malloryView).toBeVisible()
    await expect(malloryView.getByRole('button', { name: msg('Site.comments.item.reply') })).toBeVisible()
    await expect(malloryView.getByRole('button', { name: msg('Site.comments.item.edit') })).toHaveCount(0)
    await expect(malloryView.getByRole('button', { name: msg('Site.comments.item.delete') })).toHaveCount(0)
    // Control: B sees both buttons on that same comment, so the locator above is not missing it.
    await bob.page.reload()
    await bob.page.locator('#binh-luan').scrollIntoViewIfNeeded()
    const bobView = commentArticle(bob.page, bobName, content)
    await expect(bobView.getByRole('button', { name: msg('Site.comments.item.edit') })).toBeVisible()
    await expect(bobView.getByRole('button', { name: msg('Site.comments.item.delete') })).toBeVisible()
  })

  test('a reader cannot change their own role: PATCH/PUT/POST /auth/me are rejected, the role stays USER', async ({
    page,
    backend,
    reader,
  }) => {
    await page.goto('/')
    const tokens = await loginWithGitHub(page, reader('mallory'))
    const api = backend.asUser(tokens.accessToken)
    for (const method of ['PATCH', 'PUT', 'POST'] as const) {
      const response = await api.request(method, '/api/v1/auth/me', { role: 'ADMIN', status: 'ACTIVE' })
      expect(response.status(), `${method} /auth/me`).toBe(405)
    }
    expect((await api.me()).role).toBe('USER')
    expect(await sessionOf(page)).toMatchObject({ role: 'USER', canAccessAdmin: false })
  })

  test('a forged userId in the body is ignored: comments and likes always belong to the session owner', async ({
    backend,
    userContext,
    reader,
  }) => {
    const { slug } = tempPost()
    const bob = await userContext(reader('bob'))
    const mallory = await userContext(reader('mallory'), { path: `/posts/${slug}` })
    const asBob = backend.asUser(bob.tokens.accessToken)
    const asMallory = backend.asUser(mallory.tokens.accessToken)
    const bobMe = await asBob.me()
    const malloryMe = await asMallory.me()
    const malloryUser = mockUser(reader('mallory'))
    const content = `Mallory impersonating Bob ${Date.now()}`

    // Through the BFF, from Mallory's page: the body carries someone else's id, author and status.
    const created = await mallory.page.evaluate(
      async ({ slug, content, victim }) => {
        const response = await fetch(`/api/posts/${slug}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content,
            userId: victim,
            authorId: victim,
            // `siteOwner`: the site-owner label is computed only by the server (the site owner account), the request body cannot set it.
            author: { displayName: 'Bob', githubLogin: 'bob', siteOwner: true },
            status: 'HIDDEN',
            mine: false,
          }),
        })
        return { status: response.status, body: (await response.json()) as { data: PublicComment } }
      },
      { slug, content, victim: bobMe.id },
    )
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({
      content,
      status: 'VISIBLE',
      mine: true,
      author: { displayName: malloryUser.displayName, githubLogin: malloryUser.login, siteOwner: false },
    })
    const rows = await (await backend.asAdmin()).adminComments({ q: content })
    expect(
      rows.map((row) => row.authorId),
      'the author according to the backend',
    ).toEqual([malloryMe.id])
    const bobSees = (await asBob.comments(slug)).threads.find((thread) => thread.comment.id === created.body.data.id)
    expect(bobSees?.comment.mine, 'B does not see that comment as their own').toBe(false)

    // A like reads no body: a forged userId still records the like for the caller itself.
    const like = await asMallory.request('PUT', `/api/v1/posts/${encodeURIComponent(slug)}/like`, { userId: bobMe.id })
    expect(like.status()).toBe(200)
    expect((await asMallory.likes(slug)).liked).toBe(true)
    expect((await asBob.likes(slug)).liked, 'no like is recorded for B').toBe(false)
    await asMallory.unlike(slug)
  })

  test('a guest (no session) gets 401 for any write: through the BFF and straight to the backend, nothing changes', async ({
    request,
    backend,
    userContext,
    reader,
  }) => {
    const { slug } = tempPost()
    const bob = await userContext(reader('bob'))
    const asBob = backend.asUser(bob.tokens.accessToken)
    const content = `Comment for the guest to try ${Date.now()}`
    const comment = await asBob.addComment(slug, content)
    const likesBefore = (await asBob.likes(slug)).count

    const writes: [Method, string, unknown?][] = [
      ['POST', `posts/${slug}/comments`, { content: 'Guest comment' }],
      ['POST', `comments/${comment.id}/replies`, { content: 'Guest reply' }],
      ['PUT', `comments/${comment.id}`, { content: 'Guest edit' }],
      ['DELETE', `comments/${comment.id}`],
      ['PUT', `posts/${slug}/like`],
      ['DELETE', `posts/${slug}/like`],
      // Saving and unsaving a post.
      ['PUT', `me/bookmarks/${slug}`],
      ['DELETE', `me/bookmarks/${slug}`],
    ]
    for (const [method, path, body] of writes) {
      const init = { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { data: body }) }
      // The test's `request`: no cookies, like a browser that is not signed in.
      const viaBff = await request.fetch(`/api/${path}`, init)
      expect(viaBff.status(), `BFF ${method} /api/${path}`).toBe(401)
      expect(await errorCode(viaBff), `BFF ${method} /api/${path}`).toBe('UNAUTHENTICATED')
      const direct = await request.fetch(`${API_URL}/api/v1/${path}`, init)
      expect(direct.status(), `backend ${method} /api/v1/${path}`).toBe(401)
      expect(await errorCode(direct), `backend ${method} /api/v1/${path}`).toBe('UNAUTHENTICATED')
    }

    const after = await asBob.comments(slug)
    const thread = after.threads.find((candidate) => candidate.comment.id === comment.id)
    expect(thread?.comment).toMatchObject({ content, status: 'VISIBLE', edited: false })
    expect(thread?.replies).toEqual([])
    expect(after.threads.some((candidate) => candidate.comment.content === 'Guest comment')).toBe(false)
    expect((await asBob.likes(slug)).count).toBe(likesBefore)
  })

  test("a cross-origin POST to the BFF is blocked with 403, even when carrying the reader's cookie", async ({
    backend,
    userContext,
    reader,
  }) => {
    const { slug } = tempPost()
    const mallory = await userContext(reader('mallory'), { path: `/posts/${slug}` })
    const site = new URL(mallory.page.url()).origin
    const content = `Cross-site comment ${Date.now()}`
    const path = `/api/posts/${slug}/comments`

    // 1-2. A request carrying Mallory's session cookie (the context's cookie jar) but coming from another site:
    // a foreign Origin, or Sec-Fetch-Site cross-site. No SameSite rescue needed: the route itself rejects.
    const crossSite: Record<string, string>[] = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]
    for (const headers of crossSite) {
      const response = await mallory.page.request.post(path, {
        headers: { ...headers, 'content-type': 'application/json' },
        data: { content },
      })
      expect(response.status(), JSON.stringify(headers)).toBe(403)
      expect(await errorCode(response)).toBe('FORBIDDEN')
    }

    // 3. A real page on another site submits a form to the BFF in Mallory's browser. The body is text/plain
    // that looks like JSON, exactly what a cross-site form can send without a preflight.
    const response = await submitFromOtherSite(mallory.page, `${site}${path}`, { content, pad: '' })
    expect(response.status(), 'form POST from another site').toBe(403)
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN')

    const rows = await (await backend.asAdmin()).adminComments({ q: content })
    expect(rows, 'no comment was created').toEqual([])

    // Control: the same cookie, the same body, without a cross-site header is accepted. The 403s above are because of the
    // request's origin, not the session or the body.
    const control = await mallory.page.request.post(path, {
      headers: { 'content-type': 'application/json' },
      data: { content: `${content} (control)` },
    })
    expect(control.status(), 'same request, same origin').toBe(201)
  })

  test('newsletter: subscribe and confirm reject cross-origin POSTs and forms, even a real form from another site', async ({
    page,
    playwright,
  }, testInfo) => {
    // There is no session to borrow, but subscribing on someone else's behalf or confirming with a stolen token must not come from a foreign page.
    // Unsubscribe is different: a cross-origin one-click POST (RFC 8058) is valid, see newsletter.spec.ts.
    const client = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    const data = { email: `csrf-e2e-${Date.now()}@example.com`, token: randomBytes(32).toString('base64url') }
    const crossSite: Record<string, string>[] = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]
    try {
      for (const path of ['/api/newsletter/subscribe', '/api/newsletter/confirm']) {
        for (const headers of crossSite) {
          const response = await client.post(path, { headers: { ...headers, 'content-type': 'application/json' }, data })
          expect(response.status(), `${path} ${JSON.stringify(headers)}`).toBe(403)
          expect(await errorCode(response)).toBe('FORBIDDEN')
        }
        expect((await client.post(path, { form: data })).status(), `${path} form`).toBe(415)
      }
    } finally {
      await client.dispose()
    }

    await page.goto('/')
    const site = new URL(page.url()).origin
    const response = await submitFromOtherSite(page, `${site}/api/newsletter/subscribe`, { email: data.email, pad: '' })
    expect(response.status(), 'form POST from another site').toBe(403)
  })

  test('login CSRF: a cross-site form to /admin/login/submit is blocked with 403, the browser receives no session', async ({
    page,
  }) => {
    await page.goto('/')
    const site = new URL(page.url()).origin

    // A page on another site submits a text/plain form carrying a JSON body with the password of an account the
    // attacker knows: if accepted, the victim's browser would keep the attacker's session (a Lax cookie
    // is still set from the response of a top-level navigation).
    const response = await submitFromOtherSite(page, `${site}/admin/login/submit`, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      pad: '',
    })
    expect(response.status(), 'form POST from another site').toBe(403)
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN')
    const names = (await page.context().cookies(site)).map((cookie) => cookie.name)
    expect(names).not.toContain(ACCESS_COOKIE)
    expect(names).not.toContain(REFRESH_COOKIE)

    // Control: the same credentials, sent as JSON from the site itself (like LoginForm), are accepted. The administrator then needs a
    // second step, so what the browser receives is the challenge cookie and the name of the next step, never a session.
    const control = await page.request.post('/admin/login/submit', {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    expect(control.status(), 'same credentials, same origin').toBe(200)
    expect(await control.json()).toMatchObject({ ok: true, next: 'mfa' })
    // Not `cookies(site)`: the challenge cookie is only for the sign-in pages (Path=/admin/login), so it is not listed for the site root.
    const after = (await page.context().cookies()).map((cookie) => cookie.name)
    expect(after).toContain('mfa_challenge')
    expect(after).not.toContain(ACCESS_COOKIE)
    expect(after).not.toContain(REFRESH_COOKIE)
  })

  test('the second step of the sign-in refuses a cross-site form and a request without a challenge, and never hands out a session for either', async ({
    page,
  }) => {
    await page.goto('/')
    const site = new URL(page.url()).origin

    // A page on another site posts a form to the code endpoint: refused before anything is read.
    const forged = await submitFromOtherSite(page, `${site}/admin/login/mfa/submit`, { code: '123456', pad: '' })
    expect(forged.status(), 'form POST from another site').toBe(403)

    // Same origin and JSON, but no sign-in in progress (no challenge cookie): nothing to check a code against.
    const bare = await page.request.post('/admin/login/mfa/submit', {
      headers: { 'content-type': 'application/json' },
      data: { code: '123456' },
    })
    expect(bare.status(), 'no challenge cookie').toBe(401)
    expect(setCookieNames(bare), 'no cookie is set for a request without a challenge').toEqual([])
    const names = (await page.context().cookies(site)).map((cookie) => cookie.name)
    expect(names).not.toContain(ACCESS_COOKIE)
    expect(names).not.toContain(REFRESH_COOKIE)
  })

  test('the browser never calls the API origin directly: sign-in, like, bookmark, comment, saved posts, newsletter, profile, sign-out', async ({
    page,
    context,
    reader,
  }) => {
    const { slug } = tempPost()
    const api = new URL(API_URL)
    const direct: string[] = []
    const bff: string[] = []
    context.on('request', (request) => {
      const url = new URL(request.url())
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (url.origin === api.origin || (loopback && url.port === api.port)) direct.push(`${request.method()} ${url.pathname}`)
      else if (url.pathname.startsWith('/api/')) bff.push(url.pathname)
    })

    await page.goto(`/posts/${slug}`)
    await loginWithGitHub(page, reader('alice'))
    const like = page.getByRole('button', { name: LIKE_LABEL })
    await like.click()
    await expect(like).toHaveAttribute('aria-pressed', 'true')
    await like.click()
    await expect(like).toHaveAttribute('aria-pressed', 'false')
    const save = page.getByRole('button', { name: msg('Site.bookmarkButton.label'), exact: true })
    await save.click()
    await expect(save).toHaveAttribute('aria-pressed', 'true')
    await save.click()
    await expect(save).toHaveAttribute('aria-pressed', 'false')

    const comments = page.locator('#binh-luan')
    await comments.scrollIntoViewIfNeeded()
    await comments.getByLabel(msg('Site.comments.rootForm.label')).fill(`Comment only through the BFF ${Date.now()}`)
    await comments.getByRole('button', { name: msg('Site.comments.rootForm.submit') }).click()
    await expect(comments.getByRole('status')).toHaveText(msg('Site.comments.announce.posted'))

    const listed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me/bookmarks')
    await page.goto('/bookmarks')
    await listed

    // Newsletter: subscribe, then click the button on the confirmation page with a fake token (the generic sentence).
    await page.goto('/newsletter')
    const newsletter = page.getByRole('main')
    await newsletter.getByLabel(msg('Site.newsletter.form.emailLabel')).fill(`bff-e2e-${Date.now()}@example.com`)
    await newsletter.getByRole('button', { name: msg('Site.newsletter.form.submit') }).click()
    await expect(newsletter.getByRole('status')).toContainText(NEWSLETTER_ACCEPTED_SENTENCE)
    await page.goto(`/newsletter/confirm?token=${randomBytes(32).toString('base64url')}`)
    await page
      .getByRole('main')
      .getByRole('button', { name: msg('Site.newsletter.token.confirm.button') })
      .click()
    await expect(page.getByRole('main').getByText(msg('Site.newsletter.token.linkInvalid'))).toBeVisible()

    await page.goto('/profile')
    await page
      .getByRole('main')
      .getByRole('button', { name: msg('Site.account.signOut') })
      .click()
    await expect(page).toHaveURL(/\/$/)

    expect(direct, 'browser requests to the API origin').toEqual([])
    // Control: the recorder has seen the BFF routes, so the empty list above is not because it did not run.
    for (const route of [
      '/api/session',
      `/api/posts/${slug}/like`,
      `/api/me/bookmarks/${slug}`,
      '/api/me/bookmarks',
      `/api/posts/${slug}/comments`,
      '/api/newsletter/subscribe',
      '/api/newsletter/confirm',
      '/api/auth/logout',
    ]) {
      expect(bff, route).toContain(route)
    }
  })

  test('a post page with a reader cookie: the same cache headers and prerender as a guest; the HTML carries nothing of the reader', async ({
    page,
    request,
    backend,
    reader,
  }) => {
    const seed = await backend.prerenderedPost()
    const login = reader('mallory')
    const user = mockUser(login)
    await page.goto(`/posts/${seed.slug}`)
    const tokens = await loginWithGitHub(page, login)

    const headersOf = (response: APIResponse) => {
      const headers = response.headers()
      return {
        cacheControl: headers['cache-control'],
        prerender: headers['x-nextjs-prerender'],
        vary: headers['vary'],
        frameOptions: headers['x-frame-options'],
        csp: headers['content-security-policy'],
      }
    }
    const anonymous = await request.get(`/posts/${seed.slug}`)
    const signedIn = await page.request.get(`/posts/${seed.slug}`)
    expect(anonymous.status()).toBe(200)
    expect(signedIn.status()).toBe(200)
    expect(headersOf(signedIn)).toEqual(headersOf(anonymous))
    expect(headersOf(signedIn).prerender, 'the post page is still the prerendered version').toMatch(/^1(, 1)*$/)
    expect(headersOf(signedIn).cacheControl).toMatch(/s-maxage=\d+/)
    expect(setCookieNames(signedIn), 'the post page sets no cookie').toEqual([])

    // The post page, the home page and the /profile frame: no name, no login, no token of the reader.
    for (const path of [`/posts/${seed.slug}`, '/', '/profile']) {
      const html = await (await page.request.get(path)).text()
      expect(html.includes(user.displayName!), `${path}: display name`).toBe(false)
      expect(html.includes(login), `${path}: GitHub login`).toBe(false)
      expect(html.includes(tokens.accessToken) || html.includes(tokens.refreshToken), `${path}: token`).toBe(false)
    }
  })

  test('an expired access token: clicking like still succeeds, the BFF refreshes by itself and sets a new cookie pair', async ({
    page,
    context,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    await page.goto(`/posts/${slug}`)
    const tokens = await loginWithGitHub(page, reader('mallory'))
    const like = page.getByRole('button', { name: LIKE_LABEL })
    await expect(like).toHaveAttribute('aria-pressed', 'false')

    // Once the page has loaded (the session is known) the access token in the browser "expires". Overwrite exactly the route's
    // cookie (host, Path=/): addCookies with `url` takes Path from the URL's directory and drops Secure on
    // http, producing a second cookie instead of replacing the old one.
    const expired = withExpiry(tokens.accessToken, Math.floor(Date.now() / 1000) - 60)
    await context.addCookies([
      {
        name: ACCESS_COOKIE,
        value: expired,
        domain: new URL(page.url()).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ])
    const jarBefore = (await context.cookies()).filter((cookie) => cookie.name === ACCESS_COOKIE)
    expect(
      jarBefore.map((cookie) => cookie.value === expired),
      'the browser only holds the expired token',
    ).toEqual([true])
    const put = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/posts/${slug}/like` && response.request().method() === 'PUT',
    )
    await like.click()
    const response = await put
    expect(response.status()).toBe(200)
    expect(
      cookieValue((await response.request().allHeaders())['cookie'], ACCESS_COOKIE) === expired,
      'the PUT carried the expired token',
    ).toBe(true)
    await expect(like).toHaveAttribute('aria-pressed', 'true')
    const set = (await response.headersArray())
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value.slice(0, header.value.indexOf('=')))
      .sort()
    // The new pair under the `__Host-` names, and the deletion of the names the cookies had before the prefix.
    expect(set, 'a new cookie pair on the response of the like itself').toEqual([...SESSION_COOKIES, ...LEGACY_SESSION_COOKIES])

    const jar = await context.cookies()
    const access = jar.find((cookie) => cookie.name === ACCESS_COOKIE)?.value ?? ''
    const refresh = jar.find((cookie) => cookie.name === REFRESH_COOKIE)?.value ?? ''
    // Do not compare the new access with the access at sign-in: the JWT has no `jti`, and a refresh within the same second as the
    // sign-in produces the old string (same sub, role, iat, exp). What proves the refresh is that `exp` is still
    // valid, and the refresh token has rotated.
    expect(access !== expired, 'the access token is no longer the expired one').toBe(true)
    expect(expiryOf(access)).toBeGreaterThan(Date.now() / 1000)
    expect(refresh !== '' && refresh !== tokens.refreshToken, 'a new refresh token').toBe(true)
    // The old refresh token has been rotated in the backend; the like belongs to the right person.
    expect((await backend.refresh(tokens.refreshToken)).status(), 'the old refresh token').toBe(401)
    const asMallory = backend.asUser(access)
    expect((await asMallory.likes(slug)).liked).toBe(true)
    await asMallory.unlike(slug)
  })

  test('anti-framing: X-Frame-Options DENY and frame-ancestors none; another site cannot embed the page', async ({
    page,
    request,
    backend,
  }) => {
    const seed = await backend.prerenderedPost()
    for (const path of ['/', `/posts/${seed.slug}`, '/login', '/profile']) {
      const response = await request.get(path)
      const headers = response.headers()
      expect(headers['x-frame-options'], path).toBe('DENY')
      expect(headers['content-security-policy'], path).toContain("frame-ancestors 'none'")
      // The same pages carry nosniff and Referrer-Policy, no X-Powered-By, and no HSTS
      // on this http stack.
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin')
      expect(headers['x-powered-by'], path).toBeUndefined()
      expect(headers['strict-transport-security'], path).toBeUndefined()
    }

    // A real attempt: a page on another site embeds the post page in an iframe. The browser receives the response and then blocks
    // because of its header (ERR_BLOCKED_BY_RESPONSE), not for any other network reason.
    await page.goto('/')
    const target = `${new URL(page.url()).origin}/posts/${seed.slug}`
    await openOtherSite(page)
    const received = page.waitForResponse((response) => response.url() === target)
    const blocked = page.waitForEvent('requestfailed', (request) => request.url() === target)
    await page.evaluate((src) => {
      const frame = document.createElement('iframe')
      frame.title = 'Post page embedded from another site'
      frame.src = src
      document.body.append(frame)
    }, target)
    expect((await (await received).allHeaders())['x-frame-options']).toBe('DENY')
    expect((await blocked).failure()?.errorText).toBe('net::ERR_BLOCKED_BY_RESPONSE')
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
    expect(frame?.url(), 'the iframe does not hold the page').not.toBe(target)
  })

  test("the OAuth response keeps the route's own Referrer-Policy: no-referrer, not replaced by the shared next.config header", async ({
    playwright,
  }, testInfo) => {
    // Next sets the config headers before the route runs and drops a route header of the same name: without a dedicated rule
    // for /api/auth/github/*, the shared `strict-origin-when-cross-origin` would replace `no-referrer`, and the
    // callback URL (carrying code, state) would travel in the Referer. A client address of its own: these two calls spend the OAuth
    // quota of that address alone, not anyone else's (e2e/support/network.ts).
    const client = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    try {
      for (const path of ['/api/auth/github/start?returnTo=%2F', '/api/auth/github/callback']) {
        const response = await client.get(path, { maxRedirects: 0 })
        expect(response.status(), path).toBe(303)
        expect(response.headers()['referrer-policy'], path).toBe('no-referrer')
        expect(response.headers()['x-content-type-options'], path).toBe('nosniff')
      }
    } finally {
      await client.dispose()
    }
  })

  test('bursts of admin password sign-ins from one address: the 11th within 10 minutes gets 429 with Retry-After, even with the right password; another address still gets in', async ({
    playwright,
  }, testInfo) => {
    // Each client has a random address (2001:db8::/32): the E2E stack has no nginx, so the client's header
    // is the entry Next reads, and this address's quota touches no other test.
    const address = randomClientAddress()
    const attacker = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': address },
    })
    const owner = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': randomClientAddress() },
    })
    const login = (client: typeof attacker, password: string, headers: Record<string, string> = {}) =>
      client.post('/admin/login/submit', {
        headers: { 'content-type': 'application/json', ...headers },
        data: { email: ADMIN_EMAIL, password },
      })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 10; i++) statuses.push((await login(attacker, `wrong-password-e2e-${i}`)).status())
      expect(statuses, 'the first ten wrong attempts reach the backend').toEqual(Array(10).fill(401))

      const blocked = await login(attacker, 'wrong-password-e2e-11')
      expect(blocked.status()).toBe(429)
      const retryAfter = Number(blocked.headers()['retry-after'])
      expect(retryAfter, 'Retry-After is the number of seconds left in the 10 minute window').toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(600)
      expect(blocked.headers()['cache-control']).toBe('private, no-store')
      expect(((await blocked.json()) as { error?: string }).error).toContain(TOO_MANY_ATTEMPTS_PREFIX)

      // Blocked before the password check: the right password from this address does not get in either, and gets no session.
      const right = await login(attacker, ADMIN_PASSWORD)
      expect(right.status(), 'the right password after reaching the cap').toBe(429)
      expect((await right.headersArray()).some((header) => header.name.toLowerCase() === 'set-cookie')).toBe(false)
      // Setting the first entry of X-Forwarded-For (which nginx keeps and then appends the real address after) does not open a
      // new quota: Next reads the last entry.
      const spoofed = await login(attacker, ADMIN_PASSWORD, { 'x-forwarded-for': `203.0.113.77, ${address}` })
      expect(spoofed.status(), 'forged first entry').toBe(429)

      // The site owner at another address is not locked out along with it.
      expect((await login(owner, ADMIN_PASSWORD)).status(), 'another address').toBe(200)
    } finally {
      await attacker.dispose()
      await owner.dispose()
    }
  })
})

/**
 * The Content-Security-Policy of every HTML page (docs/SECURITY.md, "Content Security Policy"). It is enforced, so a page that breaks
 * under it shows as a failed journey anywhere in the suite; the browser also reports each block as a `securitypolicyviolation` event,
 * collected here on the main pages, on a post with every kind of block, and in the admin editor. The test fails on the first violation.
 */
const BLOCKS_POST = [
  '## Blocks under the policy',
  '',
  ':::callout{type=note title="A callout"}',
  'Text with `code` and a [link](https://example.org).',
  ':::',
  '',
  '::::diagram{type=mermaid alt="A goes to B"}',
  'flowchart LR',
  '  A --> B',
  '::::',
  '',
  '```ts',
  'const answer: number = 42',
  '```',
  '',
].join('\n')

type Violation = { directive: string; blocked: string; page: string }

/** Starts collecting `securitypolicyviolation` events in every document of the page, from the first script on. */
async function collectViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Violation[] = []
    ;(window as unknown as { __cspViolations: Violation[] }).__cspViolations = seen
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ directive: event.effectiveDirective, blocked: event.blockedURI, page: location.pathname })
    })
  })
}

async function violationsOn(page: Page): Promise<Violation[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations?: Violation[] }).__cspViolations ?? [])
}

test.describe('Content Security Policy', () => {
  let post: TemporaryPost | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'csp', undefined, BLOCKS_POST)
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  test('HTML pages carry the enforced policy, with frame-ancestors, and name where it reports to', async ({
    request,
    backend,
  }) => {
    const seed = await backend.prerenderedPost()
    for (const path of ['/', `/posts/${seed.slug}`, '/login']) {
      const headers = (await request.get(path)).headers()
      expect(headers['content-security-policy-report-only'], `${path}: nothing is left as Report-Only`).toBeUndefined()
      const policy = headers['content-security-policy'] ?? ''
      for (const directive of [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'report-uri /api/csp-report',
        'report-to csp-endpoint',
      ]) {
        expect(policy.split('; '), path).toContain(directive)
      }
      expect(policy, path).not.toContain('nonce-')
      expect(headers['reporting-endpoints'], path).toBe('csp-endpoint="/api/csp-report"')
    }
  })

  test('the report endpoint takes a report and refuses what is not one', async ({ request }) => {
    const report = { 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://tracker.example/p.gif?id=1' } }
    const accepted = await request.post('/api/csp-report', {
      headers: { 'content-type': 'application/csp-report' },
      data: JSON.stringify(report),
    })
    expect(accepted.status()).toBe(204)
    const wrongType = await request.post('/api/csp-report', { data: report })
    expect(wrongType.status(), 'application/json is not a report type').toBe(415)
  })

  test('the main public pages and a post with blocks raise no violation', async ({ page, backend }) => {
    test.setTimeout(120_000)
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    const seed = await backend.prerenderedPost()
    await collectViolations(page)
    const found: Violation[] = []
    for (const path of [
      '/',
      '/writing',
      '/topics',
      '/about',
      '/search',
      '/login',
      `/posts/${seed.slug}`,
      `/posts/${post.slug}`,
    ]) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      found.push(...(await violationsOn(page)))
    }
    expect(found, 'violations of the policy on public pages').toEqual([])
  })

  test('the admin editor raises no violation', async ({ adminPage: page }) => {
    test.setTimeout(120_000)
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    await collectViolations(page)
    const found: Violation[] = []
    for (const path of ['/admin', `/admin/posts/${post.id}/edit`]) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      found.push(...(await violationsOn(page)))
    }
    expect(found, 'violations of the policy in the admin').toEqual([])
  })
})
