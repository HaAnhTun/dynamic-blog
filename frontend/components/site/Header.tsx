'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { usePathname } from '@/i18n/navigation'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { AccountMenu } from './AccountMenu'
import { Container } from './Container'
import { LanguageSwitcher } from './LanguageSwitcher'
import { NotificationBell } from './NotificationBell'
import { BAR_FRAME } from './reader/reader-layout'
import { ICON_SLOT, ICON_TAP_TARGET, TAP_TARGET } from './SectionHeading'
import { navItems, type NavItem } from './nav-items'
import { ThemeToggle } from './ThemeToggle'
import { useStickyHeader } from './useStickyHeader'

// Navigation data lives in a regular module: the server-side search route handler reads it too,
// and a 'use client' module only gives the server a client reference, not the data.
export { navItems, type NavItem } from './nav-items'

/**
 * Prefix matching on a path-segment boundary.
 *
 * The prefix test is `=== prefix || startsWith(prefix + '/')`, not
 * `startsWith(prefix)`. The looser form marks the writing item current on a future
 * `/writing-tips` route, because that string does start with '/writing'.
 *
 * The same boundary is what keeps '/' honest. `pathname.startsWith(item.href)` is wrong
 * for a link to '/': every path on the site starts with '/', so it would be current on
 * every page. With the boundary, a '/' prefix becomes '//', which no real path starts
 * with, so '/' matches only itself — the reason the old `exact` flag could go when the
 * home item did.
 */
export function isCurrentSection(pathname: string, item: NavItem): boolean {
  const prefixes = [item.href, ...(item.owns ?? [])]
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

const LINK_BASE =
  'rounded-sm transition-colors duration-[120ms] hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none'

/** SearchForm's keyword field (`id="search-q"`). Header.test.tsx renders both so the two ids do not drift apart. */
const SEARCH_FIELD_ID = 'search-q'

/**
 * Where "/" is a character the reader is typing, or belongs to another context: an input, a select, an
 * editing area, and a dialog (the enlarged image at /gallery is a modal `<dialog>`, the rest of the page
 * is inert, so the page-wide shortcut must not leak into it).
 */
const NOT_A_SHORTCUT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog'

/**
 * The quick search panel is a lazy chunk: a direct `import()` instead of `next/dynamic`, because dynamic has no
 * preload and caches a failed load forever (React.lazy) and throws it into the error boundary. A failed load is retried
 * next time; the person who clicked is sent to `/search`.
 */
type PaletteModule = typeof import('./search/SearchPalette')
let paletteModule: Promise<PaletteModule> | null = null
function loadPalette(): Promise<PaletteModule> {
  paletteModule ??= import('./search/SearchPalette').catch((error: unknown) => {
    paletteModule = null
    throw error
  })
  return paletteModule
}

function prefetchPalette() {
  void loadPalette().catch(() => {})
}

/** Ctrl/⌘+K, even while typing in an input. Windows AltGr reports as Ctrl+Alt: not this key. */
function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k'
}

function ownsTheKey(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  // `isContentEditable` also catches editing areas turned on some other way than the attribute (designMode).
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest(NOT_A_SHORTCUT) !== null
}

/** `siteName` and `galleryLead` come from the site content (server) because this component runs in the browser: the quick search panel lists the pages with them. */
export function Header({ siteName, galleryLead }: { siteName: string; galleryLead: string | null }) {
  const t = useTranslations('Site.nav')
  // `usePathname()` is what makes this a client component. It returns '' rather than
  // null during the very first render in some environments, so default it.
  const pathname = usePathname() ?? '/'
  const searchLink = useRef<HTMLAnchorElement>(null)
  const header = useRef<HTMLElement>(null)
  const sticky = useStickyHeader(header)
  // The element that had focus before the shortcut clicked the link: where focus returns when the panel closes (for the mouse, the link itself).
  const shortcutOpener = useRef<HTMLElement | null>(null)
  const paletteOpener = useRef<HTMLElement | null>(null)
  const paletteSession = useRef(0)
  // Panel failed to load: click the link again and let next/link navigate to /search as when there is no panel.
  const linkFallback = useRef(false)
  const [palette, setPalette] = useState<{ Palette: PaletteModule['SearchPalette']; session: number } | null>(null)

  /*
    The "/" key goes to the search field, as on GitHub, YouTube, MDN.

    On a page with a search field (/search) it puts the caret into that field. On other pages it ACTIVATES the search link
    of the header itself — the same client-side navigation of next/link as a mouse click — and the field on
    /search focuses itself when there is no query (SearchForm). Not through `useRouter().push`: the header is also
    rendered on the root 404 and in tests without the app router, where `useRouter` throws
    (AccountMenu.tsx records the same reason); a click on a link is safe everywhere, and
    `aria-keyshortcuts` sits on exactly the link this key clicks.

    Ignored when "/" is a character rather than a command: typing in an input or editing area, composing
    text with an input method (Telex, VNI: `isComposing`, and keyCode 229 which Safari sends instead of it), holding Ctrl,
    ⌘ or Alt (shortcuts of the browser and screen readers; Windows AltGr reports as Ctrl+Alt),
    a repeating key, or another handler that already used this key. Shift is NOT blocked: `event.key` is already the
    typed character, and on a German or French keyboard "/" must be typed with Shift.

    preventDefault is mandatory: focus moves into the field during keydown, so without blocking it this very
    "/" character lands in the field; it also turns off Firefox's "quick find", which "/" opens by default.
  */
  /*
    this same handler is the ONLY owner of "/" and Ctrl/⌘+K (a test pins it: no second listener).
    Outside /search both click the search link, and a plain click opens the quick search panel (onSearchClick); on
    /search both put the caret into the page's field. Ctrl/⌘+K also works while typing in an input, but does not
    leak into another dialog (the enlarged image); inside the panel itself it puts the caret back into the panel's field.
  */
  useEffect(() => {
    function activate() {
      const field = document.getElementById(SEARCH_FIELD_ID)
      if (field instanceof HTMLInputElement) {
        field.focus()
        return
      }
      shortcutOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      searchLink.current?.click()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return

      // The panel is open (focus may have fallen to <body>): do not reopen it, just put the caret back into the panel's field.
      const open = document.querySelector('dialog[data-search-palette][open]')
      if (isPaletteShortcut(event)) {
        const dialog = event.target instanceof Element ? event.target.closest('dialog') : null
        if (dialog && dialog !== open) return
        event.preventDefault()
        if (open) open.querySelector('input')?.focus()
        else activate()
        return
      }

      if (event.key !== '/' || open) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (ownsTheKey(event.target)) return

      event.preventDefault()
      activate()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * A plain click on the search link (mouse, Enter, or the shortcut above): opens the panel. Ctrl/⌘/Shift/Alt or
   * the middle button is the browser's business (a new tab to /search); without JS the link is still a link.
   */
  function onSearchClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (linkFallback.current) {
      linkFallback.current = false
      return
    }
    event.preventDefault()
    const field = document.getElementById(SEARCH_FIELD_ID) ?? document.querySelector('dialog[data-search-palette][open] input')
    if (field instanceof HTMLInputElement) {
      field.focus()
      return
    }
    paletteOpener.current = shortcutOpener.current ?? event.currentTarget
    shortcutOpener.current = null
    loadPalette()
      .then(({ SearchPalette }) => {
        paletteSession.current += 1
        setPalette({ Palette: SearchPalette, session: paletteSession.current })
      })
      .catch(() => {
        linkFallback.current = true
        searchLink.current?.click()
      })
  }

  function onPaletteClosed(navigated: boolean) {
    setPalette(null)
    const opener = paletteOpener.current
    paletteOpener.current = null
    // Navigating to a result leaves focus to the new page; closing returns focus to where it was opened, without scrolling the page.
    if (!navigated) opener?.focus({ preventScroll: true })
  }

  return (
    // print:hidden: print is the post, not the site chrome.
    // sticky only once useStickyHeader has measured (before that, and without JS, it is the same plain header as before); hidden with
    // translate, no height change; z-40 above the page content, the skip link is inside so it stays on top.
    <>
      <header
        ref={header}
        className={`border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 print:hidden${
          sticky.mode === 'static' ? '' : ' sticky top-0 z-40'
        }${sticky.mode === 'live' ? ' transition-transform duration-200 motion-reduce:transition-none' : ''}${
          sticky.hidden && sticky.mode !== 'static' ? ' -translate-y-full' : ''
        }`}
      >
        {/*
          First child of the first element in <body>, therefore the first focusable node
          in the document. That position is the whole feature: a skip link that comes
          after the nav skips nothing.

          `sr-only` + `focus:not-sr-only` rather than a negative `top` and a transition:
          sr-only already handles the clip/size/overflow combination that keeps a node
          reachable by the tab order while invisible, and reimplementing it by hand is
          how skip links end up either permanently visible or permanently unreachable.
        */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-brand focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand focus:outline-2 focus:outline-offset-2 focus:outline-brand dark:focus:bg-neutral-900"
        >
          {t('skipToContent')}
        </a>

        <Container width="reader" className={BAR_FRAME}>
          {/*
            One wrapping flex row, not a hamburger. Below md it is two rows, about 100px with the hairline: row 1 is the site name
            and ONE group of four 44px controls (search, language, theme, account), row 2 is the nav as four tabs of 44px
            with the current section underlined. Both rows stay inside the thumb's reach and nothing is orphaned on a line of
            its own (the language pill used to be a third row). From md the nav joins the first row and the controls shrink to the
            36px slot, as before. A disclosure menu would add state, an Escape handler, a focus trap and an outside-click
            listener to save roughly 40px of vertical space on phones.

            The group fits at 320px: the name plus 4 x 44px and 3 x 4px gaps leave at least 88px for the name of the site.
            The language slot is the flag alone below sm (no chevron), like the three slots beside it.

            the notification bell sits between the theme button and the account button, only when signed in
            and only from sm: below sm the bell yields to the dot on the avatar. From md to lg the name beside the avatar is
            hidden so the button group still fits one row.

            `gap-y-*` is why there is no `justify-between`: with wrapping, space-between
            on the first row would push the name and the controls apart and then strand
            the nav underneath with a different left edge.
          */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 md:gap-x-6 md:gap-y-2 md:py-4">
            <Link
              href="/"
              // The site name is the way home since the home item left the nav, so it also takes
              // aria-current at '/': screen reader users still hear where they are.
              aria-current={pathname === '/' ? 'page' : undefined}
              // Below md the name takes the room the controls leave, whatever their width, and is cut with an ellipsis when it is longer:
              // `flex-1` with `min-w-0` gives it a zero basis, so the line break never counts the name and it shares the first row with
              // the controls (188px below sm; wider from sm, with the sign-in text, the language chevron, the bell and the account name),
              // and `max-w-max` keeps the link no wider than its text, so the free space still goes to `mr-auto` and the tap target does
              // not stretch. A site name is whatever the owner typed (the packaged default is 119px at 16px, the room is 88px at 320px).
              className={`mr-auto text-base font-semibold tracking-tight text-neutral-900 max-md:inline-flex max-md:max-w-max max-md:min-h-11 max-md:min-w-0 max-md:flex-1 max-md:items-center dark:text-neutral-100 ${LINK_BASE}`}
            >
              <span className="min-w-0 max-md:truncate">{siteName}</span>
            </Link>

            <nav
              aria-label={t('mainLabel')}
              // order-last + w-full = second row below md; md: puts it back inline.
              className="order-last w-full md:order-none md:w-auto"
            >
              {/*
                Below md the four items are tabs that share the row (`justify-between`, each at least 44px tall); from md they are the
                inline list of before: 16px between them, narrowing to 12px below 360px — `max-[359px]:` is the only approved
                breakpoint exception, only here. `flex-wrap` stays as a safety net: with a font wider than Inter, the last item
                drops to a new line instead of pushing the page into horizontal overflow. QA measured with Playwright using real Inter.
              */}
              <ul className="flex flex-wrap items-center justify-between gap-x-2 text-[0.9375rem] md:justify-start md:gap-x-4 md:gap-y-1 md:text-sm max-[359px]:gap-x-1 max-[359px]:text-sm">
                {navItems.map((item) => {
                  const current = isCurrentSection(pathname, item)
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        // The attribute, not a class, is the accessibility contract.
                        // `undefined` removes it; aria-current="false" is a *string* and
                        // would read as a present, truthy attribute to some AT.
                        aria-current={current ? 'page' : undefined}
                        // Below md the link is a 44px tab with its own underline (the current one in brand color), so the tap-area ::after is
                        // switched off there; from md TAP_TARGET enlarges the 17px text as before.
                        className={`${LINK_BASE} ${TAP_TARGET} flex min-h-11 min-w-11 items-center justify-center border-b-2 px-1 max-md:after:hidden max-[359px]:px-0.5 md:inline md:min-h-0 md:border-b-0 md:px-0 ${
                          current
                            ? 'border-brand font-medium text-brand'
                            : 'border-transparent text-neutral-600 dark:text-neutral-400'
                        }`}
                      >
                        {t(item.labelKey)}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>

            <div className="flex shrink-0 items-center gap-1 md:gap-2">
              <Link
                ref={searchLink}
                href="/search"
                aria-current={pathname === '/search' ? 'page' : undefined}
                // The "/" and Ctrl/⌘+K keys click this very link (see the useEffect above); declared so screen
                // readers announce the shortcut next to the search link name.
                aria-keyshortcuts="/ Control+K Meta+K"
                onClick={onSearchClick}
                onMouseEnter={prefetchPalette}
                onFocus={prefetchPalette}
                onTouchStart={prefetchPalette}
                // ICON_SLOT: 44px on a phone, 36px from md like the controls beside it; ICON_TAP_TARGET widens the hit area.
                className={`inline-flex md:ml-4 ${ICON_SLOT} items-center justify-center rounded-md border border-neutral-200 text-neutral-600 hover:border-brand hover:text-brand dark:border-neutral-800 dark:text-neutral-400 ${LINK_BASE} ${ICON_TAP_TARGET}`}
              >
                {/* Icon-only control: the SVG is aria-hidden and the name comes from the
                    visually hidden text, so the link is not announced as "link" alone. */}
                <svg
                  viewBox="0 0 16 16"
                  width={16}
                  height={16}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="7" cy="7" r="4.4" />
                  <path d="m10.3 10.3 3.2 3.2" />
                </svg>
                <span className="sr-only">{t('search')}</span>
              </Link>

              {/* In the group at every width: between md and lg the name, the nav and the controls still fit one row (measured at 768px). From md it is drawn first (`md:order-first`) and the search link takes the 16px margin that the old 24px gap between the two had, so the desktop row is nav, language, search, theme, account as before; below md the order is the phone order. */}
              <LanguageSwitcher className="md:order-first" />

              <ThemeToggle />

              {/* Notifications: render nothing for guests and while the session is loading — not even
                  a wrapper, so this group is unchanged for guests. */}
              <NotificationBell />

              {/* GitHub sign-in, or the avatar and account panel. Client island:
                  the header is in the cached HTML of every page, so it asks /api/session after
                  hydration instead of reading the cookie here. */}
              <AccountMenu />
            </div>
          </div>
        </Container>
      </header>
      {/* Outside <header>: the header pins when there is keyboard focus or aria-expanded inside, and it carries a transform. */}
      {palette ? (
        <palette.Palette key={palette.session} onClosed={onPaletteClosed} siteName={siteName} galleryLead={galleryLead} />
      ) : null}
    </>
  )
}
