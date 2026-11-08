import { expect, type Browser, type Page, type TestInfo } from '@playwright/test'
import type { Backend } from './backend'
import { liveAdminPair, sessionCookies } from './admin-session'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env'
import { applyLocale, msg, rawMsg } from './i18n'
import { freshAdminCode, takeRecoveryCode } from './mfa-state'

/** Escape a string for use inside a RegExp source. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const TIME_MARK = '@@time@@'

const OTHER_MARK = '@@other@@'

/** A pattern for the start of a catalog message: the text before its argument `arg` (`{time}` by default) or any other argument. */
export function msgStart(key: string, arg = 'time'): RegExp {
  // ICU needs every argument of the message, not only `arg`.
  const args: Record<string, string> = {}
  for (const [, name] of rawMsg(key).matchAll(/\{(\w+)/g)) args[name] = name === arg ? TIME_MARK : OTHER_MARK
  return new RegExp(`^${escapeRegExp(msg(key, args).split(TIME_MARK)[0].split(OTHER_MARK)[0].trimEnd())}`)
}

/** A pattern for a catalog message whose only argument is `{time}` shown as `HH:MM`; `wholeMessage: false` ignores the text after the time. */
export function msgAtTime(key: string, wholeMessage = true): RegExp {
  const [head, tail] = msg(key, { time: TIME_MARK }).split(TIME_MARK)
  // `HH:MM` in Vietnamese, `HH:MM AM` in English (lib/format.ts formats the time in the page's locale).
  const time = String.raw`\d{2}:\d{2}(?:\s[AP]M)?`
  return new RegExp(`^${escapeRegExp(head)}${time}${wholeMessage ? `${escapeRegExp(tail)}$` : ''}`)
}

/**
 * Opens /admin as the administrator, with a session that already went through both steps of the sign-in.
 *
 * The administrator needs a second factor to sign in, and a code works once per 30 second period, so signing in through the form for
 * every page of a long suite is not possible. The global setup signs in once through the real form (e2e/global-setup.ts) and
 * support/admin-session.ts keeps that session alive and hands its cookies to each context, as the cookies a browser would hold after
 * the form: httpOnly, Secure, Lax. When the saved session is gone (a spec that changed the password or signed out everywhere ended
 * it) it signs in again first. The real form is the subject of e2e/admin/login.spec.ts and e2e/admin/mfa.spec.ts, through
 * `signInAsAdminThroughForm`.
 *
 * A session older than ten minutes cannot change the security settings (`auth_time`, docs/SECURITY.md): the specs that do sign in
 * through the form themselves.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.context().addCookies(sessionCookies(await liveAdminPair('browser')))
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { level: 1, name: msg('Site.about.readNextLinks.writing') })).toBeVisible()
}

export type SecondStepProof = 'totp' | 'recovery'

/**
 * The second step of the sign-in, on /admin/login/mfa: a fresh authenticator code, or (after the link) a recovery code, which is
 * burned. Returns when the form has been submitted; the caller checks where it ended.
 */
export async function submitSecondStep(page: Page, proof: SecondStepProof = 'totp'): Promise<void> {
  if (proof === 'recovery') {
    const code = takeRecoveryCode()
    if (code === null)
      throw new Error('No recovery code is left in e2e/.auth/admin-mfa.json; run scripts/e2e-bootstrap.mjs again.')
    await page.getByRole('button', { name: msg('Admin.login.mfa.useRecovery') }).click()
    await page.getByLabel(msg('Admin.login.mfa.recoveryLabel'), { exact: true }).fill(code)
  } else {
    await page.getByLabel(msg('Admin.login.mfa.code'), { exact: true }).fill(await freshAdminCode())
  }
  await page.getByRole('button', { name: msg('Admin.login.mfa.submit'), exact: true }).click()
}

/** The first step of the sign-in form: the administrator's email and password. Ends on the second step's page. */
export async function submitAdminPassword(page: Page, next?: string): Promise<void> {
  await page.goto(next === undefined ? '/admin/login' : `/admin/login?next=${next}`)
  await page.getByLabel('Email').fill(ADMIN_EMAIL)
  await page.getByLabel(msg('Admin.login.password')).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: msg('Admin.login.submit'), exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/login\/mfa/)
}

/**
 * Signs in through the very form real users use, both steps: email and password, then the code. No cookie is set by hand: the session
 * cookies carry the `secure` flag (NODE_ENV=production) and are set by a route handler, so going through the form checks that path too.
 * A recovery code ends on the page that says how many remain, and this presses Continue. Returns on the destination (`/admin` by default).
 */
export async function signInAsAdminThroughForm(
  page: Page,
  { proof = 'totp', next }: { proof?: SecondStepProof; next?: string } = {},
): Promise<void> {
  await submitAdminPassword(page, next)
  await submitSecondStep(page, proof)
  if (proof === 'recovery') {
    await expect(page.getByText(msg('Admin.login.mfa.recoveryUsed'))).toBeVisible()
    await page.getByRole('button', { name: msg('Admin.login.mfa.continue'), exact: true }).click()
  }
  await expect(page).toHaveURL(next === undefined ? /\/admin$/ : new RegExp(`${escapeRegExp(next)}$`))
}

export type UploadPayload = { name: string; mimeType: string; buffer: Buffer }

/**
 * Upload photos to the gallery through /admin/gallery: choose the file, fill in the description (required) and the caption for each
 * photo in the queue, "Upload", wait for the progress line to report done. Each photo goes through one Server Action, so
 * the /gallery page sees the new photo immediately (`updateTag('gallery')`).
 */
export async function uploadToGallery(
  page: Page,
  files: string[] | UploadPayload[],
  fields: { altText: string; caption?: string }[],
): Promise<void> {
  await page.goto('/admin/gallery')
  const uploader = page.getByRole('region', { name: msg('Admin.gallery.uploader.heading') })
  await uploader.getByLabel(msg('Admin.gallery.uploader.choose')).setInputFiles(files)

  const queue = uploader.getByRole('list', { name: msg('Admin.gallery.uploader.queueLabel') }).getByRole('listitem')
  await expect(queue).toHaveCount(files.length)
  for (const [index, field] of fields.entries()) {
    const item = queue.nth(index)
    await item.getByLabel(msg('Admin.gallery.fields.altLabel')).fill(field.altText)
    if (field.caption) await item.getByLabel(msg('Admin.gallery.fields.captionLabel')).fill(field.caption)
  }

  await uploader.getByRole('button', { name: msg('Admin.gallery.uploader.upload'), exact: true }).click()
  // A phone photo is downsized in the browser and then processed on the server (decode, rotate, re-encode):
  // a few seconds per photo is normal.
  await expect(uploader.getByRole('status')).toHaveText(
    msg('Admin.gallery.uploader.done', { uploaded: files.length, total: files.length }),
    {
      timeout: 60_000,
    },
  )
}

/** Delete a photo in /admin/gallery by its description, through the in-place confirmation step. */
export async function deleteFromGallery(page: Page, altText: string): Promise<void> {
  await page.goto('/admin/gallery')
  const photos = page.getByRole('list', { name: msg('Admin.gallery.manager.orderLabel') })
  await photos
    .getByRole('button', {
      name: `${msg('Admin.gallery.manager.delete')} ${msg('Admin.gallery.manager.photoSubject', { name: altText })}`,
    })
    .click()
  await photos.getByRole('button', { name: msg('Admin.posts.delete.forever') }).click()
  await expect(page.getByText(msg('Admin.gallery.manager.photoDeleted', { name: altText }))).toBeVisible()
}

/** The temporary post of the comment and like specs. */
export type TemporaryPost = { id: string; slug: string; title: string }

/** Limit for each UI step of building and cleaning up the temporary post: if it fails there is still time for the safety net. */
const CHORE_STEP_MS = 15_000

/**
 * A PUBLISHED temporary post for the comment and like specs: call it in `beforeAll`, clean up
 * with removeTemporaryPost in `afterAll`, like the two temporary photos of gallery.spec.ts. The title has `purpose`,
 * the project name and the time, so each project and each run gets its own post.
 *
 * The draft is created directly through the API: a draft is in no cached public data. The PUBLISH step goes
 * through the admin UI, because only a Server Action calls `updateTag`: publishing straight in the backend lets the post list that
 * Next has cached pick up the temporary post in a background refresh and keep it for up to five minutes after the post was
 * deleted, and a later spec (article.spec.ts compares PostNav with the backend) would go red over a post that no longer exists.
 * Done in a separate context with the default viewport: building the data is not what is being tested.
 */
export async function createTemporaryPost(
  browser: Browser,
  backend: Backend,
  testInfo: TestInfo,
  purpose: string,
  language?: string,
  content?: string,
): Promise<TemporaryPost> {
  const stamp = Date.now()
  const title = `E2E post ${purpose} ${testInfo.project.name} ${stamp}`
  const draft = await backend.createDraftPost({
    title,
    language,
    excerpt: 'Temporary post of the E2E suite; deleted at the end of the spec.',
    content:
      content ??
      `## Temporary post\n\nTemporary post of the E2E suite (${purpose}), created at ${stamp}; deleted when the spec finishes.\n`,
  })
  const post = { id: draft.id, slug: draft.slug, title }
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  try {
    await applyLocale(context)
    const page = await context.newPage()
    await loginAsAdmin(page)
    await page.goto(`/admin/posts/${post.id}/edit`, { timeout: CHORE_STEP_MS })
    await page.getByRole('button', { name: msg('Admin.posts.row.publish'), exact: true }).click({ timeout: CHORE_STEP_MS })
    // The editor's status line: the first status region of the page (as in admin/posts.spec.ts).
    await expect(page.getByRole('status').first()).toHaveText(msgStart('Admin.editor.state.publishedAt'), {
      timeout: CHORE_STEP_MS,
    })
  } catch (error) {
    await removeTemporaryPost(browser, backend, testInfo, post).catch(() => {})
    throw error
  } finally {
    await context.close()
  }
  return post
}

/**
 * Delete the temporary post through the admin UI ("Delete post" → "Delete permanently"): the Server Action refreshes the 'posts' and
 * 'search' cache, so the post page becomes 404 and the lists drop it immediately; the post's comments and likes go
 * with it (ON DELETE CASCADE). If the UI fails it still deletes through the API: a stray post on the shared stack is worse than five
 * minutes of stale cache (the same choice as removeTemporary in admin/posts.spec.ts).
 */
export async function removeTemporaryPost(
  browser: Browser,
  backend: Backend,
  testInfo: TestInfo,
  post: TemporaryPost,
): Promise<void> {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  try {
    await applyLocale(context)
    const page = await context.newPage()
    await loginAsAdmin(page)
    await page.goto(`/admin/posts/${post.id}/edit`, { timeout: CHORE_STEP_MS })
    const remove = page.getByRole('region', { name: msg('Admin.posts.delete.heading') })
    await remove.getByRole('button', { name: msg('Admin.posts.delete.heading') }).click({ timeout: CHORE_STEP_MS })
    await remove.getByRole('button', { name: msg('Admin.posts.delete.forever') }).click({ timeout: CHORE_STEP_MS })
    await expect(page).toHaveURL(/\/admin\?deleted=/, { timeout: CHORE_STEP_MS })
  } catch {
    // The safety net right below: delete through the API.
  } finally {
    await context.close()
  }
  await backend.deletePost(post.id)
}
