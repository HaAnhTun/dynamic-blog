'use client'

import { Link } from '@/i18n/navigation'
import { usePathname } from '@/i18n/navigation'
import type { MouseEvent } from 'react'
import { requestCommentTarget } from '@/lib/comment-target'
import { formatLocalDateTime } from '@/lib/local-time'
import { notificationCopy, notificationHref } from '@/lib/notification-copy'
import { markNotificationRead } from '@/lib/notifications-client'
import { relativeTime } from '@/lib/relative-time'
import type { UserNotification } from '@/lib/types'
import { postPath } from '../ArticleJsonLd'
import { Avatar } from '../Avatar'
import { FOCUS_INSET, FOCUS_RING, TRANSITION } from '../SectionHeading'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/**
 * A notification, shared by the bell's panel and the /notifications page.
 *
 * The whole item is ONE link to the post, or to the exact comment (`#comment-<uuid>`): a 28px avatar, the sentence
 * "<b>Name</b> did … “Post title”." (in the site language), the comment's excerpt (pale, at most two lines, a long URL still wraps at
 * 320px), then the relative time in `<time dateTime title="14:30, 08/10/2026">` — the /notifications page
 * additionally shows the full time as secondary text (on a phone nobody can see a `title`).
 *
 * Unread: a faint brand-colored background and a VISIBLE "new" label, inside the link's name — there is no
 * `sr-only` fragment in the link (Chrome splits the accessible name at each `sr-only` fragment, measured at /admin on 2026-10-07).
 *
 * Click (mouse, tap, Enter): an unread notification is marked read fire-and-forget, `keepalive`, because the page
 * is being left (lib/notifications-client.ts); `onOpen` lets the container that draws it show it as read at once (the only optimistic
 * part of the feature: the real count arrives later through `applyUnread`) and close the panel. When already on that very post, `<Link>`
 * only changes the hash with `pushState` — the comments section does not remount, no `hashchange` — so this item asks the comments
 * section to find the target comment (`requestCommentTarget`).
 *
 * Ctrl/⌘/Shift/Alt-click (or a mouse button other than the main one) opens the notification in another tab or window: next/link leaves it to
 * the browser, this tab stays where it is. It still marks as read — the reader opened it — but does not ask the comments
 * section of THIS tab to jump to the target comment, and reports to the container that the page was not left (`here` false: the panel
 * stays open so more can be opened).
 */

export type NotificationItemVariant = 'panel' | 'page'

const BASE = `flex min-w-0 items-start gap-3 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/70 ${TRANSITION}`

const LINK: Record<NotificationItemVariant, string> = {
  // Full width of the panel, the focus ring drawn inward (the panel has rounded corners, the list scrolls): like the account
  // panel's items.
  panel: `${BASE} px-4 py-3 ${FOCUS_INSET}`,
  page: `${BASE} rounded-md p-2 sm:p-3 ${FOCUS_RING}`,
}

/**
 * Unread: brand background at 5% (10% on the dark background). Not stronger: the neutral-600 secondary text must stay above 4.5:1, and
 * the "new" label already says it in words — background color is never the only signal.
 */
const UNREAD = 'bg-brand/5 dark:bg-brand/10'

/**
 * The "new" label: white text on brand (4.8:1) on the light background; the dark background's brand is a light blue #4da3ff, white text
 * on it is only 2.6:1, so the text switches to near-black (7.5:1).
 */
const NEW_BADGE = 'rounded-full bg-brand px-1.5 py-px text-[0.6875rem] leading-4 font-semibold text-white dark:text-neutral-950'

/** Two paths differing only in encoding (a slug with diacritics) are still one page. */
function samePath(a: string, b: string): boolean {
  const decode = (path: string) => {
    try {
      return decodeURIComponent(path)
    } catch {
      return path
    }
  }
  return decode(a) === decode(b)
}

/**
 * Click with Ctrl/⌘/Shift/Alt, or with a mouse button other than the main one: "open in a new tab", "open in a new window", "download"…
 * — exactly the clicks that next/link does not navigate itself (its `isModifiedEvent`).
 */
function opensElsewhere(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

export function NotificationItem({
  notification,
  now,
  variant,
  onOpen,
}: {
  notification: UserNotification
  /** The "now" instant for the relative time (ms). */
  now: number
  variant: NotificationItemVariant
  /**
   * The reader just opened this notification: draw it as read. `here`: opened right in this tab (close the panel); false when
   * it opens in another tab or window.
   */
  onOpen: (notification: UserNotification, here: boolean) => void
}) {
  const pathname = usePathname() ?? '/'
  const { actor, post, excerpt, read } = notification
  const t = useTranslations('Site.notifications')
  const tTime = useTranslations('Site.time')
  const { lead, tail } = notificationCopy(notification.type, t)
  const locale = asLocale(useLocale())
  const absolute = formatLocalDateTime(notification.createdAt)
  const relative = relativeTime(notification.createdAt, now, locale, tTime)

  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (!read) void markNotificationRead(notification.id)
    const here = !opensElsewhere(event)
    onOpen(notification, here)
    if (here && notification.commentId !== null && samePath(postPath(post.slug), pathname)) {
      requestCommentTarget(notification.commentId)
    }
  }

  return (
    <Link
      href={notificationHref(notification)}
      onClick={open}
      data-notification-id={notification.id}
      className={read ? LINK[variant] : `${LINK[variant]} ${UNREAD}`}
    >
      <Avatar name={actor.displayName} src={actor.avatarUrl} size={28} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-200">
          <strong className="font-semibold text-neutral-900 dark:text-neutral-100">
            <bdi>{actor.displayName}</bdi>
          </strong>{' '}
          {lead} “{post.title}”{tail}
        </span>
        {excerpt !== null ? (
          <span className="mt-1 line-clamp-2 text-neutral-600 [overflow-wrap:anywhere] dark:text-neutral-400">{excerpt}</span>
        ) : null}
        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          {relative !== null ? (
            <time dateTime={notification.createdAt} title={absolute ?? undefined}>
              {relative}
            </time>
          ) : null}
          {variant === 'page' && absolute !== null ? (
            <>
              {relative !== null ? <span aria-hidden="true">·</span> : null}
              <span>{absolute}</span>
            </>
          ) : null}
          {read ? null : <span className={NEW_BADGE}>{t('item.new')}</span>}
        </span>
      </span>
    </Link>
  )
}
