import { postPath } from '@/components/site/ArticleJsonLd'
import type { Translator } from '@/i18n/translator'
import { COMMENT_TARGET_PREFIX } from './comment-target'
import type { NotificationActor, NotificationPage, NotificationType, UserNotification } from './types'
import { UUID } from './uuid'

/**
 * The wording, target and payload reader of a notification, shared by the bell's panel
 * and the /notifications page.
 *
 * The sentence always has the form `<actor> <middle part> “<post title>”<tail>`: the component prints the actor name bold in
 * `<bdi>` (the name is user-chosen, and a right-to-left name must not reorder the text around it), the post title between
 * two curly quotes. All text is plain React text: no HTML from the server.
 *
 * Target: the post, and for the three types that carry a comment, that exact comment (`#binh-luan-<uuid>`, see
 * lib/comment-target.ts). `postPath` already encodes the slug.
 */

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'POST_LIKED',
  'POST_COMMENTED',
  'COMMENT_REPLIED',
  'COMMENT_LIKED',
]

export type NotificationCopy = {
  /** After the actor's name, before the post title. */
  lead: string
  /** After the post title, including the period. */
  tail: string
}

/** `t` is the `Site.notifications` translator. */
export function notificationCopy(type: NotificationType, t: Translator): NotificationCopy {
  return { lead: t(`copy.lead.${type}`), tail: t(`copy.tail.${type}`) }
}

/** The whole sentence in lower case, exactly what the reader sees (for tests and anywhere a single string is needed). */
export function notificationSentence(notification: UserNotification, t: Translator): string {
  const { lead, tail } = notificationCopy(notification.type, t)
  return `${notification.actor.displayName} ${lead} “${notification.post.title}”${tail}`
}

/** Link target: the post, plus `#binh-luan-<id>` when the notification is attached to a comment. */
export function notificationHref(notification: UserNotification): string {
  const path = postPath(notification.post.slug)
  return notification.commentId === null ? path : `${path}#${COMMENT_TARGET_PREFIX}${notification.commentId}`
}

/* The `NotificationPage` / `NotificationResponse` contract, re-checked in the browser like every BFF payload.
      It differs from the comment reader in one deliberate point: a broken notification or one of an unknown type
      is DROPPED, not failing the whole page — a type added in the backend later must not leave the bell
      blank. A wrong envelope gives null: "could not load". */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseActor(value: unknown): NotificationActor | null {
  if (!isRecord(value)) return null
  const { displayName, githubLogin, avatarUrl } = value
  if (typeof displayName !== 'string' || !isNullableString(githubLogin) || !isNullableString(avatarUrl)) return null
  return { displayName, githubLogin, avatarUrl }
}

/**
 * A notification that matches the contract, or null. id and `commentId` go into URLs so they must be UUIDs; the three
 * comment types require `commentId`, `POST_LIKED` never has one (the table's CHECK). The result is a freshly built
 * object holding only the contract fields.
 */
export function parseNotification(value: unknown): UserNotification | null {
  if (!isRecord(value)) return null
  const { id, createdAt, read, commentId, excerpt, post } = value
  const type = NOTIFICATION_TYPES.find((candidate) => candidate === value.type)
  const actor = parseActor(value.actor)
  if (
    type === undefined ||
    actor === null ||
    typeof id !== 'string' ||
    !UUID.test(id) ||
    typeof createdAt !== 'string' ||
    typeof read !== 'boolean' ||
    !isNullableString(excerpt) ||
    !isRecord(post) ||
    typeof post.slug !== 'string' ||
    post.slug === '' ||
    typeof post.title !== 'string'
  ) {
    return null
  }
  let target: string | null = null
  if (type === 'POST_LIKED') {
    if (commentId !== null) return null
  } else {
    if (typeof commentId !== 'string' || !UUID.test(commentId)) return null
    target = commentId
  }
  return { id, type, createdAt, read, actor, post: { slug: post.slug, title: post.title }, commentId: target, excerpt }
}

/** One page of notifications; a broken or unknown notification is dropped. null when the envelope is wrong. */
export function parseNotificationPage(value: unknown): NotificationPage | null {
  if (!isRecord(value)) return null
  const { items, nextCursor, headCursor } = value
  if (!Array.isArray(items) || !isNullableString(nextCursor) || !isNullableString(headCursor)) return null
  const parsed: UserNotification[] = []
  for (const item of items) {
    const notification = parseNotification(item)
    if (notification !== null) parsed.push(notification)
  }
  return { items: parsed, nextCursor, headCursor }
}

/** "3", or "99+" past 99 (the server caps the unread count at 100). */
export function unreadLabel(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/**
 * The sentence for a failed write (mark all, delete). The backend `message` must never be shown.
 * 401 does not come here: the caller puts the session back to anonymous (`setAnonymous()`), like every 401 after an action.
 * `t` is the `Site.notifications` translator.
 */
export function notificationWriteError(status: number, code: string, t: Translator): string {
  if (code === 'NETWORK' || status === 0 || status >= 500) return t('errors.network')
  return t('errors.generic')
}
