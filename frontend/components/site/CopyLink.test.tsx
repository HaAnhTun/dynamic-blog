import { render, screen, within } from '@testing-library/react'
import { IntlWrapper } from '@/test/intl'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPY_LINK_FEEDBACK_MS, CopyLink } from './CopyLink'
import { msg } from '@/test/render-intl'
import { ACCENTED_SLUG } from '@/test/fixtures/vi/copy-link'
import { HERO_BUTTON } from './reader/hero-button'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * jsdom implements no Clipboard API at all, so `navigator.clipboard` is `undefined`
 * out of the box — which is exactly the insecure-origin case, for free. Installing a
 * stub has to go through `defineProperty` because `navigator` is a getter-only
 * property on the window; assigning to it throws in strict mode.
 */
function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  })
  return navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
}

function removeClipboard() {
  // `delete` rather than setting undefined: the component checks
  // `typeof clipboard?.writeText !== 'function'`, and both spellings must behave the
  // same way. This is the state a plain-http LAN origin is in.
  Reflect.deleteProperty(navigator, 'clipboard')
}

const button = () => screen.getByRole('button', { name: msg('Site.share.copyLink') })
const status = () => screen.getByRole('status')

async function click() {
  // `await act(async …)`: the handler is async, so the state update lands in a
  // microtask after the click returns. A synchronous `act` leaves the assertions
  // reading the pre-click render and every one of them passes for the wrong reason.
  await act(async () => {
    button().click()
  })
}

beforeEach(() => {
  // A DIFFERENT origin and path from the page jsdom is pretending to serve
  // (http://localhost:3000/), so "built from the slug" and "read off
  // window.location" produce visibly different strings.
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://blog.example.com')
})

afterEach(() => {
  removeClipboard()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('CopyLink', () => {
  it('copies the URL of the post in its own language', async () => {
    const writeText = installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" language="en" />)

    await click()

    expect(writeText).toHaveBeenCalledWith('https://blog.example.com/en/posts/dat-van-de')
  })

  it('copies the canonical URL built from the slug', async () => {
    const writeText = installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" />)

    await click()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('https://blog.example.com/posts/dat-van-de')
  })

  it('ignores window.location entirely', async () => {
    // The point of building the URL from the slug is that the component renders on the
    // server first, where there is no `window` — and that the copied string is the
    // CANONICAL URL rather than whatever the address bar holds: a ?utm_source=, a
    // trailing #section, a preview host.
    //
    // So: move `location` somewhere else and assert the copied string does not follow.
    vi.stubGlobal('location', {
      href: 'https://preview-7.vercel.app/posts/dat-van-de?utm_source=newsletter#ket-luan',
      origin: 'https://preview-7.vercel.app',
      pathname: '/posts/dat-van-de',
    })
    const writeText = installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" />)

    await click()

    expect(writeText).toHaveBeenCalledWith('https://blog.example.com/posts/dat-van-de')
    // Named explicitly so the failure message says what went wrong.
    expect(writeText).not.toHaveBeenCalledWith(window.location.href)
    expect(String(writeText.mock.calls[0][0])).not.toContain('utm_source')
    expect(String(writeText.mock.calls[0][0])).not.toContain('preview-7')
  })

  it('percent-encodes a slug that needs it', async () => {
    const writeText = installClipboard(async () => {})
    render(<CopyLink slug={ACCENTED_SLUG} />)

    await click()

    expect(writeText).toHaveBeenCalledWith(`https://blog.example.com/posts/${encodeURIComponent(ACCENTED_SLUG)}`)
  })

  it('announces success in a live region', async () => {
    installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" />)

    // Empty before the click, and PRESENT: a live region inserted into the DOM with
    // text already in it is announced immediately, so it has to exist empty first or
    // every page load announces the "copied" sentence.
    expect(status()).toBeInTheDocument()
    expect(status()).toHaveTextContent('')

    await click()

    // Not the English phrase "into the clipboard" on a Vietnamese page, and it says nothing more.
    expect(status().textContent).toBe(msg('Site.share.copied'))
    expect(status()).toHaveAttribute('aria-live', 'polite')
  })

  it('reports a failure instead of doing nothing when there is no clipboard API', async () => {
    // `navigator.clipboard` is undefined on every insecure origin that is not
    // localhost — which is how someone checks this site from their phone on the LAN.
    removeClipboard()
    render(<CopyLink slug="dat-van-de" />)

    await click()

    // Not a throw, and not a silent no-op: a button that looks like it worked and did
    // not is the worst of the three outcomes.
    expect(status()).toHaveTextContent(msg('Site.share.copyFailed'))
  })

  it('reports a failure when writeText rejects', async () => {
    // NotAllowedError: permission denied, or the document is not focused — which is
    // the normal state of a background tab. An unhandled rejection in an event
    // handler is invisible to the reader.
    installClipboard(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    render(<CopyLink slug="dat-van-de" />)

    const unhandled: unknown[] = []
    const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason)
    window.addEventListener('unhandledrejection', onUnhandled)
    try {
      await click()
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled)
    }

    expect(status()).toHaveTextContent(msg('Site.share.copyFailed'))
    expect(unhandled).toEqual([])
  })

  it('reports a failure when writeText throws synchronously', async () => {
    // Some polyfills and some older WebViews throw rather than reject. `await` inside
    // the try covers both, but only because the CALL is inside the try — hoisting it
    // out to `const p = clipboard.writeText(url)` would let this one escape.
    installClipboard((() => {
      throw new TypeError('Illegal invocation')
    }) as unknown as (text: string) => Promise<void>)
    render(<CopyLink slug="dat-van-de" />)

    await expect(click()).resolves.toBeUndefined()
    expect(status()).toHaveTextContent(msg('Site.code.copyFailedShort'))
  })

  it('reports a failure when clipboard exists but writeText is not a function', async () => {
    // A partially polyfilled Clipboard API — `'clipboard' in navigator` is true and
    // calling writeText is a TypeError. A presence check alone passes this and then
    // throws on the click.
    Object.defineProperty(navigator, 'clipboard', {
      value: {},
      configurable: true,
      writable: true,
    })
    render(<CopyLink slug="dat-van-de" />)

    await click()

    expect(status()).toHaveTextContent(msg('Site.code.copyFailedShort'))
  })

  it('keeps one stable accessible name across every state', async () => {
    installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" />)

    // The visible text IS the name, so a voice-control user can say what they read
    // (WCAG 2.5.3), and it does not change when the state does — a button whose name
    // becomes "copied" is a different control to assistive tech, and the user
    // who was told to click the copy-link button can no longer find it.
    expect(button()).toBeInTheDocument()
    await click()
    expect(screen.getByRole('button', { name: msg('Site.share.copyLink') })).toBeInTheDocument()
  })

  it('hides the decorative icon from the accessibility tree', () => {
    const { container } = render(<CopyLink slug="dat-van-de" />)
    const svg = container.querySelector('svg')

    // Without aria-hidden the icon contributes nothing readable but can still be
    // reached; `focusable="false"` is the IE/Edge-legacy half that keeps an inline
    // SVG out of the tab order.
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
  })

  it('renders on the server without touching window or navigator', () => {
    // The real guard against `window.location` creeping back in: this render happens
    // with no DOM globals read at all, and `navigator.clipboard` is not consulted
    // until a click. If the URL were read from `location` at render time this would
    // either throw here or produce a different string in the SSR HTML than after
    // hydration, which React reports as a mismatch and a reader sees as a flash.
    const html = renderToStaticMarkup(
      <IntlWrapper>
        <CopyLink slug="dat-van-de" />
      </IntlWrapper>,
    )

    expect(html).toContain(msg('Site.share.copyLink'))
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('role="status"')
    expect(html).not.toContain('localhost')
    expect(html).not.toContain('blog.example.com')
  })

  it('fixed height like the ShareBar cells: 40px on a phone, 32px from 640px', () => {
    render(<CopyLink slug="dat-van-de" />)

    // The old `py-1` version was 26px tall, lower than the three 32px brand cells beside it and shifted down 3px.
    expect(button()).toHaveClass('h-10', 'sm:h-8')
    expect(button()).not.toHaveClass('py-1')
  })

  it('appends the caller class without dropping its own layout classes', () => {
    const { container } = render(<CopyLink slug="dat-van-de" className="mt-4" />)
    const root = container.firstElementChild

    expect(root?.className).toMatch(/\bmt-4\b/)
    expect(root?.className).toMatch(/\bflex\b/)
  })
})

/*
 * The result sentence does not stay forever. Before, the copied sentence stayed until leaving the page, so
 * a second successful press changed nothing in the live region — a screen reader did not read it again, and the person
 * pressing did not know whether it ran. Now each press clears the old sentence first (like CopyCodeButton), "copied"
 * switches off by itself after COPY_LINK_FEEDBACK_MS, while an error sentence stays until the next press.
 */
describe('CopyLink: the result sentence returns to empty by itself', () => {
  const COPIED = msg('Site.share.copied')
  const FAILED = msg('Site.share.copyFailed')

  it('long enough to read, then switches off: ~3 seconds', () => {
    expect(COPY_LINK_FEEDBACK_MS).toBe(3000)
  })

  it(`"${COPIED}" returns to empty after COPY_LINK_FEEDBACK_MS`, async () => {
    // Fake only the timers: the Promise of writeText still runs for real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" />)

    await click()
    act(() => vi.advanceTimersByTime(COPY_LINK_FEEDBACK_MS - 1))
    expect(status()).toHaveTextContent(COPIED)

    act(() => vi.advanceTimersByTime(1))
    expect(status()).toHaveTextContent(/^$/)
    // The live region is still there, empty: the next press is read again.
    expect(status()).toHaveAttribute('aria-live', 'polite')
  })

  it('a new press clears the old sentence before copying, so the success sentence is read again', async () => {
    let finish: () => void = () => {}
    installClipboard(() => new Promise<void>((resolve) => (finish = resolve)))
    render(<CopyLink slug="dat-van-de" />)
    await act(async () => {
      button().click()
      finish()
    })
    expect(status()).toHaveTextContent(COPIED)

    // The second time is still waiting for the clipboard: the old sentence is gone, no new one yet — the live region changes twice, so it is read.
    await act(async () => {
      button().click()
    })
    expect(status()).toHaveTextContent(/^$/)

    await act(async () => finish())
    expect(status()).toHaveTextContent(COPIED)
  })

  it('pressing again while the sentence is still there: counts again from the new press, does not switch off midway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const writeText = installClipboard(async () => {})
    render(<CopyLink slug="dat-van-de" />)

    await click()
    act(() => vi.advanceTimersByTime(2000))
    await click()
    act(() => vi.advanceTimersByTime(2000))

    // 4000 ms after the first press, 2000 ms after the second: still reporting.
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(status()).toHaveTextContent(COPIED)
    act(() => vi.advanceTimersByTime(COPY_LINK_FEEDBACK_MS - 2000))
    expect(status()).toHaveTextContent(/^$/)
  })

  it('an error sentence does not switch off by itself; a later successful press removes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    removeClipboard()
    render(<CopyLink slug="dat-van-de" />)

    await click()
    act(() => vi.advanceTimersByTime(COPY_LINK_FEEDBACK_MS * 3))
    // The error sentence tells the reader what to do (copy from the address bar): it stays until they try again.
    expect(status()).toHaveTextContent(FAILED)

    installClipboard(async () => {})
    await click()
    expect(status()).toHaveTextContent(COPIED)
  })

  it('leaving the page while the sentence is still there: the timer is cleaned up with the component, nothing runs afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    installClipboard(async () => {})
    const { unmount } = render(<CopyLink slug="dat-van-de" />)

    await click()
    expect(vi.getTimerCount()).toBe(1)
    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('CopyLink: the hero variant', () => {
  it('uses the hero button recipe: 44px on a phone and 40px from sm, no 32px step', () => {
    render(<CopyLink variant="hero" slug="dat-van-de" />)

    expect(button()).toHaveClass('h-11', 'sm:h-10', 'px-3.5', 'text-sm')
    expect(button()).not.toHaveClass('sm:h-8')
    expect(button().className).toContain(HERO_BUTTON)
  })

  it('is a 44px square with the icon alone below sm: the label is screen-reader text there and the name of the button everywhere', () => {
    render(<CopyLink variant="hero" slug="dat-van-de" />)

    expect(button()).toHaveClass('max-sm:w-11', 'max-sm:justify-center', 'max-sm:px-0')
    expect(within(button()).getByText(msg('Site.share.copyLink'))).toHaveClass('max-sm:sr-only')
  })

  it('draws a 16px icon and keeps the same visible name', () => {
    const { container } = render(<CopyLink variant="hero" slug="dat-van-de" />)

    expect(container.querySelector('svg')).toHaveClass('h-4', 'w-4')
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(button()).toBeInTheDocument()
  })

  it('wraps in a relative box and puts the always-present status under the button: in the flow on a phone, out of the flow from sm', () => {
    const { container } = render(<CopyLink variant="hero" slug="dat-van-de" />)
    const root = container.firstElementChild!

    expect(root).toHaveClass('relative')
    expect(status().parentElement).toBe(root)
    expect(button().parentElement).toBe(root)
    expect(status()).toHaveClass('sm:absolute', 'sm:start-0', 'sm:top-full', 'mt-1')
    expect(status()).not.toHaveClass('absolute', 'whitespace-nowrap')
    expect(status()).toHaveAttribute('aria-live', 'polite')
    expect(status()).toHaveTextContent('')
  })

  it('bounds the failure sentence to the window and lets it wrap (no nowrap, no overflow at 320px)', async () => {
    installClipboard(async () => {
      throw new Error('denied')
    })
    render(<CopyLink variant="hero" slug="dat-van-de" />)

    await click()

    expect(status()).toHaveTextContent(msg('Site.share.copyFailed'))
    expect(status().className).toContain('max-w-[calc(100vw-2rem)]')
    expect(status().className).toContain('sm:max-w-[min(20rem,calc(100vw-2rem))]')
    expect(status().className).not.toContain('whitespace-nowrap')
  })

  it('still copies the canonical URL and announces it', async () => {
    const writeText = installClipboard(async () => {})
    render(<CopyLink variant="hero" slug="dat-van-de" language="en" />)

    await click()

    expect(writeText).toHaveBeenCalledWith('https://blog.example.com/en/posts/dat-van-de')
    expect(status()).toHaveTextContent(msg('Site.share.copied'))
  })

  it('the default variant is unchanged: a flex wrapper, a static status, the 40px / 32px cell', () => {
    const { container } = render(<CopyLink slug="dat-van-de" />)

    expect(container.firstElementChild).not.toHaveClass('relative')
    expect(container.firstElementChild).toHaveClass('flex', 'flex-wrap', 'gap-x-3', 'gap-y-1')
    expect(status()).not.toHaveClass('absolute')
    expect(status().className).toBe('text-xs text-neutral-600 dark:text-neutral-400')
    expect(button()).toHaveClass('h-10', 'sm:h-8', 'px-2.5', 'text-xs')
  })
})
