'use server'

import { revalidatePath } from 'next/cache'
import { adminErrorMessage, runAdminAction } from '@/lib/admin-action'
import { discardNewsletterIssue, releaseNewsletterIssue } from '@/lib/admin-api'

/*
 * The two decisions on a newsletter that waits for approval (a post an author published for the first time): release it to the
 * subscribers, or discard it. The backend is where permission is checked (ADMIN only); an AUTHOR calling these gets its 403
 * sentence. Both revalidate the page, which is the only place that lists the held newsletters and the latest sends.
 */

const PAGE = '/admin/newsletter'

/**
 * null means done. `version` is the one the list returned with this card, so the backend releases the text that was read and
 * nothing else. When the issue is gone (404) or the post changed since (409) the page is refreshed too, so the card shows what is
 * there now (its new text and its new version) next to the sentence.
 */
export async function releaseHeldIssue(postId: string, version: string): Promise<{ error: string } | null> {
  let stale = false
  const outcome = await runAdminAction(
    () => releaseNewsletterIssue(postId, version),
    (error, t) => {
      stale = error.status === 404 || error.status === 409
      return adminErrorMessage(error, t)
    },
  )
  if (outcome === null || stale) revalidatePath(PAGE)
  return outcome
}

/** null means done. */
export async function discardHeldIssue(postId: string): Promise<{ error: string } | null> {
  const outcome = await runAdminAction(() => discardNewsletterIssue(postId))
  if (outcome === null) revalidatePath(PAGE)
  return outcome
}
