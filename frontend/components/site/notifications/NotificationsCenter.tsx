'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { XIcon } from '@/components/icons'
import { callBff } from '@/lib/bff-client'
import { needsLogin } from '@/lib/interaction-errors'
import { notificationWriteError, parseNotificationPage } from '@/lib/notification-copy'
import { applyUnread, parseUnreadCount, refreshUnread, useUnreadCount } from '@/lib/notifications-client'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { NotificationPage, UserNotification } from '@/lib/types'
import { GitHubLoginLink } from '../GitHubLoginLink'
import { FOCUS_RING, TRANSITION } from '../SectionHeading'
import { NotificationItem } from './NotificationItem'

/**
 * Content of /notifications: every notification of the person reading, filtered all / unread,
 * mark all as read, delete one by one, "see more" by keyset cursor.
 *
 * A client island in a static page, like ProfileCard: the page does not read cookies, so its HTML is identical
 * for everyone. The session comes from the client-side store after hydration; the list part — which asks the unread count
 * and calls /api/notifications — only mounts when signed in, so guests and the moment the session is being asked send no
 * notification request.
 *
 * Every write is SERVER CONFIRMED: the list only changes once the server has answered, and the count returned goes straight into the
 * bell (`applyUnread`). The only exception is clicking open a notification (NotificationItem): the page is left at once.
 *
 * Focus always has somewhere to go: the first newly loaded notification; after a delete, the next notification's link, otherwise
 * the previous one, otherwise the page heading — but only while focus is still where the reader just clicked delete (or
 * has fallen back to <body>). The live region announces "notification deleted" and "all marked as read".
 *
 * Deleting the last loaded items while the server still has a later page: the page reloads the first page (the remaining notifications
 * move up), and never says "you have no notifications" while some remain.
 */

const PAGE_SIZE = 20

type Filter = 'all' | 'unread'

type ListState = { status: 'loading' } | { status: 'failed' } | ({ status: 'ready' } & NotificationPage)

type FocusTarget = { kind: 'item'; id: string } | { kind: 'heading' }

type Outcome = { kind: 'page'; page: NotificationPage } | { kind: 'login' } | { kind: 'failed' }

/** The same primary button style as /login and /profile. */
const PRIMARY = `inline-flex items-center gap-2 rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:border-brand hover:bg-brand dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

/** A secondary bordered button, 40px on phones (mark all as read, "see more", retry). */
const SECONDARY = `inline-flex h-10 items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-brand hover:text-brand aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:h-9 dark:border-neutral-700 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

/**
 * One button of the filter. Selected: a dark background, light text — differing by background, not only by text color.
 * `aria-pressed:` comes after `hover:` in Tailwind's CSS, so a selected button does not change color on hover.
 */
const FILTER = `inline-flex h-9 items-center rounded px-3 text-sm font-medium text-neutral-600 hover:text-brand aria-pressed:bg-neutral-900 aria-pressed:text-white dark:text-neutral-400 dark:aria-pressed:bg-neutral-100 dark:aria-pressed:text-neutral-900 ${TRANSITION} ${FOCUS_RING}`

/** The delete button: a 40×40 cell (tap target), icon only; the accessible name says whose notification it deletes. */
const DELETE = `inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-red-700 aria-disabled:cursor-wait aria-disabled:opacity-60 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-red-300 ${TRANSITION} ${FOCUS_RING}`

function listUrl(filter: Filter, after: string | null): string {
  const query = new URLSearchParams({ size: String(PAGE_SIZE), unread: String(filter === 'unread') })
  if (after !== null) query.set('after', after)
  return `/api/notifications?${query}`
}

/**
 * `items` with the `incoming` items it lacks appended. A notification may be on both pages (a delete in another tab shifts
 * the pages): each id once.
 */
function appendFresh(items: UserNotification[], incoming: UserNotification[]): UserNotification[] {
  const known = new Set(items.map((item) => item.id))
  return [...items, ...incoming.filter((item) => !known.has(item.id))]
}

async function fetchPage(filter: Filter, after: string | null): Promise<Outcome> {
  const result = await callBff<unknown>(listUrl(filter, after))
  if (!result.ok) return needsLogin(result.code, result.status) ? { kind: 'login' } : { kind: 'failed' }
  const page = parseNotificationPage(result.data)
  return page === null ? { kind: 'failed' } : { kind: 'page', page }
}

export function NotificationsCenter({ headingId }: { headingId: string }) {
  const session = useSession()
  const t = useTranslations('Site.notifications')

  if (session.status === 'loading') {
    // Reserve a few lines so the page does not jump when the session answers. No text, nothing to focus.
    return (
      <div aria-busy="true" className="mt-8 space-y-4">
        {[0, 1, 2].map((row) => (
          <span key={row} aria-hidden="true" className="flex items-start gap-3">
            <span className="h-7 w-7 shrink-0 rounded-full bg-neutral-100 dark:bg-neutral-900" />
            <span className="flex-1 space-y-2">
              <span className="block h-4 w-3/4 rounded bg-neutral-100 dark:bg-neutral-900" />
              <span className="block h-3 w-1/3 rounded bg-neutral-100 dark:bg-neutral-900" />
            </span>
          </span>
        ))}
      </div>
    )
  }

  if (session.status === 'anonymous') {
    return (
      <div className="mt-8">
        <p className="text-neutral-700 dark:text-neutral-300">{t('center.signInPrompt')}</p>
        <GitHubLoginLink returnTo="/notifications" className={`${PRIMARY} mt-4`}>
          {t('center.signIn')}
        </GitHubLoginLink>
      </div>
    )
  }

  return <Inbox headingId={headingId} />
}

function Inbox({ headingId }: { headingId: string }) {
  const t = useTranslations('Site.notifications')
  const unread = useUnreadCount()
  const [filter, setFilter] = useState<Filter>('all')
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle')
  // The reference instant for the relative time: set when data arrives, and once every minute.
  const [now, setNow] = useState(0)
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set())
  const [itemError, setItemError] = useState<{ id: string; message: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // Number of the latest first-page load (filter change, retry): the answer of an older load is dropped, including a "see
  // more" that started on the old list.
  const loadSeq = useRef(0)
  // A "see more" in flight, carrying the number of the list it continues: it only blocks another click on that SAME list.
  const moreInFlight = useRef<number | null>(null)
  const markPending = useRef(false)
  const deletePending = useRef(new Set<string>())
  // Notifications already deleted on the server (including 404). `latest` only changes after the next render, so two
  // deletes settling in the same tick see each other through here: when choosing where to put focus, and when judging whether the list is empty.
  const removed = useRef(new Set<string>())
  const focusTarget = useRef<FocusTarget | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The newest state for async functions: a late result is computed on the list at the time it arrives, not at the time of the click.
  const latest = useRef(list)
  const filterNow = useRef(filter)

  useEffect(() => {
    latest.current = list
  }, [list])

  useEffect(() => {
    filterNow.current = filter
  }, [filter])

  /** The first page of `next`. State is only set after the server answers (the caller draws "loading" itself if needed). */
  function loadFirst(next: Filter): void {
    const seq = ++loadSeq.current
    void fetchPage(next, null).then((outcome) => {
      if (seq !== loadSeq.current) return
      if (outcome.kind === 'login') {
        setAnonymous()
        return
      }
      setNow(Date.now())
      if (outcome.kind === 'failed') {
        setList({ status: 'failed' })
        return
      }
      setList({ status: 'ready', ...outcome.page })
      // The bell must match the list the reader is seeing.
      void refreshUnread()
    })
  }

  const onMount = useEffectEvent(() => loadFirst('all'))
  useEffect(() => {
    onMount()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  /** The link of notification `id` in the list being drawn. */
  function linkOf(id: string): HTMLElement | null {
    const links = listRef.current?.querySelectorAll<HTMLElement>('a[data-notification-id]') ?? []
    return Array.from(links).find((link) => link.dataset.notificationId === id) ?? null
  }

  // Move focus to the scheduled place, after that element has entered the DOM.
  useEffect(() => {
    const target = focusTarget.current
    if (target === null) return
    focusTarget.current = null
    if (target.kind === 'heading') document.getElementById(headingId)?.focus()
    else linkOf(target.id)?.focus()
  })

  /** Reloads the first page of the selected filter: retry, a filter change, and after a "mark all as read". */
  function reload(next: Filter): void {
    setList({ status: 'loading' })
    setMore('idle')
    setItemError(null)
    loadFirst(next)
  }

  function changeFilter(next: Filter) {
    if (next === filter) return
    setFilter(next)
    setMarkError(null)
    reload(next)
  }

  async function loadMore() {
    const base = latest.current
    const seq = loadSeq.current
    if (base.status !== 'ready' || base.nextCursor === null || moreInFlight.current === seq) return
    moreInFlight.current = seq
    setMore('loading')
    const outcome = await fetchPage(filter, base.nextCursor)
    if (moreInFlight.current === seq) moreInFlight.current = null
    if (seq !== loadSeq.current) return
    if (outcome.kind === 'login') {
      setAnonymous()
      return
    }
    if (outcome.kind === 'failed') {
      setMore('failed')
      return
    }
    const current = latest.current
    if (current.status !== 'ready') return
    const fresh = appendFresh(current.items, outcome.page.items).slice(current.items.length)
    if (fresh.length > 0) focusTarget.current = { kind: 'item', id: fresh[0]!.id }
    else if (outcome.page.nextCursor === null && current.items.length > 0) {
      // The "see more" button holding focus is about to disappear with nothing new: focus goes to the last item.
      focusTarget.current = { kind: 'item', id: current.items[current.items.length - 1]!.id }
    }
    setMore('idle')
    setNow(Date.now())
    // A functional update: a delete settling in the same tick as this page is not overwritten by the old list.
    setList((state) =>
      state.status === 'ready'
        ? { ...state, items: appendFresh(state.items, outcome.page.items), nextCursor: outcome.page.nextCursor }
        : state,
    )
  }

  const loadedUnread = list.status === 'ready' && list.items.some((item) => !item.read)
  // Only once the list has arrived: while loading or after a failed load there is no `headCursor`, and sending without `before`
  // marks even notifications the reader has never seen. The bell blocks the same way.
  const canMarkAll = list.status === 'ready' && ((unread ?? 0) > 0 || loadedUnread)

  /**
   * Only up to the newest loaded notification (`before=headCursor`): notifications arriving after the page loaded stay
   * unread. When the list (arrived) is empty, `before` is not sent.
   */
  async function markAll() {
    const base = latest.current
    if (markPending.current || !canMarkAll || base.status !== 'ready') return
    const seq = loadSeq.current
    markPending.current = true
    setMarking(true)
    setMarkError(null)
    setAnnouncement('')
    const before = base.headCursor
    const result = await callBff<unknown>(
      before === null ? '/api/notifications/read-all' : `/api/notifications/read-all?before=${encodeURIComponent(before)}`,
      { method: 'POST' },
    )
    markPending.current = false
    setMarking(false)
    if (!result.ok) {
      if (needsLogin(result.code, result.status)) setAnonymous()
      else setMarkError(notificationWriteError(result.status, result.code, t))
      return
    }
    const next = parseUnreadCount(result.data)
    if (next !== null) applyUnread(next)
    setAnnouncement(t('markedAll'))
    if (seq !== loadSeq.current || (next !== null && next > 0)) {
      // The list changed while waiting (a filter change), or new notifications arrived after loading: fetch the first page again.
      reload(filterNow.current)
      return
    }
    // Every loaded notification came before `before`, so all are now read. Under the unread filter the list is entirely empty,
    // including the pages not yet loaded.
    setList((current) =>
      current.status !== 'ready'
        ? current
        : filterNow.current === 'unread'
          ? { ...current, items: [], nextCursor: null }
          : { ...current, items: current.items.map((item) => (item.read ? item : { ...item, read: true })) },
    )
  }

  async function remove(notification: UserNotification) {
    const { id } = notification
    if (deletePending.current.has(id)) return
    deletePending.current.add(id)
    setDeleting(new Set(deletePending.current))
    setItemError(null)
    setAnnouncement('')
    const result = await callBff<unknown>(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' })
    deletePending.current.delete(id)
    setDeleting(new Set(deletePending.current))
    // 404: already deleted in another tab — it is gone, so also drop it from the list.
    if (!result.ok && result.status !== 404) {
      if (needsLogin(result.code, result.status)) setAnonymous()
      else setItemError({ id, message: notificationWriteError(result.status, result.code, t) })
      return
    }
    removed.current.add(id)
    const next = result.ok ? parseUnreadCount(result.data) : null
    if (next !== null) applyUnread(next)
    else void refreshUnread()
    const current = latest.current
    const index = current.status === 'ready' ? current.items.findIndex((item) => item.id === id) : -1
    if (current.status === 'ready' && index !== -1) {
      // The row is about to disappear along with the delete button holding focus. If focus moved elsewhere while waiting, leave it alone.
      const row = linkOf(id)?.closest('li') ?? null
      const active = document.activeElement
      if (active === null || active === document.body || (row !== null && row.contains(active))) {
        // Skip an item that is also being deleted or has just been deleted: it is about to disappear too.
        const staying = (item: UserNotification) => !deletePending.current.has(item.id) && !removed.current.has(item.id)
        const neighbour = current.items.slice(index + 1).find(staying) ?? current.items.slice(0, index).reverse().find(staying)
        focusTarget.current = neighbour === undefined ? { kind: 'heading' } : { kind: 'item', id: neighbour.id }
      }
    }
    // This delete takes away the last loaded item (the others are already deleted DONE, not just pending) while the server still has
    // a later page: the empty list would say "no notifications yet" and hide "see more" too.
    const emptied =
      current.status === 'ready' &&
      index !== -1 &&
      current.nextCursor !== null &&
      current.items.every((item) => removed.current.has(item.id))
    // A functional update: two deletes settling in the same tick must not overwrite each other with the old list.
    setList((state) => (state.status === 'ready' ? { ...state, items: state.items.filter((item) => item.id !== id) } : state))
    setAnnouncement(t('center.deleted'))
    // Reload the first page instead: the remaining notifications move up. If focus is still on the row just deleted it is already scheduled on
    // the page heading (no item left beside it), so it does not fall to <body> during "loading".
    if (emptied) reload(filterNow.current)
  }

  function onOpen(notification: UserNotification) {
    setList((current) =>
      current.status === 'ready'
        ? {
            ...current,
            items: current.items.map((item) => (item.id === notification.id ? { ...item, read: true } : item)),
          }
        : current,
    )
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label={t('center.filterLabel')}
          className="inline-flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-800"
        >
          <button type="button" aria-pressed={filter === 'all'} onClick={() => changeFilter('all')} className={FILTER}>
            {t('center.filterAll')}
          </button>
          <button type="button" aria-pressed={filter === 'unread'} onClick={() => changeFilter('unread')} className={FILTER}>
            {t('center.filterUnread')}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void markAll()}
          // Not `disabled`: a button holding focus is not kicked back to <body> when nothing unread is left.
          aria-disabled={!canMarkAll || marking || undefined}
          className={SECONDARY}
        >
          {marking ? t('center.marking') : t('markAll')}
        </button>
      </div>
      {markError !== null ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {markError}
        </p>
      ) : null}

      <div className="mt-6">
        {list.status === 'loading' ? (
          <p aria-busy="true" className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
            {t('loading')}
          </p>
        ) : list.status === 'failed' ? (
          <div className="py-8 text-center">
            <p className="text-neutral-700 dark:text-neutral-300">{t('loadFailed')}</p>
            <button
              type="button"
              onClick={() => {
                // The retry button makes room for the loading text: focus goes to the page heading instead of falling to <body>.
                focusTarget.current = { kind: 'heading' }
                reload(filter)
              }}
              className={`${SECONDARY} mt-4`}
            >
              {t('retry')}
            </button>
          </div>
        ) : list.items.length === 0 ? (
          <p className="py-8 text-center text-neutral-600 dark:text-neutral-400">
            {filter === 'unread' ? t('center.emptyUnread') : t('center.emptyAll')}
          </p>
        ) : (
          <>
            <ul
              ref={listRef}
              className="divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800"
            >
              {list.items.map((notification) => (
                <li key={notification.id} className="flex flex-wrap items-start gap-x-1 py-2">
                  <div className="min-w-0 flex-1">
                    <NotificationItem notification={notification} now={now} variant="page" onOpen={onOpen} />
                  </div>
                  <button
                    type="button"
                    aria-label={t('center.deleteLabel', { name: notification.actor.displayName })}
                    aria-disabled={deleting.has(notification.id) || undefined}
                    onClick={() => void remove(notification)}
                    className={`${DELETE} mt-1`}
                  >
                    <XIcon />
                  </button>
                  {itemError?.id === notification.id ? (
                    <p role="alert" className="basis-full px-2 pt-1 text-sm text-red-700 dark:text-red-300">
                      {itemError.message}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            {list.nextCursor !== null ? (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  aria-disabled={more === 'loading' || undefined}
                  className={SECONDARY}
                >
                  {more === 'loading' ? t('loading') : t('center.loadMore')}
                </button>
                {more === 'failed' ? (
                  <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
                    {t('loadFailed')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Always present, empty when there is nothing to say: a live region must exist BEFORE its text changes. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
