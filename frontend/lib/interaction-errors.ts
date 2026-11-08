import type { Translator } from '@/i18n/translator'

/**
 * Sentences for errors when commenting, liking or saving a post (`t` is the `Errors.interaction` translator). The backend's
 * `message` must never be shown: it is written for the API caller, in English.
 *
 * The code wins over the status when both mean something; the status is only used when the code says nothing (the response of
 * a proxy, a network error).
 */

export type InteractionContext = 'comment' | 'like' | 'bookmark'

const BY_CODE = ['FORBIDDEN', 'COMMENT_NOT_FOUND', 'COMMENT_NOT_REPLYABLE', 'COMMENT_DUPLICATE', 'RATE_LIMITED'] as const

/** Session ended: the component shows a link to sign in again with GitHub. */
export function needsLogin(code: string, status: number): boolean {
  return code === 'UNAUTHENTICATED' || status === 401
}

export function interactionMessage(t: Translator, code: string, status: number, context: InteractionContext): string {
  if (needsLogin(code, status)) return t('sessionExpired')
  if (code === 'USER_SUSPENDED') return t(`userSuspended.${context}`)
  const known = BY_CODE.find((candidate) => candidate === code)
  if (known !== undefined) return t(`byCode.${known}`)
  // POST_NOT_FOUND, bookmark: both when saving on the post page and when unsaving on /bookmarks (unpublished or deleted post).
  if (code === 'POST_NOT_FOUND') return t(`postNotFound.${context}`)
  if (code === 'VALIDATION_ERROR' || code === 'PAYLOAD_TOO_LARGE' || status === 413) return t(`invalid.${context}`)
  if (code === 'NETWORK' || status === 0 || status >= 500) return t('network')
  // A code not in the table (an unknown 4xx): still a sentence.
  return t('fallback')
}
