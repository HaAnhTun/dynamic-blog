'use client'

import { Link } from '@/i18n/navigation'
import { usePathname } from '@/i18n/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BellIcon } from '@/components/icons'
import { callBff } from '@/lib/bff-client'
import { needsLogin } from '@/lib/interaction-errors'
import { notificationWriteError, parseNotificationPage, unreadLabel } from '@/lib/notification-copy'
import { applyUnread, parseUnreadCount, refreshUnread, useUnreadCount } from '@/lib/notifications-client'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { UserNotification } from '@/lib/types'
import { NotificationItem } from './notifications/NotificationItem'
import { FOCUS_INSET, ICON_SLOT, ICON_TAP_TARGET, TRANSITION } from './SectionHeading'

/**
 * The notification bell in the header's right-hand group, between the theme button and the account button.
 *
 * - Guests and while the session is still being asked: NOTHING AT ALL, not even a wrapper — the header's `gap-2` group stays exactly as
 *   before, and no notification request is sent. Only `BellControl`, which mounts only when signed in,
 *   reads the unread count (lib/notifications-client.ts starts asking at that read).
 * - Only from sm (`hidden sm:block` on its own root; `display:none` takes no `gap` slot). Measured with real
 *   Inter (Header.test.tsx records the numbers): at 320px the first row already uses 281.7 of 288px, a fourth 36px slot makes the header
 *   wrap. Below sm, the dot on the avatar and the notifications item (n) in the account panel replace it.
 * - A 36×36 button, the same shape as the search slot and the theme button. Name: the notifications label, or the label with ", 3 unread"; the count
 *   badge (`99+` past 99) is only for the eye (`aria-hidden`), only when greater than 0.
 * - A disclosure like the account panel (no `role="menu"`: the items are links, reached by Tab): closes on clicking
 *   outside, Escape (focus returns to the button), Tab out of it, or a page change.
 * - Opening: GET the 6 newest notifications (and ask the unread count again, so the badge matches the list), "mark all
 *   as read" (server confirmed, only up to the newest loaded notification: `before=headCursor`), "see all
 *   notifications" to /notifications. A 401 here comes after a reader action: the session becomes guest as before.
 */

const PANEL_SIZE = 6

/**
 * Same mold as the search slot and the theme button. The focus ring color is preset, only the width follows `focus-visible`:
 * Tailwind 4's `transition-colors` also transitions `outline-color`, so setting the color on focus makes the ring fade in
 * from the text color (measured at /admin on 2026-10-07).
 *
 * ICON_TAP_TARGET also carries the `relative` that the count badge needs: an invisible 44px tap area, the slot stays 36px.
 */
const BELL = `inline-flex ${ICON_SLOT} shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-600 outline-brand hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 aria-expanded:border-brand aria-expanded:text-brand dark:border-neutral-800 dark:text-neutral-400 ${ICON_TAP_TARGET} ${TRANSITION}`

/**
 * Count badge, overflowing the button's top-right corner. White text on brand on the light background (4.8:1); on the dark background brand
 * is a light blue, so the text is near-black. A border in the header's background color separates it from the button's border.
 */
const BADGE =
  'absolute -top-1.5 -right-1.5 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-brand px-1 text-[0.6875rem] leading-none font-semibold text-white tabular-nums ring-2 ring-white dark:text-neutral-950 dark:ring-neutral-950'

/** A text button in the panel (mark all as read, retry). */
const TEXT_BUTTON = `rounded-sm text-sm font-medium text-brand outline-brand hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 aria-disabled:cursor-wait aria-disabled:opacity-70 ${TRANSITION}`

type PanelList =
  { status: 'loading' } | { status: 'failed' } | { status: 'ready'; items: UserNotification[]; headCursor: string | null }

export function NotificationBell() {
  const session = useSession()
  if (session.status !== 'authenticated') return null
  return <BellControl />
}

function BellControl() {
  const t = useTranslations('Site.notifications')
  const pathname = usePathname() ?? '/'
  const unread = useUnreadCount()
  const panelId = useId()
  const titleId = useId()
  // The open panel is tied to the path at the time of opening; changing the path closes it fully (same pattern as the account panel, including the
  // reason for comparing during render rather than in an effect).
  const [openAt, setOpenAt] = useState<string | null>(null)
  if (openAt !== null && openAt !== pathname) setOpenAt(null)
  const open = openAt !== null
  const [list, setList] = useState<PanelList>({ status: 'loading' })
  const [now, setNow] = useState(0)
  const [marking, setMarking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // Number of the latest load: the answer of an older opening is dropped.
  const loadSeq = useRef(0)
  // Block a double click: state only changes on the next render, a ref changes immediately.
  const markPending = useRef(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // `pointerdown`, not `click`: close before the browser moves focus to the thing just clicked. If focus
    // is inside the panel (about to be hidden) it goes to the button, not to <body>.
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && wrapper.current?.contains(event.target)) return
      const focusInPanel = panel.current?.contains(document.activeElement) ?? false
      setOpenAt(null)
      if (focusInPanel) button.current?.focus({ preventScroll: true })
    }
    // Escape is listened to on document too: Safari does not focus the button on a mouse click, so a person who just clicked to open the panel has focus
    // on <body>. Focus returns to the button when it is in the button or panel, or on <body>; elsewhere it is left alone.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return
      const active = document.activeElement
      const returnFocus = active === null || active === document.body || (wrapper.current?.contains(active) ?? false)
      setOpenAt(null)
      if (returnFocus) button.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  async function load() {
    const seq = ++loadSeq.current
    setList({ status: 'loading' })
    setError(null)
    void refreshUnread()
    const result = await callBff<unknown>(`/api/notifications?size=${PANEL_SIZE}`)
    if (seq !== loadSeq.current) return
    if (!result.ok && needsLogin(result.code, result.status)) {
      setAnonymous()
      return
    }
    const page = result.ok ? parseNotificationPage(result.data) : null
    setNow(Date.now())
    setList(page === null ? { status: 'failed' } : { status: 'ready', items: page.items, headCursor: page.headCursor })
  }

  function toggle() {
    if (open) {
      setOpenAt(null)
      return
    }
    setOpenAt(pathname)
    void load()
  }

  /** Only the notifications the reader has seen: `before` is the newest notification of the open list. */
  async function markAll() {
    if (markPending.current || list.status !== 'ready') return
    markPending.current = true
    setMarking(true)
    setError(null)
    setAnnouncement('')
    const before = list.headCursor
    const result = await callBff<unknown>(
      before === null ? '/api/notifications/read-all' : `/api/notifications/read-all?before=${encodeURIComponent(before)}`,
      { method: 'POST' },
    )
    markPending.current = false
    setMarking(false)
    if (!result.ok) {
      if (needsLogin(result.code, result.status)) setAnonymous()
      else setError(notificationWriteError(result.status, result.code, t))
      return
    }
    const next = parseUnreadCount(result.data)
    if (next !== null) applyUnread(next)
    setList((current) =>
      current.status === 'ready'
        ? { ...current, items: current.items.map((item) => (item.read ? item : { ...item, read: true })) }
        : current,
    )
    setAnnouncement(t('markedAll'))
    // Unread notifications remain after the panel opened (new arrivals): reload so they show, with a new `headCursor`.
    if (next !== null && next > 0) void load()
    // The button just clicked disappears — nothing unread is left, or the list is reloading: focus stays inside the panel
    // instead of falling to <body>.
    keepFocusInPanel()
  }

  /** If focus is in the panel (or on <body>, Safari), keep it on the panel itself when the element holding focus is about to go. */
  function keepFocusInPanel() {
    const active = document.activeElement
    if (active === null || active === document.body || (panel.current?.contains(active) ?? false)) {
      panel.current?.focus()
    }
  }

  function retry() {
    void load()
    // The retry button makes room for the loading text.
    keepFocusInPanel()
  }

  function onOpen(notification: UserNotification, here: boolean) {
    // Ctrl/⌘-click opens it in another tab: this tab stays where it is, the panel stays open so the reader can open more.
    if (here) setOpenAt(null)
    setList((current) =>
      current.status === 'ready'
        ? {
            ...current,
            items: current.items.map((item) => (item.id === notification.id ? { ...item, read: true } : item)),
          }
        : current,
    )
  }

  const count = unread !== null && unread > 0 ? unreadLabel(unread) : null
  const canMarkAll = list.status === 'ready' && (count !== null || list.items.some((item) => !item.read))

  return (
    <div
      ref={wrapper}
      className="relative hidden sm:block"
      onBlur={(event) => {
        // Tab out of both the button and the panel closes it. A null `relatedTarget` (a click on something unfocusable) does
        // not: the `pointerdown` above handles that, and Safari does not focus the button on a click.
        const next = event.relatedTarget
        if (open && next instanceof Node && !event.currentTarget.contains(next)) setOpenAt(null)
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={count === null ? t('bell.label') : t('bell.labelUnread', { count })}
        onClick={toggle}
        className={BELL}
      >
        <BellIcon />
        {count !== null ? (
          <span aria-hidden="true" data-unread-badge="" className={BADGE}>
            {count}
          </span>
        ) : null}
      </button>
      {/* Outside the panel: still readable after the panel closes. sr-only is absolute so it takes no room. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <div
        ref={panel}
        id={panelId}
        hidden={!open}
        // Focusable by mouse (not by Tab): clicking the panel's text keeps focus inside the panel.
        tabIndex={-1}
        className="absolute top-full right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-neutral-200 bg-white text-sm shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <p id={titleId} className="font-semibold text-neutral-900 dark:text-neutral-100">
            {t('bell.title')}
          </p>
          {canMarkAll ? (
            <button type="button" onClick={() => void markAll()} aria-disabled={marking || undefined} className={TEXT_BUTTON}>
              {t('markAll')}
            </button>
          ) : null}
        </div>
        {error !== null ? (
          <p role="alert" className="px-4 pt-2 text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {/* Scrolls inside when the six items are taller than the screen: the panel never runs past the bottom edge. */}
        <div className="max-h-[calc(100vh-10rem)] overflow-y-auto">
          {list.status === 'loading' ? (
            <p aria-busy="true" className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400">
              {t('loading')}
            </p>
          ) : list.status === 'failed' ? (
            <div className="px-4 py-6 text-center">
              <p className="text-neutral-700 dark:text-neutral-300">{t('loadFailed')}</p>
              <button type="button" onClick={retry} className={`${TEXT_BUTTON} mt-2`}>
                {t('retry')}
              </button>
            </div>
          ) : list.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-neutral-600 dark:text-neutral-400">{t('bell.empty')}</p>
          ) : (
            <ul aria-labelledby={titleId} className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {list.items.map((notification) => (
                <li key={notification.id}>
                  <NotificationItem notification={notification} now={now} variant="panel" onOpen={onOpen} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-neutral-200 dark:border-neutral-800">
          <Link
            href="/notifications"
            onClick={() => setOpenAt(null)}
            // neutral-50 rather than 100 on hover: brand text on neutral-100 is only 4.45:1.
            className={`block px-4 py-2.5 text-center font-medium text-brand hover:bg-neutral-50 dark:hover:bg-neutral-800 ${TRANSITION} ${FOCUS_INSET}`}
          >
            {t('bell.viewAll')}
          </Link>
        </div>
      </div>
    </div>
  )
}
