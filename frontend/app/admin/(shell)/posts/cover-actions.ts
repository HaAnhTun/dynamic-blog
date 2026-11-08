'use server'

import { updateTag } from 'next/cache'
import { getTranslations } from 'next-intl/server'
import type { CoverOutcome } from '@/components/admin/CoverPanel'
import { runAdminAction } from '@/lib/admin-action'
import { deletePostCover, updatePostCoverAlt, uploadPostCover } from '@/lib/admin-api'
import { postTag } from '@/lib/api'
import { MAX_UPLOAD_BYTES } from '@/lib/prepare-upload'
import type { Post } from '@/lib/types'

/*
 * The three cover image actions. A separate file, not merged into actions.ts: every export of
 * a 'use server' file is an endpoint anyone can POST to, and splitting means looking at one file
 * shows the whole surface of the upload part.
 *
 * It does not take the slug from the client as the plan wrote (`uploadCover(postId, slug, form)`): all three
 * endpoints return the post, and the post page tag is built from the SAVED slug in the response, like
 * savePost/setPublished. The slug at page render time may already be stale (slug changed in another tab), and
 * a client-sent parameter is something the caller chooses.
 */

/**
 * Calls the API through runAdminAction (session expired → login page; API error → an
 * `{error}` message), then clears the cache. The cover shows in the thumbnail of every list ('posts', and search results
 * 'search'), at the top of the post page (`postTag`): any missing tag leaves that place with the old cover until the cache expires
 * — for a just-removed cover, that is a deleted image (404). Only cleared on success:
 * updateTag also re-renders the current page in the action's response, useless for a failure.
 *
 * Returns exactly the part the screen needs (the cover), not the whole post: the action result travels to the browser,
 * and a post body can be tens of KB.
 */
async function settle(call: () => Promise<Post>): Promise<CoverOutcome> {
  const result = await runAdminAction(call)
  if ('error' in result) return result
  updateTag('posts')
  updateTag(postTag(result.slug))
  updateTag('search')
  return { cover: result.cover ?? null }
}

/**
 * One file per call (`file`), with an optional description (`altText`). Rechecked in the order: is a File,
 * not empty, ≤ MAX_UPLOAD_BYTES — the browser already shrank it to that size
 * (lib/prepare-upload.ts), so a larger file means the client did not go through that step, and the backend
 * would accept it up to 10 MB. The file type is not checked here: `type` is what the client declares, the backend
 * is the one reading magic bytes.
 */
export async function uploadCover(postId: string, form: FormData): Promise<CoverOutcome> {
  const file = form.get('file')
  const t = await getTranslations('Admin.posts.actions')
  // An empty file picker still sends a File of size 0 with an empty name.
  if (!(file instanceof File) || file.size === 0) return { error: t('noFile') }
  if (file.size > MAX_UPLOAD_BYTES) return { error: t('fileTooLarge') }
  const altText = form.get('altText')
  return settle(() => uploadPostCover(postId, file, typeof altText === 'string' ? altText : undefined))
}

/** Sent verbatim: the backend trims, a blank string becomes null, over 300 characters is a 400 with the reason. */
export async function saveCoverAlt(postId: string, altText: string): Promise<CoverOutcome> {
  return settle(() => updatePostCoverAlt(postId, altText))
}

/** Remove and delete the cover. The backend is idempotent: repeated removal from two tabs is not an error. */
export async function removeCover(postId: string): Promise<CoverOutcome> {
  return settle(() => deletePostCover(postId))
}
