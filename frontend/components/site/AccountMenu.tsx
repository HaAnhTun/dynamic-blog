'use client'

import { Link } from '@/i18n/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRightIcon } from '@/components/icons'
import { unreadLabel } from '@/lib/notification-copy'
import { useUnreadCount } from '@/lib/notifications-client'
import { safeReturnTo } from '@/lib/return-to'
import { logout, useSession } from '@/lib/session-client'
import type { SessionUser } from '@/lib/types'
import { Avatar } from './Avatar'
import { GitHubLoginLink } from './GitHubLoginLink'
import { FOCUS_INSET, ICON_TAP_TARGET, TRANSITION } from './SectionHeading'

/**
 * Account button in the right-hand cluster of the header, after the theme button.
 *
 * No user data in the HTML: the header renders on the server (and sits inside the cached HTML
 * of every page) in the "asking" state, then the session store asks /api/session after hydration.
 *
 * - Asking: an inert placeholder, exactly the shape of the sign-in button (36×36 below sm, with text from sm), so
 *   guests — nearly all readers — do not see the search box and theme button jump left when the session
 *   answers.
 * - Guest: a "Sign in with GitHub" link that returns to the page being read, including its query.
 * - Signed in: a disclosure button (not `role="menu"`: the items are ordinary links and buttons,
 *   reached with Tab) opening a small panel: name, @login, Profile, Admin (ADMIN and AUTHOR), Sign out.
 *
 * Below sm only the avatar (or initial letter) remains in a 36px cell, like the search box and theme button:
 * the name next to it and the arrow do not fit a 320px row. The full name is always in the button's accessible name and
 * the panel.
 *
 * Notifications: below sm there is no separate bell (a fourth 36px cell would push the header onto a second row at
 * 320px), so the avatar carries a brand-colored dot when there are unread notifications, and the panel opens with the
 * "Notifications (n)" item at every width. The button's accessible name KEEPS EXACTLY "Account: {name}" — E2E finds
 * the button by that very string; the number goes through `aria-describedby`, an sr-only sentence outside the button. From md to lg, the nav
 * moves onto the same row and the bell takes room: the name next to the avatar is hidden, kept only in the accessible name and panel.
 *
 * Do not call `useRouter` at this level: the header is also rendered in the root 404 (app/not-found.tsx) and in
 * tests there is no app router, where `useRouter` throws. Only the disclosure button, which exists only when
 * signed in, needs the router.
 */

/**
 * Same shape as the neighboring search box and theme button (Header.tsx, ThemeToggle.tsx), including the invisible 44px touch
 * area around the 36px cell (ICON_TAP_TARGET) — for the sign-in button, the account button, and their placeholder
 * (`invisible`: receives no touch).
 */
const CONTROL = `inline-flex h-11 shrink-0 items-center rounded-md md:h-9 border border-neutral-200 text-sm font-medium text-neutral-600 transition-colors duration-[120ms] hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none dark:border-neutral-800 dark:text-neutral-400 ${ICON_TAP_TARGET}`

/** Sign-in button, and the placeholder mold: icon only below sm (36×36), icon and text from sm. */
const LOGIN = `${CONTROL} w-11 justify-center gap-1.5 sm:w-auto sm:px-2.5`

/** Below sm only a 28px avatar centered in the 36px cell; from sm the (truncated) name and an arrow are added. */
const ACCOUNT_BUTTON = `${CONTROL} w-11 justify-center gap-1.5 sm:w-auto sm:justify-start sm:pr-1.5 sm:pl-1`

/** One panel item: 36px tall, full width, focus ring drawn inward (the panel has rounded corners, flush edges). */
const ITEM = `block w-full px-4 py-2 text-left text-neutral-700 hover:bg-neutral-100 hover:text-brand dark:text-neutral-300 dark:hover:bg-neutral-800 ${TRANSITION} ${FOCUS_INSET}`

export function AccountMenu() {
  const session = useSession()
  const t = useTranslations('Site.account')
  const pathname = usePathname() ?? '/'
  // Query of the page being read (/search?q=…, ?page=…, filters), so that after signing in the reader returns to exactly that result.
  // Read from `location` right as the reader is about to press (pointerdown, focus — both arrive before the
  // navigation), not through useSearchParams: on a prerendered page that hook makes the whole client tree up to the
  // nearest Suspense render on the client, i.e. the header of every static page. Tied to the path at the time
  // of reading, so moving to another page drops it. A query that fails safeReturnTo (`%2F`…) falls back to the old behavior: only the
  // path, not the home page.
  const [query, setQuery] = useState<{ pathname: string; search: string } | null>(null)
  const search = query !== null && query.pathname === pathname ? query.search : ''
  const withQuery = `${pathname}${search}`
  const returnTo = search !== '' && safeReturnTo(withQuery) !== '/' ? withQuery : pathname
  const rememberQuery = () => setQuery({ pathname, search: window.location.search })
  const loginRef = useRef<HTMLAnchorElement>(null)
  // The session at mount counts as already handled: only a sign-out that happens AFTER it may pull focus. A
  // re-mount (the page frame rebuilt) must not take focus from the person reading.
  const handled = useRef(session)

  // After sign-out — from this panel or from the /profile page — focus goes to the sign-in button
  // that just appeared, instead of falling into <body> together with the vanished Sign out button. An expired session
  // (`loggedOut: false`) does not: the user did nothing to make focus go anywhere.
  useEffect(() => {
    if (handled.current === session) return
    handled.current = session
    if (session.status === 'anonymous' && session.loggedOut) loginRef.current?.focus()
  }, [session])

  const announcement = session.status === 'anonymous' && session.loggedOut ? t('signedOut') : ''

  return (
    <>
      {session.status === 'loading' ? (
        // Fully inert: aria-hidden, nothing focusable, `invisible` keeps the exact place the sign-in button
        // will occupy. A square in place of the GitHub mark, the same 16px size.
        <span data-account-placeholder="" aria-hidden="true" className={`${LOGIN} invisible`}>
          <span className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">{t('signIn')}</span>
        </span>
      ) : session.status === 'anonymous' ? (
        <GitHubLoginLink
          ref={loginRef}
          returnTo={returnTo}
          aria-label={t('signInWithGithub')}
          onPointerDown={rememberQuery}
          onFocus={rememberQuery}
          className={LOGIN}
        >
          <span className="hidden sm:inline">{t('signIn')}</span>
        </GitHubLoginLink>
      ) : (
        <AccountDisclosure user={session.user} pathname={pathname} />
      )}
      {/* Always present, even while asking: a live region must exist BEFORE its text changes for the
          screen reader to announce it. sr-only is absolute so it takes no room in the flex row. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  )
}

function AccountDisclosure({ user, pathname }: { user: SessionUser; pathname: string }) {
  const t = useTranslations('Site.account')
  const router = useRouter()
  const panelId = useId()
  const unreadId = useId()
  // Only this (signed-in) component reads the unread count: that read is what starts the request.
  const unread = useUnreadCount()
  const unreadText = unread !== null && unread > 0 ? unreadLabel(unread) : null
  // An open panel is tied to the path at the time it opened, and changing the path closes it FOR GOOD. Leaving the page with Back/Forward
  // or the browser's Alt+← causes no pointerdown or focusout in the page, and the header does
  // not unmount; comparing only `openAt === pathname` would let Forward to the old page reopen the panel when
  // nobody clicked anything. React's "adjust state when a prop changes" pattern: compare during render, not through an
  // effect (an effect would paint the panel open once on the new page).
  const [openAt, setOpenAt] = useState<string | null>(null)
  if (openAt !== null && openAt !== pathname) setOpenAt(null)
  const open = openAt !== null
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // Guard against double clicks: state only changes on the next render, a ref changes immediately.
  const pending = useRef(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // Clicking outside or pressing Escape closes it.
  useEffect(() => {
    if (!open) return
    // `pointerdown` rather than `click`: it closes before the browser moves focus to whatever was just
    // pressed, so pressing an input on the page still leaves focus there. Focus inside the panel (about to be hidden)
    // goes to the button, not into <body>.
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && wrapper.current?.contains(event.target)) return
      const focusInPanel = panel.current?.contains(document.activeElement) ?? false
      setOpenAt(null)
      if (focusInPanel) button.current?.focus({ preventScroll: true })
    }
    // Escape listens on the whole document, not just the wrapper: Safari (and Firefox on macOS) do not focus
    // the button on a mouse click, so someone who just opened the panel has focus on <body>. Focus returns to the button when it is
    // inside the button or panel, or nowhere (<body>); if it is elsewhere on the page it is left alone.
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

  async function onLogout() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    const ok = await logout()
    if (!ok) {
      pending.current = false
      setBusy(false)
      setFailed(true)
      return
    }
    // The store became "signed out" so this component already left the tree; the router is still the app's router.
    // Focus and the "signed out" announcement are handled by AccountMenu.
    if (pathname === '/profile') router.replace('/')
  }

  return (
    <div
      ref={wrapper}
      className="relative"
      onBlur={(event) => {
        // Tab out of both the button and the panel closes it. A null `relatedTarget` (pressing somewhere unfocusable,
        // switching windows) does not: pressing outside is already handled by the `pointerdown` above, and Safari does not
        // focus the button on a click — closing here would hide the panel in the middle of a press on "Sign out".
        const next = event.relatedTarget
        if (open && next instanceof Node && !event.currentTarget.contains(next)) setOpenAt(null)
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        // The full name is here because the text on the button is truncated (and hidden below sm). It must not contain "menu": this is a
        // disclosure, and Header.test.tsx keeps the header free of any "menu" button.
        aria-label={t('accountLabel', { name: user.displayName })}
        aria-describedby={unreadText !== null ? unreadId : undefined}
        onClick={() => setOpenAt(open ? null : pathname)}
        className={ACCOUNT_BUTTON}
      >
        <span className="relative inline-flex shrink-0">
          <Avatar name={user.displayName} src={user.avatarUrl} />
          {/* "Has unread notifications" dot, only below sm (from sm the bell has its own count badge). Visual
              only: the number goes through aria-describedby. A border in the header background color separates it from the avatar. */}
          {unreadText !== null ? (
            <span
              aria-hidden="true"
              data-unread-dot=""
              className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-white sm:hidden dark:ring-neutral-950"
            />
          ) : null}
        </span>
        {/* <bdi>: the name is user-set, a right-to-left name must not reverse the order of the text
            around it. Shown at sm (the nav is still on the second row), hidden from md to lg (the nav moves onto the same row and the
            bell takes room: at 768px only about 14px is left over, Header.test.tsx records the number), then truncated at 10rem
            from lg. */}
        <bdi className="hidden max-w-[4.5rem] truncate sm:block md:hidden lg:block lg:max-w-[10rem]">{user.displayName}</bdi>
        {/* Down arrow (chevron-right rotated 90°), up when the panel is open. */}
        <ChevronRightIcon size={14} className={`hidden sm:block ${open ? '-rotate-90' : 'rotate-90'}`} />
      </button>
      {/* The button's description, only when there is something to say. Outside the button: the button's accessible name must not change. One
          sr-only span for the whole sentence (Chrome splits the name at each sr-only piece). */}
      {unreadText !== null ? (
        <span id={unreadId} className="sr-only">
          {t('unreadDescription', { count: unreadText })}
        </span>
      ) : null}

      <div
        ref={panel}
        id={panelId}
        hidden={!open}
        // Focusable by mouse (not by Tab): pressing the panel's text keeps focus inside the
        // panel, so the onBlur above does not treat it as leaving.
        tabIndex={-1}
        // Anchored to the button's right edge; at 320px never wider than the screen width minus two 1rem margins.
        className="absolute top-full right-0 z-40 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="border-b border-neutral-200 px-4 pt-1.5 pb-2.5 dark:border-neutral-800">
          <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
            <bdi>{user.displayName}</bdi>
          </p>
          {/* An account with only a password (old admin) has no GitHub login: print no line. */}
          {user.githubLogin !== null ? (
            <p className="truncate text-neutral-500 dark:text-neutral-400">@{user.githubLogin}</p>
          ) : null}
        </div>
        <ul className="py-1">
          <li>
            {/* At every width, but the only way to /notifications below sm. The visible number
                is in the link's name: "Notifications (3)". */}
            <Link href="/notifications" onClick={() => setOpenAt(null)} className={ITEM}>
              {unreadText !== null ? t('notificationsWithCount', { count: unreadText }) : t('notifications')}
            </Link>
          </li>
          <li>
            <Link href="/profile" onClick={() => setOpenAt(null)} className={ITEM}>
              {t('profile')}
            </Link>
          </li>
          <li>
            <Link href="/bookmarks" onClick={() => setOpenAt(null)} className={ITEM}>
              {t('bookmarks')}
            </Link>
          </li>
          {user.canAccessAdmin ? (
            <li>
              {/* Plain <a>: /admin is a different application (its own layout, proxy, admin session), a
                  full page load is correct; prefetching it from every public page is not. */}
              <a href="/admin" className={ITEM}>
                {t('admin')}
              </a>
            </li>
          ) : null}
        </ul>
        <div className="border-t border-neutral-200 pt-1 dark:border-neutral-800">
          <button type="button" onClick={onLogout} aria-disabled={busy} className={ITEM}>
            {busy ? t('signingOut') : t('signOut')}
          </button>
          {failed ? (
            <p role="alert" className="px-4 pt-1 pb-2 text-red-700 dark:text-red-300">
              {t('signOutFailed')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
