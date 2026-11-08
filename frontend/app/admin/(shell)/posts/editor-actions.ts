'use server'

import { updateTag } from 'next/cache'
import { redirect, RedirectType } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import type { ImageListOutcome, ImageUploadOutcome, RevisionOutcome } from '@/components/admin/editor-types'
import { adminErrorMessage, runEditorAction, type EditorActionError } from '@/lib/admin-action'
import { ApiError, postTag } from '@/lib/api'
import {
  createPost,
  createPostTranslation,
  deletePostImage,
  getAdminPost,
  getPostRevision,
  linkPostTranslation,
  restorePostRevision,
  unlinkPostTranslation,
  uploadPostImage,
} from '@/lib/admin-api'
import { isLocale } from '@/i18n/config'
import { MAX_UPLOAD_BYTES } from '@/lib/prepare-upload'

/*
 * Post editor actions: images inside the post body, history and duplicating. A separate file,
 * not merged into actions.ts or cover-actions.ts: every export of a 'use server' file is an endpoint anyone
 * can POST to, and splitting means looking at one file shows the whole surface of this part. The post edit page packages the post
 * id into each action (like the cover), so the editor holds no id.
 *
 * Every call goes through runEditorAction, NOT runAdminAction: redirecting to the login page on an expired session
 * would lose the post being written. Errors return `{ error, sessionExpired? }` so the editor shows them in place.
 */

/**
 * A backend older than the UI (no in-body image route or history yet) returns 404 ENDPOINT_NOT_FOUND. Say that
 * plainly, instead of the shared table's "could not do it: The requested endpoint does not exist".
 * Returns the mapper already bound to the request's translators (the actions are async, the mapper is called synchronously).
 */
async function editorMessage(): Promise<(error: ApiError) => string> {
  const t = await getTranslations('Errors.admin')
  const tPosts = await getTranslations('Admin.posts.actions')
  return (error) => (error.code === 'ENDPOINT_NOT_FOUND' ? tPosts('outdatedBackend') : adminErrorMessage(error, t))
}

/**
 * One image for the post body (`file`, with an optional description `altText`). Rechecked like the cover (cover-actions.ts): is a
 * File, not empty, ≤ MAX_UPLOAD_BYTES — the browser already shrank it to that size (lib/prepare-upload.ts), so
 * a larger file means the client did not go through that step. The file type is decided by the backend (reading magic bytes).
 *
 * No cache is cleared: no saved post points at the just-uploaded image yet. Returns exactly the image, not the whole post.
 */
export async function uploadBodyImage(postId: string, form: FormData): Promise<ImageUploadOutcome> {
  const file = form.get('file')
  const t = await getTranslations('Admin.posts.actions')
  if (!(file instanceof File) || file.size === 0) return { error: t('noFile') }
  if (file.size > MAX_UPLOAD_BYTES) return { error: t('fileTooLarge') }
  const altText = form.get('altText')
  const result = await runEditorAction(
    () => uploadPostImage(postId, file, typeof altText === 'string' ? altText : undefined),
    await editorMessage(),
  )
  return 'error' in result ? result : { image: result }
}

/**
 * Delete one in-body image of the post from the server; returns the remaining images. No cache clearing: the HTML of the post page does not change
 * because of an image deletion (the content still points to it — the editor warned before deleting).
 */
export async function removeBodyImage(postId: string, mediaId: string): Promise<ImageListOutcome> {
  const result = await runEditorAction(() => deletePostImage(postId, mediaId), await editorMessage())
  return 'error' in result ? result : { images: result }
}

/** One revision in the post history, to preview before restoring. */
export async function loadRevision(postId: string, revisionId: string): Promise<RevisionOutcome> {
  const result = await runEditorAction(() => getPostRevision(postId, revisionId), await editorMessage())
  return 'error' in result ? result : { revision: result }
}

/**
 * Restore the title, description and content of a revision (the backend writes the current text into the history first, so this
 * can also be undone), then reopen the editor.
 *
 * Redirects instead of returning the post: the editor keeps its text in its own state, and only a rebuild from scratch
 * makes sure every field, the saved version, the cover and the history belong to the post after restoring. `?restored=` with a fresh value each time
 * is the editor's `key` on the post edit page: two restores in a row still rebuild it. `replace`:
 * Back does not reopen the page with the pre-restore text.
 *
 * Cache like savePost: for a published post the lists, the post page (by the SAVED slug) and the search results change
 * text at once. Categories and tags do not change (a revision does not carry them), so taxonomy is not touched.
 */
export async function restoreRevision(postId: string, revisionId: string): Promise<EditorActionError> {
  const result = await runEditorAction(() => restorePostRevision(postId, revisionId), await editorMessage())
  if ('error' in result) return result
  updateTag('posts')
  updateTag(postTag(result.slug))
  updateTag('search')
  redirect(`/admin/posts/${encodeURIComponent(result.id)}/edit?restored=${Date.now().toString(36)}`, RedirectType.replace)
}

/** The maximum title length (`@Size(max = 255)` at the backend, in UTF-16 units). */
const MAX_TITLE = 255

/** "<title> <suffix>" (the suffix is the translated "(copy)"), trimming the original part if the whole string is over 255 characters, never splitting an emoji in half. */
function copyTitle(title: string, suffix: string): string {
  const copySuffix = ` ${suffix}`
  let base = title.trim()
  const room = MAX_TITLE - copySuffix.length
  if (base.length > room) {
    base = base.slice(0, room)
    // The first half of a surrogate pair left at the end: drop it, instead of sending a broken character.
    const last = base.charCodeAt(base.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) base = base.slice(0, -1)
    base = base.trimEnd()
  }
  return `${base}${copySuffix}`
}

/**
 * Duplicate: a new DRAFT titled "… (copy)", with the same content, description, category and tags, then open it.
 * Reads the post on the server (the SAVED version), takes no text from the editor: this button can only be pressed when there are no unsaved
 * changes. Sends no slug: the backend generates it from the new title and avoids duplicates itself.
 *
 * Not copied (createPost does not accept them): cover image, series, "Best posts". In-body images still point
 * to the original post's images. No cache clearing: a draft is in no public data.
 */
export async function duplicatePost(postId: string): Promise<EditorActionError> {
  const copySuffix = (await getTranslations('Admin.posts.actions'))('copySuffix')
  const messageFor = await editorMessage()
  const result = await runEditorAction(async () => {
    const source = await getAdminPost(postId)
    return createPost({
      title: copyTitle(source.title, copySuffix),
      content: source.content,
      excerpt: source.excerpt !== null && source.excerpt.trim() !== '' ? source.excerpt : undefined,
      categoryId: source.category?.id,
      tagIds: source.tags.map((tag) => tag.id),
    })
  }, messageFor)
  if ('error' in result) return result
  redirect(`/admin/posts/${encodeURIComponent(result.id)}/edit`)
}

/*
 * Translation groups. The edit page packages the post id into each action, like the actions above. Linking and unlinking
 * change the `hreflang` alternates and the language switch of public post pages, so they clear the 'posts' tag (updateTag
 * also redraws the panel). Creating a draft touches no public data. Same error contract as the rest of this file.
 */

/** A new draft of this article in `language`, then open it in the editor. Only returns on error. */
export async function createTranslationAction(postId: string, language: string, slug: string): Promise<EditorActionError> {
  if (!isLocale(language)) return { error: (await getTranslations('Admin.posts.translations'))('languageRequired') }
  const messageFor = await editorMessage()
  const trimmed = slug.trim()
  const result = await runEditorAction(
    () => createPostTranslation(postId, trimmed === '' ? { language } : { language, slug: trimmed }),
    messageFor,
  )
  if ('error' in result) return result
  redirect(`/admin/posts/${encodeURIComponent(result.id)}/edit`)
}

/** Put the post and another existing post in one group. */
export async function linkTranslationAction(postId: string, otherId: string): Promise<EditorActionError | null> {
  if (otherId.trim() === '') return { error: (await getTranslations('Admin.posts.translations'))('pickPost') }
  const result = await runEditorAction(() => linkPostTranslation(postId, otherId), await editorMessage())
  if ('error' in result) return result
  updateTag('posts')
  return null
}

/** The post leaves its group; the other posts keep theirs (a group left with one post is dissolved by the backend). */
export async function unlinkTranslationAction(postId: string): Promise<EditorActionError | null> {
  const result = await runEditorAction(() => unlinkPostTranslation(postId), await editorMessage())
  if (result !== null) return result
  updateTag('posts')
  return null
}
