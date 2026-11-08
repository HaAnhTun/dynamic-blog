import 'server-only'
import { getTranslations } from 'next-intl/server'
import { redirect, unstable_rethrow } from 'next/navigation'
import type { Translator } from '@/i18n/translator'
import { ApiError } from './api'
import { SessionExpiredError } from './admin-api'

/*
 * Deliberately NO 'use server': every export of a 'use server' file is a public endpoint
 * that anyone can POST to. This is a helper function for the actions files to call, not an action.
 */

/** Backend error codes that have a sentence in the catalog (`Errors.admin.codes.<CODE>`). A code missing here still yields a
 *  sentence, with the backend's reason when there is one (see `adminErrorMessage`). */
const KNOWN_CODES: readonly string[] = [
  'MEDIA_TOO_LARGE',
  'MEDIA_UNSUPPORTED_TYPE',
  'MEDIA_UNREADABLE',
  'MEDIA_DIMENSIONS_TOO_LARGE',
  'MEDIA_QUOTA_EXCEEDED',
  'MEDIA_BUSY',
  'MEDIA_NOT_FOUND',
  'POST_NOT_FOUND',
  // Only the Publish action meets this code in this sense (backend: missing content or category); Unpublish
  // has its own sentence in posts/actions.ts. Publishing reads the SAVED version, so choosing a category alone is not enough.
  'POST_NOT_PUBLISHABLE',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_ALREADY_EXISTS',
  // The backend refuses to delete a category that still has posts using it (foreign key posts.category_id, and a published post
  // must have a category): the thing to do is move those posts away first.
  'CATEGORY_IN_USE',
  'TAG_NOT_FOUND',
  'TAG_ALREADY_EXISTS',
  'SERIES_NOT_FOUND',
  'SERIES_ALREADY_EXISTS',
  'GALLERY_PHOTO_NOT_FOUND',
  // DataIntegrityViolation in the backend: the message is deliberately generic ("conflicts with existing data"),
  // usually a duplicate name/slug or two overlapping writes.
  'RESOURCE_CONFLICT',
  'FORBIDDEN',
  // Site content (admin settings): the leading JSON pointer of an invalid field is shown by the settings screen itself.
  'SITE_CONTENT_NOT_FOUND',
  'SITE_CONTENT_INVALID',
  'SITE_CONTENT_REVISION_NOT_FOUND',
  // Comment moderation and user management.
  'COMMENT_NOT_FOUND',
  'USER_NOT_FOUND',
  // The backend returns this code for an account that is not a USER, and for the logged-in user themselves (nobody
  // locks themselves out). The users page has no button for either, so it is only met when the role has just changed.
  'USER_NOT_SUSPENDABLE',
  'LAST_ADMIN',
  'SITE_OWNER_PROTECTED',
  'ROLE_TARGET_SUSPENDED',
  // Author applications. The three middle codes are only met when submitting an application, listed here to complete the table.
  'AUTHOR_APPLICATION_NOT_FOUND',
  'AUTHOR_APPLICATION_PENDING',
  'AUTHOR_APPLICATION_COOLDOWN',
  'AUTHOR_APPLICATION_NOT_ALLOWED',
  'AUTHOR_APPLICATION_DECIDED',
  // Rate limit per admin (role change: 20 times per 10 minutes), no Retry-After: it can only say "a few minutes".
  'RATE_LIMITED',
  // Post history: the backend only keeps the 20 most recent versions, older ones are pruned after each save.
  'REVISION_NOT_FOUND',
  // The post's language is already used by another post of its translation group (changing the language, creating or linking a translation).
  'TRANSLATION_CONFLICT',
  // Two-step verification: the reset of an author's enrollment asks for the administrator's own code and a recent sign-in.
  'MFA_CODE_INVALID',
  'MFA_RATE_LIMITED',
  'MFA_FROZEN',
  'REAUTHENTICATION_REQUIRED',
  // Post import. Their messages hold only counts, so the sentence is the whole answer. POST_IMPORT_INVALID_FILE and
  // POST_IMPORT_INVALID are left out on purpose: their backend message names the file by position and the line, which the
  // generic sentence would lose.
  'POST_IMPORT_HASH_MISMATCH',
  'POST_IMPORT_PREVIEW_OUT_OF_DATE',
  'POST_IMPORT_NOTHING_TO_UNDO',
  'POST_IMPORT_UNDO_CONFLICT',
  // Images of a ZIP package: the backend message names the file and the entry by position, but the sentence says all there is to do.
  'POST_IMPORT_MEDIA_QUOTA_EXCEEDED',
  'POST_IMPORT_MEDIA_BUSY',
  // Newsletter approval: the issue was decided in another tab (or queued by an administrator).
  'NEWSLETTER_ISSUE_NOT_FOUND',
  // A release for text the administrator did not read: the post changed after the list was loaded (the page refreshes and shows the new text).
  'NEWSLETTER_ISSUE_CHANGED',
  // An AUTHOR reached a limit an administrator does not have: posts a day, images in a post, the size of the tag or category list.
  'AUTHOR_QUOTA_EXCEEDED',
]

/** Longer than this is cut: the backend's reason is one sentence, not a page. */
const MAX_DETAIL = 200

/**
 * The reason the backend sent along, if it is worth showing to the user. The backend writes 4xx messages for the
 * API caller, containing nothing internal (GlobalExceptionHandler). A message that lib/admin-api.ts builds itself
 * when the error body has none ("API responded 400 for /api/v1/…") is not: it leaks the internal
 * path and says nothing more.
 */
function safeDetail(e: ApiError): string | null {
  const detail = e.message.trim()
  if (detail === '' || /^API (responded|answered) /.test(detail)) return null
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail
}

/**
 * Known code → catalog sentence (`t` is the `Errors.admin` translator). Otherwise it is never the backend's English text verbatim:
 * VALIDATION_ERROR becomes the "invalid data: <reason>" sentence — the specific reason ("title must not be
 * blank") that a generic sentence would lose — and an unknown code becomes the "could not do it: <reason>" sentence.
 * A 5xx error without a known code has a useless message that may leak an internal path, so it is
 * replaced by the generic sentence.
 */
export function adminErrorMessage(e: ApiError, t: Translator): string {
  if (e.code !== undefined && KNOWN_CODES.includes(e.code)) return t(`codes.${e.code}`)
  if (e.status >= 500) return t('serverError')
  const validation = e.code === 'VALIDATION_ERROR'
  const detail = safeDetail(e)
  if (detail === null) return t(validation ? 'invalid' : 'refused')
  return t(validation ? 'invalidDetail' : 'refusedDetail', { detail })
}

/**
 * For save-order actions that send the whole list (`setSeriesPosts`, `reorderGallery`): on those endpoints
 * 400 means the submitted list is stale (old tab, or another tab just added/removed), even when the code
 * is `POST_NOT_FOUND`/`GALLERY_PHOTO_NOT_FOUND`. Other errors follow the shared table: a series that was
 * deleted is a 404, and "reload the page" for it leads to a 404 page with no explanation. Use:
 * `runAdminAction(() => reorderGallery(ids), reorderErrorMessage)`.
 *
 * NOT for `setFeaturedOrder`: PUT featured-order replaces everything and accepts any list of
 * existing posts, even a stale one; a 400 there is only `POST_NOT_FOUND` (a post was just deleted)
 * or `VALIDATION_ERROR` (duplicate id, more than 50 posts), so curated/actions.ts has its own translator.
 */
export function reorderErrorMessage(e: ApiError, t: Translator): string {
  return e.status === 400 ? t('staleList') : adminErrorMessage(e, t)
}

/**
 * Wraps an API call in an admin Server Action, so that every error reaches the user:
 *
 * - `SessionExpiredError` → `redirect('/admin/login')`. In an action, redirect() is
 *   client-side navigation. Do not rethrow: an error thrown from an action reaches the client as a promise that is
 *   rejected and unhandled, the author clicks the button and sees nothing (the old editor bug).
 * - `ApiError` → `{ error }` so the form shows it in place, without losing what was typed. 403 belongs
 *   here, NO redirect: sending a permission error back to login is a loop (log in successfully,
 *   then be refused again).
 * - Other errors (backend down: `TypeError: fetch failed`) → a generic `{ error }`, and the original error is
 *   logged: a programming error also lands here, and without a log nobody would find it.
 *
 * Next control-flow errors (redirect(), notFound() called inside `fn`) are rethrown
 * intact: a "create, then go to the edit page" action caught here would report a connection error for a
 * successful creation.
 *
 * On the client, an action that redirected has its promise rejected with a NEXT_REDIRECT error
 * while the router navigates by itself: the component calling the action must swallow exactly that error (see
 * `isRedirectError` in components/admin/PostEditor.tsx), not show it as an error.
 *
 * `messageFor` changes how `ApiError` is translated (default `adminErrorMessage`); the save-order action
 * passes `reorderErrorMessage`.
 */
export async function runAdminAction<T>(
  fn: () => Promise<T>,
  messageFor: (e: ApiError, t: Translator) => string = adminErrorMessage,
): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (error) {
    unstable_rethrow(error)
    // Before ApiError: SessionExpiredError is a subclass of it.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    const t = await getTranslations('Errors.admin')
    if (error instanceof ApiError) return { error: messageFor(error, t) }
    console.error('Admin action failed', error)
    return { error: t('unreachable') }
  }
}

/** An error for the post editor to show in place. `sessionExpired`: the editor adds a link that opens the login page in a new tab. */
export type EditorActionError = { error: string; sessionExpired?: true }

/**
 * Like runAdminAction, except for one thing: an expired session does NOT redirect. For actions called from the post editor
 * (app/admin/(shell)/posts/editor-actions.ts), where redirecting would lose the post being written: returns
 * `{ error: <the sessionExpired sentence>, sessionExpired: true }` and the editor shows that sentence with a login link that opens in a new tab.
 * Same contract as `guard` in posts/actions.ts (save, publish, unpublish). Next control-flow errors (the redirect() of
 * "duplicate, then go to the new post") still pass through intact.
 */
export async function runEditorAction<T>(
  fn: () => Promise<T>,
  messageFor: (e: ApiError, t: Translator) => string = adminErrorMessage,
): Promise<T | EditorActionError> {
  try {
    return await fn()
  } catch (error) {
    unstable_rethrow(error)
    const t = await getTranslations('Errors.admin')
    // Before ApiError: SessionExpiredError is a subclass of it.
    if (error instanceof SessionExpiredError) return { error: t('sessionExpired'), sessionExpired: true }
    if (error instanceof ApiError) return { error: messageFor(error, t) }
    console.error('Editor action failed', error)
    return { error: t('unreachable') }
  }
}
