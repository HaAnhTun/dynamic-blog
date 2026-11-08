import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import type { ComponentProps, ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrandIcon } from '@/components/BrandIcon'
import { MailIcon, RssIcon, ShuffleIcon } from '@/components/icons'
import type { Session } from '@/lib/session-client'
import { Container } from './Container'
import { Footer } from './Footer'
import { Header, isCurrentSection, navItems, type NavItem } from './Header'
import { SearchForm } from './SearchForm'
import { defaultSiteContent } from '@/content/defaults'
import type { Contact } from '@/lib/site-content-types'
import { LanguageSwitcher } from './LanguageSwitcher'
import { LANGUAGE_NAMES } from './language-names'
import { IntlWrapper } from '@/test/intl'
import { msg, renderWithIntl } from '@/test/render-intl'

/** The packaged defaults of the test locale: the neutral site name and positioning the header and footer show. */
const { site } = defaultSiteContent('vi')
/** A filled-in contact block (the defaults have none), with values that belong to nobody. */
const FILLED: Contact = {
  ...defaultSiteContent('vi').contact,
  email: 'reader@example.test',
  github: 'https://github.com/example-user',
}

/** Footer is an async server component: await it, then render the element it returns. */
async function renderFooter(data: Contact = FILLED) {
  return renderWithIntl(await Footer({ data }), { locale: 'vi' })
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const THEME_NAME = new RegExp(`^${escapeRe(msg('Site.shell.themeToggle.title', { current: 'system' }).split(':')[0] + ': ')}`)
const BELL_NAME = new RegExp(`^${escapeRe(msg('Site.notifications.bell.label'))}`)
const SIGN_IN_NAME = new RegExp(escapeRe(msg('Site.account.signIn')))
const MENU_NAME = new RegExp(`menu|${escapeRe(msg('Site.nav.mainLabel'))}`, 'i')

// usePathname is the only reason Header is a client component, and it is the input to
// every assertion below. Mocked rather than wrapped in a router provider: there is no
// public way to set the pathname of the App Router's context from a test.
const pathname = vi.hoisted(() => ({ value: '/' }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => pathname.value,
  useRouter: () => ({ replace: vi.fn() }),
}))

// The account button reads the session from the client-side store. Here the store is replaced by a fixed value:
// the header must not depend on when /api/session answers, and the button's own behavior
// has its own test (AccountMenu.test.tsx, with the real store). The default is a guest.
const session = vi.hoisted(() => ({ value: { status: 'anonymous', loggedOut: false } as Session }))
vi.mock('@/lib/session-client', () => ({
  useSession: () => session.value,
  // Second guard of the unread-count store (lib/notifications-client.ts): it only starts polling when the session is
  // `authenticated`. That store is real in this file: the guest test below measures that it sends nothing.
  getSessionSnapshot: () => session.value,
  logout: vi.fn(),
  setAnonymous: vi.fn(),
}))

/** Fake `fetch` for the whole file: only the unread-count store calls it. Each test reviews the calls via `notificationCalls()`. */
let fetchMock: ReturnType<typeof vi.fn>

function notificationCalls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/notifications'))
}

const READER: Session = {
  status: 'authenticated',
  user: {
    displayName: 'Alice Reader',
    githubLogin: 'doc-gia',
    avatarUrl: null,
    role: 'USER',
    joinedAt: '2026-10-01T08:00:00Z',
    canAccessAdmin: false,
  },
}

/**
 * the real `next/link`, only adding a `data-next-link` marker to the <a> it renders (Link spreads every unknown
 * prop onto <a>). Link's behavior stays unchanged for every test in the file; the marker lets the footer tests
 * tell a link that goes through the client-side router from a plain <a> tag. Clicking cannot tell them apart:
 * without an AppRouterContext, Link ignores the click (`if (!router) return` in
 * next/dist/client/app-dir/link.js), so in jsdom the two kinds behave the same.
 */
vi.mock('next/link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/link')>()
  const { createElement } = await import('react')
  const Link = actual.default
  return {
    ...actual,
    default: (props: ComponentProps<typeof Link>) =>
      createElement(Link, { ...props, 'data-next-link': '' } as ComponentProps<typeof Link>),
  }
})

function renderAt(path: string) {
  pathname.value = path
  return render(<Header siteName={site.name} galleryLead={null} />)
}

/** The accessible-name computation is what matters, so find links by their name. */
function navLink(label: string): HTMLElement {
  return screen.getByRole('link', { name: label })
}

/** The header's four items, in order. The old home item is gone: the site name is the way back to `/`. */
const SECTIONS = [
  msg('Site.footer.links.writing'),
  msg('Site.footer.links.startHere'),
  'Case study',
  msg('Site.footer.links.about'),
] as const

/**
 * Tab order, in document order, restricted to what can actually take focus. Not
 * `screen.getAllByRole('link')`: the question is "what does the first Tab press
 * reach", which includes buttons and excludes tabindex="-1".
 */
function focusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/**
 * The drawn part of an icon (the paths inside `<svg>`), to assert "exactly this glyph" without
 * depending on size, class or stroke width. Built from the icon component itself: editing a path in
 * components/icons.tsx does not turn the test red, putting in the wrong icon does.
 */
function glyphOf(icon: ReactElement): string {
  const { container, unmount } = render(icon)
  const markup = container.querySelector('svg')!.innerHTML
  unmount()
  return markup
}

/** Exactly one icon in `link`, hidden from screen readers, and it is the `icon` glyph. */
function expectIcon(link: HTMLElement, icon: ReactElement) {
  const svgs = link.querySelectorAll('svg')
  expect(svgs, link.textContent ?? '').toHaveLength(1)
  expect(svgs[0]).toHaveAttribute('aria-hidden', 'true')
  expect(svgs[0]).toHaveAttribute('focusable', 'false')
  expect(svgs[0]!.innerHTML, link.textContent ?? '').toBe(glyphOf(icon))
}

beforeEach(() => {
  pathname.value = '/'
  session.value = { status: 'anonymous', loggedOut: false }
  document.documentElement.removeAttribute('data-theme')
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { count: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Header navigation', () => {
  it('renders exactly the four sections, and no fifth', () => {
    renderAt('/')

    const nav = screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') })
    const links = Array.from(nav.querySelectorAll('a'))

    expect(links.map((a) => a.textContent)).toEqual([...SECTIONS])
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/writing', '/start-here', '/case-studies', '/about'])
    // Four is the cap the brief set, not a coincidental count of the current array. The fourth slot
    // used to be the projects item and was left empty along with the portfolio item it pointed to; 'Case study' fills
    // that slot with a different destination.
    expect(navItems).toHaveLength(4)
    // /projects must still be dead. This is the only place that asserts the new item is NOT
    // the old item coming back under another name.
    expect(links.map((a) => a.getAttribute('href'))).not.toContain('/projects')
  })

  it('gives the featured-posts item the slot the home item held, and leaves the site name as the way home', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') })

    // Present: the featured-posts item, the second item in the sample site's menu, inside the nav.
    expect(within(nav).getByRole('link', { name: msg('Site.footer.links.startHere') })).toHaveAttribute('href', '/start-here')
    // Absent: the home item, and no link in the nav points to '/'. Dropping it is the only way to
    // get the new item into the header while the four items still fit one row at 320px.
    expect(within(nav).queryByRole('link', { name: 'Home' })).toBeNull()
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))).not.toContain('/')

    // The way back home remains, and only one: the site name.
    const home = Array.from(document.querySelectorAll('a')).filter((a) => a.getAttribute('href') === '/')
    expect(home).toHaveLength(1)
    expect(home[0]).toHaveAccessibleName(site.name)
  })

  it('puts the author name and a search link outside the four, and names the icon link', () => {
    renderAt('/')

    expect(navLink(site.name)).toHaveAttribute('href', '/')

    // Icon-only control. If the <span className="sr-only"> were dropped, the <svg> is
    // aria-hidden and this link would have NO accessible name at all — getByRole
    // would not find it, which is the failure this pins.
    expect(navLink(msg('Site.search.heading'))).toHaveAttribute('href', '/search')
  })

  it('keeps icons off the four labels; the only glyph is the icon-only search link', () => {
    // an icon never sits on a nav label. The "present" pair: the search slot is still an icon.
    renderAt('/')

    expect(screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') }).querySelectorAll('svg')).toHaveLength(0)
    expect(navLink(msg('Site.search.heading')).querySelectorAll('svg')).toHaveLength(1)
  })

  it('marks the current section with aria-current and marks nothing else', () => {
    renderAt('/writing')

    expect(navLink(msg('Site.footer.links.writing'))).toHaveAttribute('aria-current', 'page')

    // The actual bug this guards. The site name links to '/', and every path on the site
    // starts with '/', so a `pathname.startsWith(href)` implementation would make it a
    // second current item on every single page.
    expect(navLink(site.name)).not.toHaveAttribute('aria-current')
    expect(navLink(msg('Site.footer.links.about'))).not.toHaveAttribute('aria-current')

    // Stated as a count too: exactly one current element in the whole header.
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('marks the site name, and no section, on the homepage itself', () => {
    // Previously the home item carried aria-current at '/'. That item is gone, so the site name takes over that
    // role: screen reader users still know they are on the home page.
    renderAt('/')

    expect(navLink(site.name)).toHaveAttribute('aria-current', 'page')
    for (const label of SECTIONS) {
      expect(navLink(label), label).not.toHaveAttribute('aria-current')
    }
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it.each([
    ['/posts/sample-post-03', msg('Site.footer.links.writing')],
    ['/writing', msg('Site.footer.links.writing')],
    ['/series', msg('Site.footer.links.writing')],
    ['/series/series-a', msg('Site.footer.links.writing')],
    ['/topics', msg('Site.footer.links.writing')],
    ['/archive', msg('Site.footer.links.writing')],
    ['/tags/aws', msg('Site.footer.links.writing')],
    ['/categories/kien-truc', msg('Site.footer.links.writing')],
    ['/start-here', msg('Site.footer.links.startHere')],
    ['/case-studies/blog-nay', 'Case study'],
    ['/about', msg('Site.footer.links.about')],
    ['/gallery', msg('Site.footer.links.about')],
  ])('a reader at %s is in the %s section', (path, label) => {
    renderAt(path)

    expect(navLink(label), `${path} should highlight ${label}`).toHaveAttribute('aria-current', 'page')
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('does not mark a section whose prefix merely starts the same way', () => {
    // '/writing-tips'.startsWith('/writing') is true. The boundary check is the
    // difference between a prefix match and a string match.
    renderAt('/writing-tips')

    expect(navLink(msg('Site.footer.links.writing'))).not.toHaveAttribute('aria-current')
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(0)
  })

  it('marks no section on a page outside the four, rather than guessing', () => {
    renderAt('/search')

    for (const label of SECTIONS) {
      expect(navLink(label), label).not.toHaveAttribute('aria-current')
    }
    expect(navLink(site.name)).not.toHaveAttribute('aria-current')
    // The search link itself is current there, and it is not one of the four.
    expect(navLink(msg('Site.search.heading'))).toHaveAttribute('aria-current', 'page')
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  })

  it('keeps the name and the four 44px controls on one row at 320px, and the nav inline only from md', () => {
    // Below md the header is two rows: the name and ONE group of four controls (search, language, theme, account: 4 x 44px and
    // 3 x 4px between them = 188px, which leaves 100px of the 288px row of a 320px phone for the name), then the nav as its own
    // row of tabs. The nav only joins the first row from md (768px), where the controls are the 36px slots again and
    // the language switcher still fits the row (the name 145.7px, the nav 286.4px, five slots and the pill: 690 of 720px).
    // The minimum gap is 12px below md (the name's mr-auto still pushes the button group to the right).
    renderAt('/')
    const row = screen.getByRole('banner').querySelector('a[href="/"]')!.parentElement!
    const nav = screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') })

    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-wrap', 'gap-x-3', 'md:gap-x-6']))
    expect(row.className).not.toMatch(/(^|\s)gap-x-6(\s|$)/)
    expect(nav.className.split(/\s+/)).toEqual(expect.arrayContaining(['order-last', 'w-full', 'md:order-none', 'md:w-auto']))
    expect(nav.className).not.toMatch(/\bsm:order-none\b/)
  })

  it('cuts a long site name with an ellipsis below md so the control group keeps the first row, whatever the group measures', () => {
    // The name takes whatever room the controls leave, with no constant for their width (it is 188px below sm and wider from sm, with the
    // sign-in text, the language chevron, the bell and the account name): a zero flex basis (`flex-1`, `min-w-0`) so the line break never
    // counts the name, and `max-w-max` so the link is no wider than its text and the free space still goes to `mr-auto`. The e2e case
    // "a long site name keeps the controls on the first row" measures it from 320px to 767px.
    // The text sits in its own span: an ellipsis needs a block box, and the link is an inline-flex box below md.
    renderAt('/')
    const link = screen.getByRole('banner').querySelector('a[href="/"]')!
    const text = link.firstElementChild!

    expect(link).toHaveClass('max-md:inline-flex', 'max-md:min-w-0', 'max-md:flex-1', 'max-md:max-w-max', 'mr-auto')
    expect(link.className).not.toMatch(/calc\(100%-/)
    expect(text).toHaveClass('min-w-0', 'max-md:truncate')
    expect(text).toHaveTextContent(site.name)
    // From md nothing is cut: the name keeps its natural width in the one-row header.
    expect(text.className).not.toMatch(/(^|\s)truncate(\s|$)/)
    expect(link.className).not.toMatch(/(^|\s)(max-w-|min-w-0|flex-1)/)
  })

  it('spreads the four tabs over the row below md, 16px apart from md, and still wraps as a safety net', () => {
    // Below md the four items share the row (`justify-between`, 8px minimum between them, 4px below 360px: the only approved breakpoint
    // exception), each a 44px tab; from md they are the inline list of before, 16px apart. flex-wrap stays so that a wider font
    // wraps the last item onto a new line instead of overflowing horizontally.
    renderAt('/')
    const list = screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') }).querySelector('ul')!
    const classes = list.className.split(/\s+/)

    expect(classes).toEqual(
      expect.arrayContaining(['flex-wrap', 'justify-between', 'md:justify-start', 'max-[359px]:gap-x-1', 'md:gap-x-4']),
    )
    expect(classes.filter((c) => /^gap-x-/.test(c))).toEqual(['gap-x-2'])
  })

  it('each link is a 44px tab below md with the current one underlined, and the plain text link from md', () => {
    renderAt('/writing')
    const links = within(screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') })).getAllByRole('link')

    for (const link of links) {
      expect(link, link.textContent ?? '').toHaveClass(
        'flex',
        'min-h-11',
        'min-w-11',
        'border-b-2',
        'md:inline',
        'md:min-h-0',
        'md:border-b-0',
      )
      expect(link).toHaveClass('max-md:after:hidden')
    }
    const current = links.find((link) => link.getAttribute('aria-current') === 'page')!
    expect(current).toHaveClass('border-brand', 'text-brand')
    for (const link of links.filter((item) => item !== current)) expect(link).toHaveClass('border-transparent')
  })
})

/**
 * the account button in the right-hand group, after the theme button. The header is a client component in the
 * cached HTML of every page, so there is no user data at server render time: only the client-side
 * session store knows who is reading.
 */
describe('Header account control', () => {
  function cluster(): HTMLElement {
    return screen.getByRole('link', { name: msg('Site.search.heading') }).parentElement!
  }

  it('sits last in the right-hand group, right after the theme button, in a group that does not shrink', () => {
    renderAt('/writing')

    const controls = Array.from(cluster().children).filter((el) => !el.classList.contains('sr-only'))
    // The language switcher sits in the same group (between the search link and the theme button), so a phone has no third row.
    expect(controls.map((el) => el.getAttribute('aria-label') ?? el.textContent)).toEqual([
      msg('Site.search.heading'),
      msg('Language.navLabel'),
      expect.stringMatching(THEME_NAME),
      msg('Site.account.signInWithGithub'),
    ])
    expect(cluster()).toHaveClass('shrink-0')
  })

  it('keeps the desktop order: language first from md, the search link takes the 16px the old gap had; the rows are 44px only on a phone', () => {
    renderAt('/writing')

    const language = screen.getByRole('navigation', { name: msg('Language.navLabel') })
    const search = screen.getByRole('link', { name: msg('Site.search.heading') })
    expect(language).toHaveClass('md:order-first')
    expect(search).toHaveClass('md:ml-4')
    const row = within(language).getAllByRole('listitem')[0]!.firstElementChild!
    expect(row).toHaveClass('min-h-11', 'md:min-h-0')
  })

  it('guest: the GitHub sign-in link returns to the exact page being read', () => {
    renderAt('/series/series-a')

    expect(within(cluster()).getByRole('link', { name: msg('Site.account.signInWithGithub') })).toHaveAttribute(
      'href',
      '/api/auth/github/start?returnTo=%2Fseries%2Fseries-a',
    )
  })

  it('while the session is loading: an inert placeholder, adding nothing to the Tab order', () => {
    session.value = { status: 'loading' }
    renderAt('/')

    expect(within(cluster()).queryByRole('link', { name: SIGN_IN_NAME })).toBeNull()
    const placeholder = cluster().querySelector('[data-account-placeholder]')!
    expect(placeholder).toHaveAttribute('aria-hidden', 'true')
    expect(focusables()).not.toContain(placeholder)
  })

  it('signed in: a "Account: <name>" button, and the header still has no "menu" button', async () => {
    session.value = READER
    renderAt('/')
    await act(async () => {})

    expect(
      within(cluster()).getByRole('button', { name: msg('Site.account.accountLabel', { name: 'Alice Reader' }) }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: MENU_NAME })).toBeNull()
  })
})

/**
 * the notification bell. Only when signed in, and it leaves nothing behind (not even a wrapper or a
 * request) for guests and while the session is loading: the header is in the cached HTML of every page, and almost
 * every reader is a guest.
 */
describe('Header notification bell', () => {
  function cluster(): HTMLElement {
    return screen.getByRole('link', { name: msg('Site.search.heading') }).parentElement!
  }

  it.each([
    ['guest', { status: 'anonymous', loggedOut: false } as Session],
    ['session loading', { status: 'loading' } as Session],
  ])('%s: no bell, no extra button, not a single /api/notifications* request', async (_label, value) => {
    session.value = value
    renderAt('/posts/bai-viet')
    await act(async () => {})

    expect(screen.queryByRole('button', { name: BELL_NAME })).toBeNull()
    expect(cluster().querySelector('[data-unread-badge], [data-unread-dot]')).toBeNull()
    // Exactly four slots as before the bell (search slot, language switcher, theme button, account slot), plus its sr-only live region.
    expect(Array.from(cluster().children).filter((el) => !el.classList.contains('sr-only'))).toHaveLength(4)
    expect(notificationCalls()).toEqual([])
  })

  it('signed in: the bell sits between the theme button and the account button, its root is `hidden sm:block`', async () => {
    session.value = READER
    renderAt('/')
    await act(async () => {})

    const search = screen.getByRole('link', { name: msg('Site.search.heading') })
    const theme = within(cluster()).getByRole('button', { name: THEME_NAME })
    const bell = within(cluster()).getByRole('button', { name: BELL_NAME })
    const account = within(cluster()).getByRole('button', { name: msg('Site.account.accountLabel', { name: 'Alice Reader' }) })
    const order = [search, theme, bell, account]
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // The bell's root is a direct child of the group, and it is itself hidden below sm: `display:none` takes no
    // `gap-2` slot, so at 320px the group still has exactly three slots.
    const root = bell.parentElement!
    expect(root.parentElement).toBe(cluster())
    expect(root).toHaveClass('hidden', 'sm:block')
  })

  it('keeps the first row at 320, 640, 768 and 1024px: the bell only from sm, the name beside the avatar hidden from md to lg', async () => {
    // Measured with real Inter (same method as the 320px test above): site name 145.7px, nav 286.4px. Account button without
    // a name: border 2 + padding 4 + avatar 28 + gap 6 + arrow 14 + padding 6 = 60px; with a name add 6 + the name (at most 72px up to
    // lg, 160px from lg). Slot 36px, group gap 8px.
    //   320 (below sm):  145.7 + 12 + 36 + 8 + 36 + 8 + 36 (avatar only, no bell)         = 281.7 / 288
    //   640 (sm, nav on row two): 145.7 + 12 + (36 + 8 + 36 + 8 + 36 + 8 + 138)        = 427.7 / 592
    //   768 (md, nav on the same row, name hidden): 145.7 + 24 + 286.4 + 24 + (36+8+36+8+36+8+60) = 672.1 / 720
    //   1024 (lg, name up to 10rem): 145.7 + 24 + 286.4 + 24 + (36+8+36+8+36+8+226)       = 838.1 / 976
    // A fourth 36px slot below sm makes the 320px row wrap (281.7 + 44 > 288); keeping the name at 768px leaves the group short of room.
    session.value = READER
    renderAt('/')
    await act(async () => {})

    const bell = within(cluster()).getByRole('button', { name: BELL_NAME })
    expect(bell).toHaveClass('h-11', 'w-11', 'md:h-9', 'md:w-9')
    expect(bell.parentElement).toHaveClass('hidden', 'sm:block')

    const account = within(cluster()).getByRole('button', { name: msg('Site.account.accountLabel', { name: 'Alice Reader' }) })
    expect(account).toHaveClass('w-11', 'sm:w-auto')
    const name = account.querySelector('bdi')!
    expect(name.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['hidden', 'sm:block', 'md:hidden', 'lg:block', 'max-w-[4.5rem]', 'lg:max-w-[10rem]']),
    )
    // The arrow stays from sm: a nameless button from md to lg still shows that it can be opened.
    expect(account.querySelector('svg')).toHaveClass('hidden', 'sm:block')
  })
})

/**
 * the "/" key takes the reader to the search field, as on GitHub, YouTube, MDN.
 *
 * The header does not call `useRouter` (AccountMenu.tsx records why: the header also renders on the root 404 and in
 * tests without the app router, where `useRouter` throws). So "go to /search" is ACTIVATING the header's own
 * search link: the same client-side navigation of next/link as a mouse click. There is
 * no router here (next/link ignores the click), so the test listens for the click on the link and blocks jsdom's
 * default navigation.
 */
describe('Header — the "/" shortcut', () => {
  /** Counts clicks on the header's search link; blocks the default navigation (jsdom cannot navigate). */
  function watchSearchLink(): { clicks: () => number } {
    let count = 0
    navLink(msg('Site.search.heading')).addEventListener('click', (event) => {
      count += 1
      event.preventDefault()
    })
    return { clicks: () => count }
  }

  /** `fireEvent` returns false when a handler called preventDefault: "/" is used by the shortcut, typed nowhere. */
  function pressSlash(target: Element = document.body, init: KeyboardEventInit = {}): boolean {
    return fireEvent.keyDown(target, { key: '/', code: 'Slash', ...init })
  }

  it('the search link declares the shortcut for assistive technology: "/" and Ctrl/⌘+K', () => {
    renderAt('/writing')

    expect(navLink(msg('Site.search.heading'))).toHaveAttribute('aria-keyshortcuts', '/ Control+K Meta+K')
  })

  it('outside /search: "/" activates the search link (to /search), and types "/" nowhere', () => {
    renderAt('/writing')
    const link = watchSearchLink()

    expect(pressSlash()).toBe(false)
    expect(link.clicks()).toBe(1)
    expect(navLink(msg('Site.search.heading'))).toHaveAttribute('href', '/search')
  })

  it('on /search: "/" only moves the caret into the search field, without navigating again', () => {
    pathname.value = '/search'
    // The real SearchForm, with a query (so it does not autofocus): the field's id must match the shortcut's target.
    render(
      <>
        <Header siteName={site.name} galleryLead={null} />
        <SearchForm q="queue" />
      </>,
    )
    const field = screen.getByLabelText(msg('Site.search.form.keywordLabel'))
    const link = watchSearchLink()
    expect(field).not.toHaveFocus()

    // preventDefault is mandatory here: focus moves into the field during keydown, so without blocking it
    // this very "/" character lands in the field, making "queue/".
    expect(pressSlash()).toBe(false)
    expect(field).toHaveFocus()
    expect(field).toHaveValue('queue')
    expect(link.clicks()).toBe(0)
  })

  it('typing in an input, a textarea or a select: "/" is a character, not a shortcut', () => {
    renderAt('/writing')
    const link = watchSearchLink()
    const host = document.createElement('div')
    host.innerHTML = `
      <input aria-label="single line field" />
      <textarea aria-label="comment"></textarea>
      <select aria-label="choice field"><option>a</option></select>
      <div contenteditable="true" aria-label="editing area"><p>paragraph</p></div>
    `
    document.body.append(host)

    try {
      for (const target of [
        host.querySelector('input')!,
        host.querySelector('textarea')!,
        host.querySelector('select')!,
        host.querySelector('[contenteditable]')!,
        // A child of the editing area: keydown comes from the child element holding the caret.
        host.querySelector('[contenteditable] p')!,
      ]) {
        expect(pressSlash(target), target.outerHTML).toBe(true)
      }
      expect(link.clicks()).toBe(0)
    } finally {
      host.remove()
    }
  })

  it('holding Ctrl, ⌘ or Alt, composing text (IME), holding a repeating key, or an already-used event: ignored', () => {
    renderAt('/writing')
    const link = watchSearchLink()

    // Ctrl+/ or ⌘+/ is a shortcut of the browser and screen readers; Alt (and AltGr, which Windows
    // reports as Ctrl+Alt) is how characters are typed on many keyboards.
    expect(pressSlash(document.body, { ctrlKey: true })).toBe(true)
    expect(pressSlash(document.body, { metaKey: true })).toBe(true)
    expect(pressSlash(document.body, { altKey: true })).toBe(true)
    // A Vietnamese input method (Telex, VNI) is composing text: the key belongs to the input method.
    expect(pressSlash(document.body, { isComposing: true })).toBe(true)
    // Held key: one navigation, not twenty.
    expect(pressSlash(document.body, { repeat: true })).toBe(true)
    expect(link.clicks()).toBe(0)

    // Another handler already used this key.
    const claim = (event: KeyboardEvent) => event.preventDefault()
    document.body.addEventListener('keydown', claim)
    try {
      pressSlash()
      expect(link.clicks()).toBe(0)
    } finally {
      document.body.removeEventListener('keydown', claim)
    }
  })

  it('Shift does not block: on many keyboards (German, French) "/" must be typed with Shift', () => {
    renderAt('/writing')
    const link = watchSearchLink()

    // `event.key` is already the typed character, so Shift+7 on a German keyboard reports key "/". Blocking on Shift is
    // locking the shortcut out for exactly those people.
    expect(pressSlash(document.body, { shiftKey: true })).toBe(false)
    expect(link.clicks()).toBe(1)
  })

  it('inside a dialog (the enlarged image at /gallery): ignored, a dialog is its own context', () => {
    renderAt('/gallery')
    const link = watchSearchLink()
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    dialog.innerHTML = '<button type="button">Close</button>'
    document.body.append(dialog)

    try {
      expect(pressSlash(dialog.querySelector('button')!)).toBe(true)
      expect(link.clicks()).toBe(0)
    } finally {
      dialog.remove()
    }
  })

  it('other keys do nothing; unmounting the header removes the listener', () => {
    const { unmount } = renderAt('/writing')
    const link = watchSearchLink()

    expect(fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(document.body, { key: 'k' })).toBe(true)
    expect(link.clicks()).toBe(0)

    unmount()
    // A listener on `document` outlives the component if it is not removed: the shortcut of a header that is gone.
    expect(pressSlash()).toBe(true)
  })
})

describe('Header — quick search panel', () => {
  const original = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close }
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      if (!this.open) return
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  })
  afterEach(() => {
    HTMLDialogElement.prototype.showModal = original.showModal
    HTMLDialogElement.prototype.close = original.close
  })

  const palette = () => screen.findByRole('dialog', { name: msg('Site.search.heading') })

  it('a plain click on the link opens the panel, focus goes to the field; Esc closes it and returns focus to the link', async () => {
    renderAt('/writing')
    const link = navLink(msg('Site.search.heading'))
    link.focus()

    expect(fireEvent.click(link)).toBe(false)
    const dialog = await palette()
    // The panel mounts after `import()` and focuses the field in its effect: wait, do not check immediately.
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: msg('Site.palette.inputLabel') })).toHaveFocus())

    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(link).toHaveFocus()
  })

  it("Ctrl/⌘/Shift/Alt + click and the middle button are the browser's business: the panel does not open, the default is not blocked", async () => {
    renderAt('/writing')
    const link = navLink(msg('Site.search.heading'))
    const passThrough = (event: MouseEvent) => event.preventDefault()

    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      link.addEventListener('click', passThrough, { once: true })
      // The header's own handler must not be the one that blocks: check with a flag before the test listener blocks.
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
      link.dispatchEvent(event)
    }
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('"/" and Ctrl/⌘+K open the panel; Ctrl/⌘+K also works inside an input; Ctrl+Shift+K and AltGr (Ctrl+Alt) do not', async () => {
    renderAt('/writing')
    expect(fireEvent.keyDown(document.body, { key: '/' })).toBe(false)
    fireEvent.keyDown(within(await palette()).getByRole('combobox'), { key: 'Escape' })

    const input = document.createElement('input')
    document.body.append(input)
    try {
      expect(fireEvent.keyDown(input, { key: 'k', ctrlKey: true, shiftKey: true })).toBe(true)
      expect(fireEvent.keyDown(input, { key: 'k', ctrlKey: true, altKey: true })).toBe(true)
      await act(async () => {})
      expect(screen.queryByRole('dialog')).toBeNull()

      expect(fireEvent.keyDown(input, { key: 'K', metaKey: true })).toBe(false)
      const dialog = await palette()
      await waitFor(() => expect(within(dialog).getByRole('combobox')).toHaveFocus())
      // Once more inside the panel itself: only moves the caret back to the panel's field, does not open another.
      const tabbable = within(dialog).getByRole('button', { name: msg('Site.palette.closeLabel') })
      tabbable.focus()
      expect(fireEvent.keyDown(tabbable, { key: 'k', ctrlKey: true })).toBe(false)
      expect(within(dialog).getByRole('combobox')).toHaveFocus()
      expect(screen.getAllByRole('dialog')).toHaveLength(1)

      // Focus falls to <body> while the panel is open: "/" does nothing, Ctrl+K does not remount the panel (losing the query).
      fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'queue' } })
      ;(document.activeElement as HTMLElement).blur()
      expect(fireEvent.keyDown(document.body, { key: '/' })).toBe(true)
      expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false)
      await act(async () => {})
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      expect(within(screen.getByRole('dialog')).getByRole('combobox')).toHaveValue('queue')
      expect(within(screen.getByRole('dialog')).getByRole('combobox')).toHaveFocus()
    } finally {
      input.remove()
    }
  })

  it('on /search: Ctrl/⌘+K moves the caret into the page\'s field like "/"; inside another dialog it is ignored', async () => {
    pathname.value = '/search'
    render(
      <>
        <Header siteName={site.name} galleryLead={null} />
        <SearchForm q="queue" />
      </>,
    )
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false)
    expect(screen.getByLabelText(msg('Site.search.form.keywordLabel'))).toHaveFocus()

    const other = document.createElement('dialog')
    other.setAttribute('open', '')
    other.innerHTML = '<button type="button">Next photo</button>'
    document.body.append(other)
    try {
      expect(fireEvent.keyDown(other.querySelector('button')!, { key: 'k', ctrlKey: true })).toBe(true)
    } finally {
      other.remove()
    }
  })

  it('a single keyboard owner: the header attaches exactly one keydown on document, an open panel attaches none more on document or window', async () => {
    const onDocument = vi.spyOn(document, 'addEventListener')
    const onWindow = vi.spyOn(window, 'addEventListener')
    renderAt('/writing')
    fireEvent.click(navLink(msg('Site.search.heading')))
    await palette()

    const keydown = (spy: typeof onDocument | typeof onWindow) => spy.mock.calls.filter(([type]) => type === 'keydown').length
    expect(keydown(onDocument)).toBe(1)
    expect(keydown(onWindow)).toBe(0)
  })
})

describe('Header language switcher', () => {
  const switcher = () => screen.getByRole('navigation', { name: msg('Language.navLabel') })

  it('on /writing (default locale): the current language is marked, the other one links to /en/writing', () => {
    pathname.value = '/writing'
    renderWithIntl(<Header siteName={site.name} galleryLead={null} />, { locale: 'vi' })

    const nav = within(switcher())
    expect(nav.getAllByRole('link')).toHaveLength(1)
    const english = nav.getByRole('link', { name: 'English' })
    expect(english).toHaveAttribute('href', '/en/writing')
    expect(english).toHaveAttribute('hreflang', 'en')
    expect(english).toHaveAttribute('lang', 'en')
    expect(within(switcher()).getByText(LANGUAGE_NAMES.vi).closest('[aria-current="true"]')).not.toBeNull()
  })

  it('on /en/writing: the other language links back to /writing, English is the current one', () => {
    pathname.value = '/en/writing'
    renderWithIntl(<Header siteName={site.name} galleryLead={null} />, { locale: 'en' })

    const nav = within(switcher())
    expect(nav.getAllByRole('link')).toHaveLength(1)
    expect(nav.getByRole('link', { name: LANGUAGE_NAMES.vi })).toHaveAttribute('href', '/writing')
    expect(within(switcher()).getByText('English').closest('[aria-current="true"]')).not.toBeNull()
    expect(screen.getByRole('navigation', { name: msg('Language.navLabel', undefined, 'en') })).toBe(switcher())
  })

  it('keeps the main navigation first and the switcher a separate landmark', () => {
    renderAt('/writing')

    const navs = screen.getByRole('banner').querySelectorAll('nav')
    expect(navs[0]).toBe(screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') }))
    expect(navs).toHaveLength(2)
  })
})

/**
 * The search overlay owns "/" and Ctrl/Cmd+K (a test above counts the document listeners at runtime). This is the static half: no
 * other module of the site chrome may handle those keys, so a second owner cannot appear by adding a component.
 */
describe('single owner of the global search keys', () => {
  function sources(dir: string): { file: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name === 'Header.tsx') return []
      return [{ file: path, text: readFileSync(path, 'utf8') }]
    })
  }

  const all = sources(join(process.cwd(), 'components', 'site'))

  it('no other component under components/site listens for "/" or Ctrl/Cmd+K', () => {
    expect(all.length).toBeGreaterThan(20)
    for (const { file, text } of all) {
      if (!/(document|window)\.addEventListener\(\s*['"]key(down|up|press)['"]/.test(text)) continue
      // The two panels listen for Escape only.
      expect(text, file).not.toMatch(/key\s*===?\s*['"]\/['"]/)
      expect(text, file).not.toMatch(/ctrlKey|metaKey/)
      expect(text, file).not.toMatch(/['"]k['"]/i)
    }
  })

  it('the language switcher handles no key but Escape and never the search keys', () => {
    const text = all.find(({ file }) => file.endsWith('LanguageSwitcher.tsx'))!.text
    expect(text).not.toMatch(/onKey/)
    expect(text).not.toMatch(/ctrlKey|metaKey|key\s*===?\s*['"]\/['"]/)
    expect([...text.matchAll(/event\.key\s*!==?\s*['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual(['Escape'])
  })

  it('rendering the switcher adds no document or window keydown listener while it is closed', () => {
    const onDocument = vi.spyOn(document, 'addEventListener')
    const onWindow = vi.spyOn(window, 'addEventListener')
    render(<LanguageSwitcher />)

    const keys = (spy: typeof onDocument | typeof onWindow) =>
      spy.mock.calls.filter(([type]) => String(type).startsWith('key')).length
    expect(keys(onDocument)).toBe(0)
    expect(keys(onWindow)).toBe(0)
    onDocument.mockRestore()
    onWindow.mockRestore()
  })
})

describe('isCurrentSection', () => {
  const section = (label: string): NavItem => {
    const item = navItems.find((candidate) => msg(`Site.nav.${candidate.labelKey}`) === label)
    expect(item, label).toBeDefined()
    return item!
  }

  it('matches a section by its own path, its children, and the paths it owns', () => {
    const writing = section(msg('Site.footer.links.writing'))

    for (const path of [
      '/writing',
      '/writing/page/2',
      '/posts',
      '/posts/abc',
      '/series',
      '/series/series-a',
      '/topics',
      '/archive',
      '/tags/aws',
      '/categories/kien-truc',
    ]) {
      expect(isCurrentSection(path, writing), path).toBe(true)
    }
    for (const path of ['/writingtips', '/postsomething', '/seriesx', '/tagsx', '/start-here', '/']) {
      expect(isCurrentSection(path, writing), path).toBe(false)
    }
  })

  it('files the gallery under the About group, and nothing but /start-here under the featured-posts item', () => {
    expect(isCurrentSection('/gallery', section(msg('Site.footer.links.about')))).toBe(true)
    expect(isCurrentSection('/galleryx', section(msg('Site.footer.links.about')))).toBe(false)
    expect(isCurrentSection('/start-here', section(msg('Site.footer.links.startHere')))).toBe(true)
    // Series is a way of viewing posts, belonging to the writing section, even though the featured-posts page lists series.
    expect(isCurrentSection('/series', section(msg('Site.footer.links.startHere')))).toBe(false)
  })

  it('would match a root item on / alone, never by prefix', () => {
    // No item is '/' any more. The function must still be right if such an item comes back: check the edge:
    // `prefix + '/'` turns '/' into '//', so '/' only matches itself without needing a separate flag.
    const root: NavItem = { href: '/', labelKey: 'root' }

    expect(isCurrentSection('/', root)).toBe(true)
    expect(isCurrentSection('/writing', root)).toBe(false)
    expect(isCurrentSection('/posts/x', root)).toBe(false)
    expect(isCurrentSection('/about', root)).toBe(false)
  })
})

describe('Header landmarks and keyboard order', () => {
  it('uses a <header> containing a named <nav>', () => {
    renderAt('/')

    const banner = screen.getByRole('banner')
    expect(banner.tagName).toBe('HEADER')
    // Named, because a page with more than one nav gives a screen reader user a list
    // of indistinguishable "navigation" landmarks.
    expect(banner.querySelector('nav')).toBe(screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') }))
  })

  it('puts its Container in the 1400px site frame: reader width, the frame hairlines, no marker attribute', () => {
    renderAt('/writing')

    const banner = screen.getByRole('banner')
    // The e2e frameGeometry hook is `banner > :scope > div`: exactly one direct div child, and it is the Container.
    const divs = Array.from(banner.children).filter((child) => child.tagName === 'DIV')
    expect(divs).toHaveLength(1)
    const frame = divs[0]!
    expect(frame).toHaveClass('max-w-[87.5rem]', 'frame:border-x', 'print:border-0')
    expect(frame).not.toHaveClass('max-w-5xl')
    expect(frame.hasAttribute('data-site-frame')).toBe(false)
    expect(banner.querySelector('[data-site-frame]')).toBeNull()
  })

  it('makes the skip link the first focusable element in the document', () => {
    renderAt('/writing')

    const order = focusables()
    expect(order.length).toBeGreaterThan(5)

    const first = order[0]!
    expect(first.tagName).toBe('A')
    expect(first).toHaveAccessibleName(msg('Site.nav.skipToContent'))
    // The target is the id app/layout.tsx puts on <main>. A skip link pointing at a
    // node that does not exist moves focus nowhere and is worse than none, because
    // the reader spends a Tab press on it.
    expect(first).toHaveAttribute('href', '#main-content')

    // Not just "a skip link exists somewhere": it must come before the author name,
    // which is the next thing in the tab order. Moving the <a> below <Container>
    // keeps every other assertion in this file green.
    expect(order[1]).toHaveAccessibleName(site.name)
  })

  it('keeps the skip link visually hidden until it is focused', () => {
    renderAt('/')

    const skip = focusables()[0]!
    // sr-only is the hiding mechanism; focus:not-sr-only is the reveal. Asserting the
    // class pair rather than a computed style because jsdom does not apply Tailwind's
    // generated CSS at all — see the note in ThemeToggle.test.tsx.
    expect(skip.className).toMatch(/\bsr-only\b/)
    expect(skip.className).toMatch(/\bfocus:not-sr-only\b/)
    // display:none / hidden would take it out of the tab order entirely, which is the
    // classic broken skip link.
    expect(skip.className).not.toMatch(/\bhidden\b/)
  })

  it('reaches all four nav links by keyboard without a disclosure button', () => {
    renderAt('/')

    const names = focusables().map((el) => el.textContent?.trim())
    for (const label of SECTIONS) {
      expect(names, `${label} must be reachable by Tab`).toContain(label)
    }
    // No hamburger: if a menu is ever added, these four stop being unconditionally
    // focusable and this assertion is the one that should be revisited deliberately.
    expect(screen.queryByRole('button', { name: MENU_NAME }), 'nav is a wrapping row, not a disclosure menu').toBeNull()
  })
})

/*
 * Footer and Container are tested in this file rather than in Footer.test.tsx /
 * Container.test.tsx because this run's file ownership grants exactly two new test
 * files under components/site, and a test that is not written is a test that cannot
 * fail. They are the same unit of work — the shell every page renders inside.
 */

/** One footer message in the locale of the current test. */
const footerText = (key: string) => msg(`Site.footer.${key}`)

/** The "read" group: the ways to read the blog, then a random post. In display order. */
const READ_GROUP = [
  [footerText('links.writing'), '/writing'],
  [footerText('links.startHere'), '/start-here'],
  [footerText('links.series'), '/series'],
  [footerText('links.topics'), '/topics'],
  [footerText('links.archive'), '/archive'],
  [footerText('links.random'), '/random'],
]

/** The "about me" group: the writer, then two follow channels (the newsletter). */
const ABOUT_GROUP = [
  [footerText('links.about'), '/about'],
  [footerText('links.caseStudies'), '/case-studies'],
  [footerText('links.gallery'), '/gallery'],
  [footerText('links.rss'), '/feed.xml'],
  [footerText('links.newsletter'), '/newsletter'],
]

/** All the text of the footer navigation: group labels then each link label. */
const FOOTER_NAV_TEXT = [
  footerText('readTitle'),
  ...READ_GROUP.map(([label]) => label),
  footerText('aboutTitle'),
  ...ABOUT_GROUP.map(([label]) => label),
].join('')

describe('Footer', () => {
  it('renders the name, the positioning line and the current year', async () => {
    await renderFooter()

    const footer = screen.getByRole('contentinfo')
    expect(footer.tagName).toBe('FOOTER')
    expect(footer).toHaveTextContent(site.name)
    expect(footer).toHaveTextContent(site.positioning)
    // The year is computed, not hardcoded. Compared against the same expression the
    // component uses, so this does not go stale on 1 January.
    expect(footer).toHaveTextContent(`© ${new Date().getFullYear()}`)
  })

  it("shows the site owner's filled-in email and GitHub, i.e. the shipping state", async () => {
    // Pins the real value (commit 8961f1b), so the test goes red when the data changes.
    await renderFooter()
    const footer = screen.getByRole('contentinfo')

    const hrefs = Array.from(footer.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.filter((href) => href?.startsWith('mailto:'))).toEqual(['mailto:reader@example.test'])
    expect(hrefs.filter((href) => href?.includes('github.com'))).toEqual(['https://github.com/example-user'])

    // GitHub carries `rel="me"` as in Hero and the contact section (`rel="me noreferrer"`):
    // the same claim "this profile is me" everywhere that link appears. The "absent" pair:
    // mailto carries no rel, because `me` on an email address says nothing.
    const github = within(footer).getByRole('link', { name: 'example-user' })
    expect(github.getAttribute('rel')?.split(/\s+/).sort()).toEqual(['me', 'noreferrer'])
    expect(within(footer).getByRole('link', { name: 'reader@example.test' })).not.toHaveAttribute('rel')

    // Verbatim copy: the two contact links sit right under the positioning line, then the two navigation
    // groups, with labels being the email address and the GitHub username — no placeholder, no "null"
    // from a template literal, and the icons add no text.
    expect(footer.textContent).toBe(
      `${site.name}${site.positioning}` +
        'reader@example.testexample-user' +
        FOOTER_NAV_TEXT +
        `© ${new Date().getFullYear()} ${site.name}`,
    )
    expect(footer.querySelectorAll('p')).toHaveLength(3)
    // Two navigation groups plus the contact list.
    expect(footer.querySelectorAll('ul')).toHaveLength(3)
  })

  it('places the Mail icon and the GitHub mark beside the two contact channels, accessible names unchanged', async () => {
    await renderFooter()
    const footer = screen.getByRole('contentinfo')

    // getByRole with the exact name: an aria-hidden icon contributes nothing to the link's name.
    expectIcon(within(footer).getByRole('link', { name: 'reader@example.test' }), <MailIcon />)
    expectIcon(within(footer).getByRole('link', { name: 'example-user' }), <BrandIcon name="github" />)
  })

  it('renders no contact links at all while both contact fields are null', async () => {
    // The other branch, still reachable: profile.ts's own rule is that an invented
    // address is worse than none, so the owner may clear either field. The conditional
    // must then produce an absent list, not an empty <ul> and not a placeholder.
    await renderFooter({ ...FILLED, email: null, github: null })
    const footer = screen.getByRole('contentinfo')

    // There is no CONTACT link at all. This assertion is deliberately narrower than before: the footer
    // now has a navigation list that does not depend on the site owner's data, so "no <a> tag at all"
    // became a false assertion — and if kept as is, the only way to make
    // it green again would be to remove the reader's way onward.
    const hrefs = Array.from(footer.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs.filter((href) => href?.startsWith('mailto:'))).toEqual([])
    expect(hrefs.filter((href) => href?.includes('github.com'))).toEqual([])
    // The contact list is absent entirely, not empty: only the two navigation groups remain.
    expect(footer.querySelectorAll('ul')).toHaveLength(2)

    // Verbatim copy, not a list of banned strings: `site.positioning` legitimately
    // contains a long dash, so "no — in the footer" is unusable.
    // This one is usable. Nothing replaces the two null fields — no "N/A", no
    // "email: null" falling out of a template literal, no empty mailto:.
    expect(footer.textContent).toBe(
      `${site.name}${site.positioning}` + FOOTER_NAV_TEXT + `© ${new Date().getFullYear()} ${site.name}`,
    )
  })

  it('always gives the reader a way onward, split into the read and about-me groups', async () => {
    // Built with two null contact slots so the test name stays true: the site owner filled in both, so
    // rendering the real data no longer checks the "no contact channel yet" case.
    await renderFooter({ ...FILLED, email: null, github: null })
    const nav = screen.getByRole('navigation', { name: footerText('navLabel') })
    const linksOf = (group: string) =>
      within(within(nav).getByRole('list', { name: group }))
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')])

    expect(linksOf(footerText('readTitle'))).toEqual(READ_GROUP)
    expect(linksOf(footerText('aboutTitle'))).toEqual(ABOUT_GROUP)
    expect(within(nav).getAllByRole('link')).toHaveLength(READ_GROUP.length + ABOUT_GROUP.length)

    // The group label is a heading, not a paragraph: the footer still has exactly three <p>.
    expect(
      within(nav)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([footerText('readTitle'), footerText('aboutTitle')])
  })

  it('links to /random and RSS with plain <a> tags, not through the client-side router', async () => {
    await renderFooter()
    const footer = screen.getByRole('contentinfo')

    // /random is a route handler that returns a 307 to a different post each time. Through `<Link>`, the router would
    // prefetch it and keep one destination in cache: every later click would go to the same post. `nofollow`
    // because robots.ts forbids /random — the destination page already has its own real URL.
    const random = within(footer).getByRole('link', { name: footerText('links.random') })
    expect(random.tagName).toBe('A')
    expect(random).toHaveAttribute('href', '/random')
    expect(random.getAttribute('rel')?.split(/\s+/)).toContain('nofollow')
    expect(random).not.toHaveAttribute('data-next-link')
    expectIcon(random, <ShuffleIcon />)

    // /feed.xml is a route handler that returns XML: there is no page for the client-side router to build.
    const rss = within(footer).getByRole('link', { name: footerText('links.rss') })
    expect(rss).toHaveAttribute('href', '/feed.xml')
    expect(rss).not.toHaveAttribute('data-next-link')
    expectIcon(rss, <RssIcon />)

    // The "present" pair: real pages still go through next/link (prefetch, client-side navigation), and
    // do not carry `nofollow` — search engines may follow them.
    const pages = [...READ_GROUP, ...ABOUT_GROUP].filter(([, href]) => href !== '/random' && href !== '/feed.xml')
    // Nine: /newsletter is a real page, going through next/link like the other pages.
    expect(pages).toHaveLength(9)
    for (const [label] of pages) {
      const link = within(footer).getByRole('link', { name: label })
      expect(link, label).toHaveAttribute('data-next-link')
      expect(link, label).not.toHaveAttribute('rel')
    }
  })

  it('still reads as a finished block with no CONTACT links', async () => {
    // Built with two null slots rather than the real data: the site owner filled in both, so rendering
    // the real data no longer checks the case this test's name refers to.
    await renderFooter({ ...FILLED, email: null, github: null })
    const footer = screen.getByRole('contentinfo')

    // Three paragraphs: name, positioning, copyright. A footer that collapsed to one
    // line when the links vanished would look broken rather than quiet.
    expect(footer.querySelectorAll('p')).toHaveLength(3)
  })
})

describe('Container', () => {
  it('owns one horizontal gutter at every width', () => {
    const { container } = render(<Container>x</Container>)
    const el = container.firstElementChild!

    // px-4 is the 16px minimum the brief requires at 360px; sm:px-6 widens it once
    // there is room. Both, or sections stop lining up at one of the two breakpoints.
    expect(el.className).toMatch(/\bpx-4\b/)
    expect(el.className).toMatch(/\bsm:px-6\b/)
  })

  it('defaults to the wide measure and switches to the prose measure on request', () => {
    const wide = render(<Container>x</Container>).container.firstElementChild!
    expect(wide.className).toMatch(/\bmax-w-5xl\b/)

    const prose = render(<Container width="prose">x</Container>).container.firstElementChild!
    expect(prose.className).toMatch(/\bmax-w-3xl\b/)
    // Not both: a container carrying max-w-3xl and max-w-5xl is a coin toss decided
    // by the order Tailwind happens to emit them in.
    expect(prose.className).not.toMatch(/\bmax-w-5xl\b/)
  })

  it('renders the element it is asked for, keeping the gutter', () => {
    const { container } = render(
      <Container as="section" width="prose" className="py-10">
        x
      </Container>,
    )
    const el = container.firstElementChild!

    expect(el.tagName).toBe('SECTION')
    expect(el.className).toMatch(/\bpx-4\b/)
    expect(el.className).toMatch(/\bpy-10\b/)
  })
})

describe('tap targets of small text links', () => {
  it('the header nav links and footer links enlarge the tap target with TAP_TARGET', async () => {
    // Measured on the QA stack: the nav link is 17px tall, the footer link 20px.
    renderAt('/')
    for (const link of within(screen.getByRole('navigation', { name: msg('Site.nav.mainLabel') })).getAllByRole('link')) {
      expect(link).toHaveClass('relative', 'after:absolute', 'after:-inset-x-1.5', 'after:-inset-y-2.5')
    }

    await renderFooter()
    const footer = within(screen.getByRole('navigation', { name: footerText('navLabel') }))
    for (const link of footer.getAllByRole('link'))
      expect(link).toHaveClass('relative', 'after:absolute', 'after:-inset-x-1.5', 'after:-inset-y-2.5')
  })
})

/**
 * the header's icon slots are 44px squares on a phone (the thumb-sized minimum; four of them and the gaps use 188 of the 288px of a 320px
 * phone) and the compact 36px slots from md, where the header is one row. Each slot keeps ICON_TAP_TARGET, an absolute `::after`
 * extending 4px per side, so the hit area is never smaller than the slot.
 */
describe('tap targets of the header icon slots', () => {
  const HIT_AREA = ['relative', 'after:absolute', 'after:-inset-1']

  function cluster(): HTMLElement {
    return screen.getByRole('link', { name: msg('Site.search.heading') }).parentElement!
  }

  it('guest: the search slot and the theme button are 44px below md, 36px from md; the sign-in button is 44px tall below md', () => {
    renderAt('/')

    const search = screen.getByRole('link', { name: msg('Site.search.heading') })
    const theme = within(cluster()).getByRole('button', { name: THEME_NAME })
    const login = within(cluster()).getByRole('link', { name: msg('Site.account.signInWithGithub') })
    for (const control of [search, theme]) {
      expect(control, control.getAttribute('aria-label') ?? control.textContent ?? '').toHaveClass(
        'h-11',
        'w-11',
        'md:h-9',
        'md:w-9',
        ...HIT_AREA,
      )
    }
    expect(login).toHaveClass('h-11', 'w-11', 'md:h-9', 'sm:w-auto', ...HIT_AREA)
  })

  it('signed in: both the bell and the account button', async () => {
    session.value = READER
    renderAt('/')
    await act(async () => {})

    const bell = within(cluster()).getByRole('button', { name: BELL_NAME })
    const account = within(cluster()).getByRole('button', { name: msg('Site.account.accountLabel', { name: 'Alice Reader' }) })
    expect(bell).toHaveClass('h-11', 'w-11', 'md:h-9', 'md:w-9', ...HIT_AREA)
    expect(account).toHaveClass('h-11', 'w-11', 'md:h-9', ...HIT_AREA)
  })

  it('the cluster gap is 4px below md and 8px from md: two adjacent tap areas meet, they do not swallow a neighbour', () => {
    renderAt('/')

    expect(
      cluster()
        .className.split(/\s+/)
        .filter((name) => /gap-/.test(name)),
    ).toEqual(['gap-1', 'md:gap-2'])
  })
})

describe('print', () => {
  it('header and footer do not print: print is the post, not the site chrome', async () => {
    renderAt('/posts/bai-viet')
    await renderFooter()

    expect(screen.getByRole('banner')).toHaveClass('print:hidden')
    expect(screen.getByRole('contentinfo')).toHaveClass('print:hidden')
  })
})

/**
 * sticky header, hidden when scrolling down, shown when scrolling up. Thresholds and delays are pure functions (lib/scroll-ui.test.ts);
 * here is the wiring: sticky mode after measuring, animation frames, keyboard vs mouse focus, height measurement, cleanup.
 * jsdom does not run Tailwind and does not understand `:focus-visible`: state is read through classes, keyboard focus is faked via `matches`.
 */
describe('sticky header ', () => {
  const HIDDEN = '-translate-y-full'
  let frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  let headerHeight = 64
  let resizeCallback: (() => void) | null = null
  /** true: the current focus arrived via the keyboard (`:focus-visible` matches the focused element). */
  let keyboard = false
  const windowScrollTo = vi.fn()

  function flushFrames() {
    act(() => {
      const pending = [...frames.values()]
      frames = new Map()
      for (const callback of pending) callback(0)
    })
  }

  /** The first computation (the header starts sticky), then the frame that turns on the transition. */
  function settle() {
    flushFrames()
    flushFrames()
  }

  function scrollTo(y: number) {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true })
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    flushFrames()
  }

  function focusWith(device: 'keyboard' | 'pointer', element: HTMLElement) {
    keyboard = device === 'keyboard'
    act(() => element.focus())
  }

  beforeEach(() => {
    frames = new Map()
    headerHeight = 64
    resizeCallback = null
    keyboard = false
    windowScrollTo.mockReset()
    vi.stubGlobal('scrollTo', windowScrollTo)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(nextFrame, callback)
      return nextFrame++
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizeCallback = callback
        }
        observe() {}
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.tagName === 'HEADER' ? headerHeight : 0, top: 0 } as DOMRect
    })
    const matches = Element.prototype.matches
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector === ':focus-visible') return keyboard && this === document.activeElement
      return matches.call(this, selector)
    })
    // jsdom does not build layout: give the page a height so there is room to scroll.
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 10_000, configurable: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true })
    delete (document.documentElement as { scrollHeight?: number }).scrollHeight
  })

  it('server HTML and first render: a normal header as without JS; sticky after measuring, transition from the next frame', async () => {
    pathname.value = '/'
    const html = renderToString(
      <IntlWrapper>
        <Header siteName={site.name} galleryLead={null} />
      </IntlWrapper>,
    )
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host)
    const banner = host.querySelector('header')!
    expect(banner.className).not.toMatch(/\bsticky\b|\bz-40\b|transition/)

    const errors: unknown[] = []
    const root = hydrateRoot(
      host,
      <IntlWrapper>
        <Header siteName={site.name} galleryLead={null} />
      </IntlWrapper>,
      { onRecoverableError: (error) => errors.push(error) },
    )
    await act(async () => {})
    expect(errors).toEqual([])
    expect(banner).not.toHaveClass('sticky')

    flushFrames()
    expect(banner).toHaveClass('sticky', 'top-0', 'z-40', 'border-b', 'bg-white', 'dark:bg-neutral-950', 'print:hidden')
    // Changing mode without a transition: when a page opens already scrolled to the middle, the header does not slide up before the reader's eyes.
    expect(banner).not.toHaveClass('transition-transform')
    flushFrames()
    expect(banner).toHaveClass('transition-transform', 'duration-200', 'motion-reduce:transition-none')
    // No blur, no height change: only translate.
    expect(banner.className).not.toMatch(/backdrop|blur|\bh-\d/)
    expect(banner).not.toHaveClass(HIDDEN)

    act(() => root.unmount())
    host.remove()
  })

  it('scrolling down past the threshold hides it, scrolling up 4px shows it immediately, at the top it is always shown', () => {
    renderAt('/writing')
    settle()
    const banner = screen.getByRole('banner')

    scrollTo(100)
    expect(banner).not.toHaveClass(HIDDEN)
    scrollTo(500)
    expect(banner).toHaveClass(HIDDEN)
    scrollTo(497)
    expect(banner).toHaveClass(HIDDEN)
    scrollTo(496)
    expect(banner).not.toHaveClass(HIDDEN)
    scrollTo(900)
    expect(banner).toHaveClass(HIDDEN)
    scrollTo(0)
    expect(banner).not.toHaveClass(HIDDEN)
  })

  it('many scroll events in one frame: computed once; the scroll listener is passive', () => {
    const add = vi.spyOn(window, 'addEventListener')
    renderAt('/')
    settle()

    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })
    Object.defineProperty(window, 'scrollY', { value: 800, configurable: true, writable: true })
    act(() => {
      for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event('scroll'))
    })
    expect(frames.size).toBe(1)
    flushFrames()
    expect(screen.getByRole('banner')).toHaveClass(HIDDEN)
  })

  it('keyboard focus into the header (skip link, theme button): shown immediately, and stays shown on further scrolling', () => {
    renderAt('/')
    settle()
    const banner = screen.getByRole('banner')
    const skip = screen.getByRole('link', { name: msg('Site.nav.skipToContent') })
    const theme = within(banner).getByRole('button', { name: THEME_NAME })

    for (const control of [skip, theme]) {
      scrollTo(3000)
      expect(banner).toHaveClass(HIDDEN)
      // No waiting for a frame: focus shows the header immediately, in the event.
      focusWith('keyboard', control)
      expect(banner).not.toHaveClass(HIDDEN)

      scrollTo(3600)
      expect(banner, 'keyboard focus is still inside the header').not.toHaveClass(HIDDEN)

      act(() => control.blur())
      scrollTo(3700)
      expect(banner).toHaveClass(HIDDEN)
      scrollTo(0)
    }
  })

  it('a mouse click or touch on a header button (the browser focuses it) does not pin the header: scrolling down still hides it', () => {
    renderAt('/')
    settle()
    const banner = screen.getByRole('banner')
    scrollTo(3000)
    scrollTo(2900)
    expect(banner).not.toHaveClass(HIDDEN)

    focusWith('pointer', within(banner).getByRole('button', { name: THEME_NAME }))
    expect(document.activeElement).toBe(within(banner).getByRole('button', { name: THEME_NAME }))
    scrollTo(3100)
    expect(banner).toHaveClass(HIDDEN)
    expect(windowScrollTo).not.toHaveBeenCalled()
  })

  it('the header menu is open (aria-expanded): the header stays still on scroll, even when opened by mouse; closing it allows hiding', async () => {
    session.value = READER
    renderAt('/')
    await act(async () => {})
    settle()
    const banner = screen.getByRole('banner')
    const account = within(banner).getByRole('button', { name: msg('Site.account.accountLabel', { name: 'Alice Reader' }) })
    scrollTo(3000)
    scrollTo(2900)

    act(() => account.click())
    expect(account).toHaveAttribute('aria-expanded', 'true')
    scrollTo(3400)
    expect(banner, 'the account panel is open').not.toHaveClass(HIDDEN)

    act(() => account.click())
    expect(account).toHaveAttribute('aria-expanded', 'false')
    scrollTo(3500)
    expect(banner).toHaveClass(HIDDEN)
  })

  /**
   * Chrome's "scroll into view" jump when Tabbing into a sticky header: happens BEFORE focusin, its scroll event arrives
   * AFTER (measured on real Chrome), so here only scrollY changes, without firing scroll.
   */
  function browserScrollBeforeFocus(y: number) {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true })
  }

  it('Tab into a hidden header: the page returns to where the last scroll event saw it, the header shows', () => {
    renderAt('/')
    settle()
    scrollTo(3000)

    browserScrollBeforeFocus(2519)
    focusWith('keyboard', screen.getByRole('link', { name: msg('Site.nav.skipToContent') }))

    expect(windowScrollTo).toHaveBeenCalledExactlyOnceWith(0, 3000)
    expect(screen.getByRole('banner')).not.toHaveClass(HIDDEN)
  })

  it('Tab into a visible header (Shift+Tab up from the content): the page does not jump either', () => {
    renderAt('/')
    settle()
    scrollTo(3000)
    scrollTo(2990)
    expect(screen.getByRole('banner')).not.toHaveClass(HIDDEN)

    browserScrollBeforeFocus(2600)
    focusWith('keyboard', screen.getByRole('link', { name: msg('Site.nav.skipToContent') }))

    expect(windowScrollTo).toHaveBeenCalledExactlyOnceWith(0, 2990)
  })

  it('does not return the scroll when focus comes from a mouse or touch, or when the page is not offset', () => {
    renderAt('/')
    settle()
    const skip = () => screen.getByRole('link', { name: msg('Site.nav.skipToContent') })

    scrollTo(3000)
    browserScrollBeforeFocus(2519)
    focusWith('pointer', skip())
    expect(windowScrollTo).not.toHaveBeenCalled()
    act(() => skip().blur())

    scrollTo(3300)
    focusWith('keyboard', skip())
    expect(windowScrollTo).not.toHaveBeenCalled()
  })

  it('opening the page mid-way (#section link, reload): the header yields room on the first computation, no slide', () => {
    Object.defineProperty(window, 'scrollY', { value: 1800, configurable: true, writable: true })
    renderAt('/posts/bai-viet')
    flushFrames()

    const banner = screen.getByRole('banner')
    expect(banner).toHaveClass('sticky', HIDDEN)
    expect(banner).not.toHaveClass('transition-transform')
  })

  it('writes the header height to --site-header-h on <html>, via ResizeObserver; unmount removes the variable, listener, pending frame', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const root = document.documentElement
    const { unmount } = renderAt('/')

    expect(root.style.getPropertyValue('--site-header-h')).toBe('64px')
    settle()
    // Narrowed, nav drops to a second row: new height, and the hiding threshold (2 × 97px) follows.
    headerHeight = 97
    act(() => resizeCallback!())
    expect(root.style.getPropertyValue('--site-header-h')).toBe('97px')
    // With 64px, 190px is already past the 128px threshold and the header would hide.
    scrollTo(190)
    expect(screen.getByRole('banner')).not.toHaveClass(HIDDEN)
    scrollTo(260)
    expect(screen.getByRole('banner')).toHaveClass(HIDDEN)

    scrollTo(3000)
    focusWith('keyboard', screen.getByRole('link', { name: msg('Site.nav.skipToContent') }))
    unmount()
    expect(root.style.getPropertyValue('--site-header-h')).toBe('')
    expect(frames.size, 'the pending scroll restore frame is cancelled').toBe(0)
    for (const type of ['scroll']) {
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function))
    }
  })
})
