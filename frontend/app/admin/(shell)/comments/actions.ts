'use server'

import { adminErrorMessage, runAdminAction } from '@/lib/admin-action'
import { deleteAdminComment, setCommentStatus } from '@/lib/admin-api'
import type { Translator } from '@/i18n/translator'
import type { ApiError } from '@/lib/api'
import type { AdminComment } from '@/lib/types'

/*
 * The three actions of the Comments page: hide, show again, delete. The backend is where permission
 * is checked (ADMIN only) and the state rules live (each change is a conditional UPDATE, DELETED is the final state).
 *
 * NO updateTag: comments are not part of any cached public data — the post page loads them in the
 * browser, through a no-store route handler — so there is nothing to refresh. The admin screen
 * applies the action result to the row itself (CommentModeration), no page re-render needed.
 */

export type ModerationOutcome = AdminComment | { error: string }

/**
 * A 409 on hide or show again has only one meaning: the comment is no longer in the state the button
 * saw. Usually its author just deleted it (DELETED is the final state), or another tab just changed it.
 * RESOURCE_CONFLICT's generic sentence talks about "duplicate name or path", which is plainly wrong here
 * (`Errors.admin.commentStatusChanged` replaces it).
 */
function moderationMessage(e: ApiError, t: Translator): string {
  return e.code === 'RESOURCE_CONFLICT' ? t('commentStatusChanged') : adminErrorMessage(e, t)
}

/** Taken off the post page but kept; can be shown again. Already hidden changes nothing. */
export async function hideComment(id: string): Promise<ModerationOutcome> {
  return runAdminAction(() => setCommentStatus(id, 'HIDDEN'), moderationMessage)
}

export async function restoreComment(id: string): Promise<ModerationOutcome> {
  return runAdminAction(() => setCommentStatus(id, 'VISIBLE'), moderationMessage)
}

/** null means deleted (soft delete: the content remains for the admin, readers no longer see it). */
export async function deleteComment(id: string): Promise<{ error: string } | null> {
  return runAdminAction(() => deleteAdminComment(id))
}
