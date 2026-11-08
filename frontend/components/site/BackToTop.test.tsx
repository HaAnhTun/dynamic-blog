import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackToTop } from './BackToTop'
import { msg } from '@/test/render-intl'

/*
 * The thresholds (4 screens, 1.5 screens) are a pure function in lib/scroll-ui.test.ts. Here it is the island: scroll events,
 * the press, focus, reduced motion. jsdom does not run Tailwind: the hidden state is read through `inert` and the class.
 */

let frames: FrameRequestCallback[] = []
let reducedMotion = false
const scrollToMock = vi.fn()

function flushFrames() {
  act(() => {
    const pending = frames
    frames = []
    for (const callback of pending) callback(0)
  })
}

/** A page `documentHeight` tall, an 800px viewport, scrolled to `y`. */
function scrollPage(y: number, documentHeight = 8000) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: documentHeight, configurable: true })
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true })
  act(() => {
    window.dispatchEvent(new Event('scroll'))
  })
  flushFrames()
}

function renderButton() {
  const view = render(
    <>
      {/* Like app/(site)/layout.tsx: <main> has no fixed tabIndex. */}
      <main id="main-content">
        <textarea aria-label={msg('Site.comments.heading')} />
      </main>
      <BackToTop />
    </>,
  )
  // hidden: true — at first the button is inside the inert region.
  const button = screen.getByRole('button', { name: msg('Site.shell.backToTop'), hidden: true })
  const shell = button.parentElement!
  const shown = () => !shell.hasAttribute('inert') && shell.classList.contains('visible')
  return { ...view, button, shell, shown }
}

beforeEach(() => {
  frames = []
  reducedMotion = false
  scrollToMock.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('scrollTo', scrollToMock)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true })
  delete (document.documentElement as { scrollHeight?: number }).scrollHeight
})

describe('BackToTop (T-002)', () => {
  it('hidden at the top of the page; shown when a long page has scrolled past 1.5 screens; hidden again when scrolled back', () => {
    const { shown } = renderButton()
    flushFrames()
    expect(shown()).toBe(false)

    scrollPage(1000)
    expect(shown()).toBe(false)
    scrollPage(1300)
    expect(shown()).toBe(true)
    scrollPage(200)
    expect(shown()).toBe(false)
  })

  it('a page not longer than 4 screens: not shown even when scrolled to the bottom', () => {
    const { shown } = renderButton()
    scrollPage(2400, 3200)
    expect(shown()).toBe(false)
  })

  it('when hidden: inert (out of the Tab order and accessibility tree), invisible, faded and shifted down; the reverse when shown', () => {
    const { shell } = renderButton()
    flushFrames()
    expect(shell).toHaveAttribute('inert')
    expect(shell).toHaveClass('invisible', 'opacity-0', 'translate-y-2')

    scrollPage(3000)
    expect(shell).not.toHaveAttribute('inert')
    expect(shell).toHaveClass('visible', 'opacity-100')
    expect(shell).not.toHaveClass('invisible')
    // The motion includes visibility (so the button is still painted while fading out), fully off when the reader reduces motion.
    expect(shell).toHaveClass('transition-[opacity,translate,visibility]', 'motion-reduce:transition-none')
  })

  it('press: smooth scroll to the top, then focus <main> without scrolling further; tabindex="-1" lives only until the first blur', () => {
    const { button } = renderButton()
    scrollPage(3000)
    const main = document.getElementById('main-content')!
    const focus = vi.spyOn(main, 'focus')

    act(() => button.click())

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(main)
    expect(main).toHaveAttribute('tabindex', '-1')

    // Leaving <main> (Tab to the first link of the content): the tabindex is removed, a later press on the text does not focus <main>.
    act(() => screen.getByRole('textbox', { name: msg('Site.comments.heading') }).focus())
    expect(main).not.toHaveAttribute('tabindex')
  })

  it('<main> already has its own tabindex: kept as is, not removed on blur', () => {
    const { button } = renderButton()
    const main = document.getElementById('main-content')!
    main.setAttribute('tabindex', '0')
    scrollPage(3000)

    act(() => button.click())
    expect(document.activeElement).toBe(main)
    act(() => main.blur())
    expect(main).toHaveAttribute('tabindex', '0')
  })

  it('the button holds focus and hides (scrolled back by keyboard): focus moves to <main>, does not fall to <body>', () => {
    const { button, shown } = renderButton()
    scrollPage(3000)
    act(() => button.focus())
    expect(document.activeElement).toBe(button)
    const focus = vi.spyOn(document.getElementById('main-content')!, 'focus')

    scrollPage(100)

    expect(shown()).toBe(false)
    expect(document.activeElement).toBe(document.getElementById('main-content'))
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('a reader who reduces motion (prefers-reduced-motion): instant return to the top', () => {
    reducedMotion = true
    const { button } = renderButton()
    scrollPage(3000)

    act(() => button.click())

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
    expect(document.activeElement).toBe(document.getElementById('main-content'))
  })

  it('a browser without matchMedia: still scrolls (smoothly), no error', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { button } = renderButton()
    scrollPage(3000)

    act(() => button.click())

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('hidden while a text input has focus (comment form on a phone), shown again when leaving the input', () => {
    const { shown } = renderButton()
    scrollPage(3000)
    expect(shown()).toBe(true)

    const field = screen.getByRole('textbox', { name: msg('Site.comments.heading') })
    act(() => field.focus())
    expect(shown()).toBe(false)

    act(() => field.blur())
    expect(shown()).toBe(true)
  })

  it('the "Back to top" text is always the button name; below sm only hidden from the eye; not printed; sticks to the bottom-right corner leaving the safe area', () => {
    const { button, shell } = renderButton()

    expect(button).toHaveAttribute('type', 'button')
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(button.querySelector('span')).toHaveClass('max-sm:sr-only')
    expect(button).toHaveClass('rounded-full', 'border', 'hover:text-brand', 'focus-visible:outline-brand', 'after:absolute')
    expect(shell).toHaveClass('fixed', 'z-30', 'print:hidden')
    expect(shell.className).toMatch(/bottom-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/)
    expect(shell.className).toMatch(/right-\[calc\(1rem\+env\(safe-area-inset-right\)\)\]/)
  })

  it('unmount: removes the scroll, resize and focus listeners', () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderButton()

    unmount()

    expect(removeWindow.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['scroll', 'resize']))
    expect(removeDocument.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['focusin', 'focusout']))
  })
})
