'use server'

import { updateTag } from 'next/cache'
import { redirect, RedirectType, unstable_rethrow } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import type { Translator } from '@/i18n/translator'
import { isLocale } from '@/i18n/config'
import { adminErrorMessage, runAdminAction } from '@/lib/admin-action'
import { ApiError, postTag } from '@/lib/api'
import {
  SessionExpiredError,
  createCategory,
  createPost,
  createTag,
  deletePost,
  publishPost,
  unpublishPost,
  updatePost,
  type PostInput,
} from '@/lib/admin-api'
import type { Category, Tag } from '@/lib/types'
import { isUuid } from '@/lib/uuid'

/** An error for the editor to show in place. `sessionExpired`: the editor adds a link opening the login page in a new tab. */
export type PostActionError = { error: string; sessionExpired?: true }

export type ActionResult = PostActionError | { id: string; slug: string }

function inputFrom(form: FormData): PostInput {
  const text = (name: string): string | undefined => {
    const value = form.get(name)
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  const language = text('language')

  return {
    title: text('title') ?? '',
    content: text('content') ?? '',
    excerpt: text('excerpt'),
    slug: text('slug'),
    categoryId: text('categoryId'),
    // An unknown value is dropped, not forwarded: the backend then keeps the language (update) or uses the default (create).
    language: isLocale(language) ? language : undefined,
    // getAll, not get: a repeated field yields only its first value through get, which
    // would silently drop every tag but one.
    tagIds: form.getAll('tagIds').filter((v): v is string => typeof v === 'string' && v !== ''),
  }
}

/**
 * Returns its error instead of throwing it, because a thrown error replaces the page
 * with an error boundary and the author loses everything they typed.
 *
 * There are no exceptions any more. The old version rethrew SessionExpiredError (believing "the page will
 * redirect") and every non-ApiError error (backend down: `TypeError: fetch failed`):
 * in an action, a thrown error reaches the client as a rejected promise, the editor rethrows, and
 * the author presses Save and sees nothing. It also does not redirect like runAdminAction: leaving the page
 * loses the post being written. Session expired → `sessionExpired` so the editor shows a login link in a new
 * tab; API error → the message from adminErrorMessage; any other error → "cannot connect", logged.
 * Next control errors (redirect(), notFound()) still pass through intact.
 */
async function guard<T>(
  run: () => Promise<T>,
  messageFor: (error: ApiError, t: Translator) => string = adminErrorMessage,
): Promise<T | PostActionError> {
  try {
    return await run()
  } catch (error) {
    unstable_rethrow(error)
    const t = await getTranslations('Errors.admin')
    // Before ApiError: SessionExpiredError is a subclass of it.
    if (error instanceof SessionExpiredError) return { error: t('sessionExpired'), sessionExpired: true }
    if (error instanceof ApiError) return { error: messageFor(error, t) }
    console.error('Post action failed', error)
    return { error: t('unreachable') }
  }
}

export async function savePost(id: string | null, form: FormData): Promise<ActionResult> {
  const input = inputFrom(form)
  const result = await guard(() => (id === null ? createPost(input) : updatePost(id, input)))
  if ('error' in result) return result
  // The public list and the post itself are cached for 300 seconds. Without this the
  // author publishes, looks at the site, sees nothing, and concludes it is broken.
  //
  // `updateTag`, not the plan's `revalidateTag`, and for two measured reasons. First, the
  // plan's single-argument call does not compile on Next 16.3.7: the declaration in
  // node_modules/next/dist/server/web/spec-extension/revalidate.d.ts:13 is
  // `revalidateTag(tag: string, profile: string | CacheLifeConfig)` and the profile is
  // required. Second, the obvious repair — `revalidateTag(tag, 'max')` — reintroduces the
  // exact failure this call exists to prevent: the `max` profile is `stale: 300 seconds`
  // (next/cache.d.ts), so the next reader is served the stale list while the refresh
  // happens behind them. `updateTag` expires immediately and is Server-Actions-only,
  // which is what these are; it is also what Next's own docs use for this scenario.
  updateTag('posts')
  updateTag(postTag(result.slug))
  // Search results (tag 'search'; search is `no-store` now, this line is also for the old cache) show the title, description and only
  // include published posts: without this line a post just renamed or unpublished stays in the results for up to 60
  // seconds, and clicking it gives a 404.
  updateTag('search')
  updateTaxonomy()
  return { id: result.id, slug: result.slug }
}

/**
 * The public /api/v1/categories and /tags only list categories and tags with at least one published
 * post, and lib/taxonomy.ts keeps those two lists for 300 seconds. The pages /categories/<slug>, /tags/<slug> and the
 * sitemap all read them. So every operation that can change the set of "topics with published posts" — changing the category or
 * tags of a published post, publish, unpublish, delete — clears both tags: without it the tag of a just-published post is a 404 for up to
 * five minutes, while the tag of a just-unpublished post is still open and in the sitemap.
 */
function updateTaxonomy(): void {
  updateTag('categories')
  updateTag('tags')
}

/**
 * Returns the created record or an error, never throwing. CATEGORY_ALREADY_EXISTS and
 * TAG_ALREADY_EXISTS are ordinary outcomes of typing a name that is already taken, and
 * an error boundary would throw away the draft in the editor behind it.
 *
 * After creating, clear the 'categories'/'tags' cache (lib/taxonomy.ts, 300 seconds). Without it, creating a
 * category right in the editor and then publishing a post into it makes /categories/<new-slug> return 404 for up to five
 * minutes: the page checks existence against the old list. Only on success: updateTag also re-renders the
 * current page in the action's response, useless for a failed create.
 */
export async function addCategory(name: string): Promise<Category | PostActionError> {
  const result = await guard(() => createCategory(name))
  if (!('error' in result)) updateTag('categories')
  return result
}

export async function addTag(name: string): Promise<Tag | PostActionError> {
  const result = await guard(() => createTag(name))
  if (!('error' in result)) updateTag('tags')
  return result
}

/**
 * Delete a post for good (the DELETE endpoint already existed; the UI had no path to it before). After deleting, go back to
 * the post list with `?deleted=1`, so the list says "The post was deleted": the edit page of a deleted post is a 404. The flag carries
 * no title on purpose: the dashboard shows a fixed sentence, because text taken from a URL would let any link write into the page.
 *
 * Cache: 'posts' covers every list, the post page (getPost carries 'posts' too), series, stats, sitemap
 * and feed; 'search' for search results. No `postTag(slug)` needed: 'posts' already includes it, and the endpoint
 * returns 204 so there is no saved slug to build a tag from.
 *
 * Through runAdminAction, not the editor's `guard`: an expired session goes to the login page — a post
 * being deleted has no text left on screen that needs keeping.
 */
export async function removePost(id: string): Promise<{ error: string }> {
  const result = await runAdminAction(() => deletePost(id))
  if (result !== null) return result
  updateTag('posts')
  updateTag('search')
  updateTaxonomy()
  // Outside runAdminAction and after updateTag: redirect() throws, so anything placed after it does not run.
  // `replace`: in a Server Action redirect is a push by default, and Back would reopen the edit page of the very
  // post just deleted (404). That page has nothing to go back to.
  redirect('/admin?deleted=1', RedirectType.replace)
}

/*
 * Bulk operations of the post list, and also the path of the per-row operations ("Publish",
 * "Unpublish", "Delete" right on a row call these very actions with one id): one single place decides what to skip,
 * how to translate errors and which cache to clear.
 *
 * Parallel on the SERVER, inside one action: Next sends one client's Server Actions one after another
 * (guide server-actions, "Sequential dispatch"), so twenty calls from the browser are twenty sequential
 * rounds. `Promise.allSettled`: one failed post does not lose the results of the others.
 *
 * Like runAdminAction of the list pages, not like the editor's `guard`: an expired session goes to the
 * login page — the list has no text being written to keep.
 */

/** Maximum per call: exactly one page of the list (post-list.ts, PAGE_SIZE). */
const BULK_MAX = 20

/** One post that could not be done, with a message for the user. The title is joined by the UI from the id: the action does
 *  not trust a title the browser sends, and does not need another API call just to read it. */
export type BulkFailure = { id: string; error: string }

/**
 * - `done`: changed in this call;
 * - `skipped`: already in the requested state beforehand (unpublishing a post that is no longer published, deleting a post
 *   that no longer exists) — changed in another tab, not an error;
 * - `failed`: could not be done, one reason per post.
 */
export type BulkResult = { done: string[]; skipped: string[]; failed: BulkFailure[] }

export type BulkOutcome = BulkResult | { error: string }

/** The id list deduplicated, or null when it is not something the UI can send (empty, over 20, malformed). */
function bulkIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const ids = [...new Set(raw)]
  if (ids.length === 0 || ids.length > BULK_MAX) return null
  return ids.every((id): id is string => isUuid(id)) ? ids : null
}

/**
 * Runs `call` for every id at once then arranges the results. `skip` says which API error means "already so".
 * Session expired on any post: clear the cache for what changed, then go to the login page.
 */
async function settleEach(
  ids: string[],
  call: (id: string) => Promise<unknown>,
  skip: (error: ApiError) => boolean,
): Promise<BulkResult> {
  const t = await getTranslations('Errors.admin')
  const settled = await Promise.allSettled(ids.map((id) => call(id)))
  const result: BulkResult = { done: [], skipped: [], failed: [] }
  let expired = false
  settled.forEach((outcome, index) => {
    const id = ids[index]
    if (outcome.status === 'fulfilled') {
      result.done.push(id)
      return
    }
    const error: unknown = outcome.reason
    unstable_rethrow(error)
    // Before ApiError: SessionExpiredError is a subclass of it.
    if (error instanceof SessionExpiredError) expired = true
    else if (error instanceof ApiError) {
      if (skip(error)) result.skipped.push(id)
      else result.failed.push({ id, error: adminErrorMessage(error, t) })
    } else {
      console.error('Bulk post action failed', error)
      result.failed.push({ id, error: t('unreachable') })
    }
  })
  // Once for the whole group, when a post changed or was found already changed: updateTag also redraws the current page in the
  // action's response, useless for a failure. 'posts' covers each post page too (getPost carries that tag), so no per-slug postTag is
  // needed. A skipped post ("already deleted" or "already unpublished") may have been changed in another tab, which cleared its cache, or by a
  // script, an API call or SQL, which cleared nothing and left the post on the public pages until its entry expires. The cost of
  // clearing again is one refetch, so the click on "delete" or "unpublish" heals the cache either way (docs/SECURITY.md, "Caching").
  if (result.done.length > 0 || result.skipped.length > 0) {
    updateTag('posts')
    updateTag('search')
    updateTaxonomy()
  }
  if (expired) redirect('/admin/login')
  return result
}

/**
 * Publish (`published` true) or unpublish the whole group. The UI only sends posts that will really change (drafts to
 * publish, published posts to unpublish); a post that just changed in another tab where the backend says "not in the published state"
 * on unpublish is skipped. A failed publish (missing category, missing content) is that post's own error.
 */
export async function bulkSetPublished(ids: string[], published: boolean): Promise<BulkOutcome> {
  const valid = bulkIds(ids)
  if (valid === null || typeof published !== 'boolean')
    return { error: (await getTranslations('Admin.posts.actions'))('bulkInvalid') }
  return settleEach(
    valid,
    (id) => (published ? publishPost(id) : unpublishPost(id)),
    (error) => !published && error.code === 'POST_NOT_PUBLISHABLE',
  )
}

/**
 * Delete the whole group for good (with each post's cover image, views, comments). Does not redirect like the editor's
 * removePost: the list redraws itself (updateTag) and says the result in place. A 404 means the post was already deleted
 * elsewhere: skipped.
 */
export async function deletePosts(ids: string[]): Promise<BulkOutcome> {
  const valid = bulkIds(ids)
  if (valid === null) return { error: (await getTranslations('Admin.posts.actions'))('bulkInvalid') }
  return settleEach(
    valid,
    (id) => deletePost(id),
    (error) => error.status === 404,
  )
}

export async function setPublished(id: string, published: boolean): Promise<ActionResult> {
  const tPosts = await getTranslations('Admin.posts.actions')
  const result = await guard(
    () => (published ? publishPost(id) : unpublishPost(id)),
    // The same code, two meanings: publishing is missing content/category (the sentence in the shared table), unpublishing is the post
    // no longer being published.
    (error, t) => (!published && error.code === 'POST_NOT_PUBLISHABLE' ? tPosts('notPublished') : adminErrorMessage(error, t)),
  )
  if ('error' in result) return result
  updateTag('posts')
  updateTag(postTag(result.slug))
  // Publishing makes the post findable at once, unpublishing makes it vanish from results at once (see savePost).
  updateTag('search')
  updateTaxonomy()
  return { id: result.id, slug: result.slug }
}
