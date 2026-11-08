import type { Locator, Page } from '@playwright/test'
import { createTemporaryPost, removeTemporaryPost, type TemporaryPost } from './support/admin'
import { expect, test } from './support/fixtures'
import { loginWithGitHub, newVisitorContext } from './support/github'
import { E2E_LOCALE, msg } from './support/i18n'

/**
 * The post like button.
 *
 * Every like goes into a temporary post published in `beforeAll` and deleted in `afterAll` (likes go with the post).
 * Each test compares against the backend's number at the moment it starts, and removes its own like in `finally`:
 * later tests do not inherit a filled heart.
 *
 * The button is server-confirmed, not optimistic: the heart and the number only change once the backend has
 * written. So each step re-reads the backend after the UI changes, and the "pending" state is checked while the
 * request is still held.
 */

const COUNT = new Intl.NumberFormat(E2E_LOCALE)

/** The accessible name of the button once signed in: a fixed verb, plus the number visible on the button. */
function buttonName(count: number): string {
  return msg('Site.like.ariaLabel', { count: COUNT.format(count), n: count })
}

/** The accessible name of the invitation for a guest. */
function loginLinkName(count: number): string {
  return msg('Site.like.guestAriaLabel', { count: COUNT.format(count), n: count })
}

/** The fixed words before the opening parenthesis of the toggle button's name, and of the guest invitation's name. */
const BUTTON_PREFIX = buttonName(0).split(' (')[0]
const LOGIN_PREFIX = loginLinkName(0).split(' (')[0]

/** The toggle button (signed in), whatever the number. */
function likeButton(page: Page): Locator {
  return page.getByRole('button', { name: new RegExp(`^${BUTTON_PREFIX} \\(`) })
}

/** The sign-in invitation to like (guest), whatever the number. */
function likeLoginLink(page: Page): Locator {
  return page.getByRole('link', { name: new RegExp(`^${LOGIN_PREFIX}`) })
}

/** The `role="status"` region of the like block: the success sentence (for screen readers) or the error sentence. */
function likeStatus(page: Page): Locator {
  return page.locator('#luot-thich').getByRole('status')
}

type LikeReply = { status: number; data: { liked: boolean; count: number } | null }

/**
 * `times` simultaneous requests to the like BFF route, from the reader's page (same origin, their
 * cookie): exactly the path the button calls, just without the button's double-click guard.
 */
function sendTogether(page: Page, path: string, method: 'PUT' | 'DELETE', times: number): Promise<LikeReply[]> {
  return page.evaluate(
    async ({ path, method, times }) => {
      const once = async () => {
        const response = await fetch(path, { method, headers: { 'content-type': 'application/json' } })
        const body = (await response.json().catch(() => null)) as { data?: { liked: boolean; count: number } } | null
        return { status: response.status, data: body?.data ?? null }
      }
      return Promise.all(Array.from({ length: times }, once))
    },
    { path, method, times },
  )
}

test.describe('Like a post', () => {
  let post: TemporaryPost | undefined

  test.beforeAll(async ({ browser, backend }, testInfo) => {
    post = await createTemporaryPost(browser, backend, testInfo, 'likes')
  })

  test.afterAll(async ({ browser, backend }, testInfo) => {
    if (post) await removeTemporaryPost(browser, backend, testInfo, post)
  })

  /** The temporary post of this spec; if `beforeAll` fails, every test stops here with a clear reason. */
  function tempPost(): TemporaryPost {
    if (!post) throw new Error('The temporary post was not created (beforeAll failed)')
    return post
  }

  test("guest: the sign-in link carries the backend's exact number and returns to the right button; there is no toggle button", async ({
    page,
    request,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    // The server HTML (the ISR version shared by everyone): only an inert placeholder, no number, nobody's state.
    const html = await (await request.get(`/posts/${slug}`)).text()
    expect(html).toContain('data-like-placeholder')
    // Exactly the accessible-name form with a number (a name like "… (3 likes)"); the temporary post body has the text
    // "(likes)" from this very spec, which must not count.
    expect(new RegExp(`${BUTTON_PREFIX} \\(\\d`, 'i').test(html), 'the like count in the server HTML').toBe(false)

    const { count } = await backend.likes(slug)
    await page.goto(`/posts/${slug}`)
    const link = page.getByRole('link', { name: loginLinkName(count), exact: true })
    await expect(link).toBeVisible()
    // The naked eye can also read this as an invitation to sign in with GitHub, not just "♡ 3".
    await expect(link.getByText(msg('Site.like.guestLabel'), { exact: true })).toBeVisible()
    const returnTo = `/posts/${slug}#luot-thich`
    await expect(link).toHaveAttribute('href', `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`)
    await expect(link).toHaveAttribute('rel', 'nofollow')
    await expect(likeButton(page)).toHaveCount(0)
    // A control for the HTML probe above: the same expression catches the number when it is really in the DOM.
    expect(new RegExp(`${BUTTON_PREFIX} \\(\\d`, 'i').test(await page.content()), 'the count in the DOM after hydration').toBe(
      true,
    )

    // Sign in from that very link: back to the button's place, now an unpressed toggle button.
    await loginWithGitHub(page, reader('alice'), { via: link, returnTo })
    const button = page.getByRole('button', { name: buttonName(count), exact: true })
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await expect(button).toBeInViewport()
    await expect(likeLoginLink(page)).toHaveCount(0)
  })

  test("like then unlike: the heart and the number are exactly what the backend wrote, including other people's likes", async ({
    page,
    backend,
    reader,
    userContext,
  }) => {
    const { slug } = tempPost()
    await page.goto(`/posts/${slug}`)
    const alice = backend.asUser((await loginWithGitHub(page, reader('alice'))).accessToken)
    const bob = backend.asUser((await userContext(reader('bob'))).tokens.accessToken)
    const before = (await backend.likes(slug)).count
    const button = likeButton(page)

    try {
      await expect(button).toHaveAccessibleName(buttonName(before))
      await expect(button).toHaveAttribute('aria-pressed', 'false')

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(button).toHaveAccessibleName(buttonName(before + 1))
      await expect(likeStatus(page)).toHaveText(msg('Site.like.liked'))
      expect(await alice.likes(slug)).toEqual({ liked: true, count: before + 1 })
      expect(await backend.likes(slug)).toEqual({ liked: false, count: before + 1 })

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'false')
      await expect(button).toHaveAccessibleName(buttonName(before))
      await expect(likeStatus(page)).toHaveText(msg('Site.like.unliked'))
      expect(await alice.likes(slug)).toEqual({ liked: false, count: before })

      // Bob likes while Alice's page still shows the old number. Alice clicks: the page shows the number the server returns
      // (including Bob's like), not "the old number plus one".
      await bob.like(slug)
      await expect(button).toHaveAccessibleName(buttonName(before))
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(button).toHaveAccessibleName(buttonName(before + 2))
      expect(await backend.likes(slug)).toEqual({ liked: false, count: before + 2 })

      // Bob unlikes; on the next load Alice sees the right new number, and her own heart is still filled.
      await bob.unlike(slug)
      await page.reload()
      await expect(button).toHaveAccessibleName(buttonName(before + 1))
      await expect(button).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await alice.unlike(slug)
      await bob.unlike(slug)
    }
  })

  test('double-click: exactly one PUT; while waiting the button is only busy, not filled, the number unchanged; when done it goes up by exactly one', async ({
    page,
    backend,
    reader,
  }) => {
    const { slug } = tempPost()
    await page.goto(`/posts/${slug}`)
    const mallory = backend.asUser((await loginWithGitHub(page, reader('mallory'))).accessToken)
    const before = (await backend.likes(slug)).count
    const path = `/api/posts/${slug}/like`

    // Hold the write request until the test has checked the waiting state: the second click surely lands while the
    // first request is still in flight, regardless of whether the machine is fast or slow.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const writes: string[] = []
    await page.route(`**${path}`, async (route) => {
      const method = route.request().method()
      if (method === 'GET') return route.fallback()
      writes.push(method)
      await held
      await route.continue()
    })

    const button = likeButton(page)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    try {
      await button.dblclick()
      await expect(button).toHaveAttribute('aria-busy', 'true')
      await expect(button).toHaveAttribute('aria-pressed', 'false')
      await expect(button).toHaveAccessibleName(buttonName(before))
      expect(writes, 'write requests while the first one is pending').toEqual(['PUT'])
      release()

      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(button).toHaveAttribute('aria-busy', 'false')
      await expect(button).toHaveAccessibleName(buttonName(before + 1))
      expect(writes, 'write requests after both clicks').toEqual(['PUT'])
      expect(await mallory.likes(slug)).toEqual({ liked: true, count: before + 1 })
    } finally {
      release()
      await mallory.unlike(slug)
    }
  })

  test('5 parallel PUTs through the BFF of the same person: add exactly one like; 5 parallel DELETEs remove exactly that like', async ({
    backend,
    reader,
    userContext,
  }) => {
    const { slug } = tempPost()
    const bob = await userContext(reader('bob'), { path: `/posts/${slug}` })
    const api = backend.asUser(bob.tokens.accessToken)
    const path = `/api/posts/${slug}/like`
    const before = (await backend.likes(slug)).count

    try {
      const puts = await sendTogether(bob.page, path, 'PUT', 5)
      expect(puts, 'five simultaneous PUTs').toEqual(Array(5).fill({ status: 200, data: { liked: true, count: before + 1 } }))
      expect(await backend.likes(slug)).toEqual({ liked: false, count: before + 1 })
      expect(await api.likes(slug)).toEqual({ liked: true, count: before + 1 })

      // Bob's page, reloaded: liked, exactly one like.
      await bob.page.reload()
      await expect(likeButton(bob.page)).toHaveAttribute('aria-pressed', 'true')
      await expect(likeButton(bob.page)).toHaveAccessibleName(buttonName(before + 1))

      const deletes = await sendTogether(bob.page, path, 'DELETE', 5)
      expect(deletes, 'five simultaneous DELETEs').toEqual(Array(5).fill({ status: 200, data: { liked: false, count: before } }))
      expect(await backend.likes(slug)).toEqual({ liked: false, count: before })
    } finally {
      await api.unlike(slug)
    }
  })

  test('the state survives a reload; a guest sees the same number', async ({ page, browser, backend, reader }, testInfo) => {
    const { slug } = tempPost()
    await page.goto(`/posts/${slug}`)
    const alice = backend.asUser((await loginWithGitHub(page, reader('alice'))).accessToken)
    const before = (await backend.likes(slug)).count
    const button = likeButton(page)

    try {
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await page.reload()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      await expect(button).toHaveAccessibleName(buttonName(before + 1))

      const visitor = await newVisitorContext(browser, testInfo)
      try {
        const guest = await visitor.newPage()
        await guest.goto(`/posts/${slug}`)
        await expect(guest.getByRole('link', { name: loginLinkName(before + 1), exact: true })).toBeVisible()
        await expect(likeButton(guest)).toHaveCount(0)
      } finally {
        await visitor.close()
      }

      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'false')
      await page.reload()
      await expect(button).toHaveAttribute('aria-pressed', 'false')
      await expect(button).toHaveAccessibleName(buttonName(before))
    } finally {
      await alice.unlike(slug)
    }
  })
})
