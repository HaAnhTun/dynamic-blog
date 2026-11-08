import { fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StrictMode } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatDate } from '@/lib/date'
import { mediaPath } from '@/lib/media'
import type { GalleryPhoto } from '@/lib/types'
import { GalleryGrid } from './GalleryGrid'
import { GalleryLightbox } from './GalleryLightbox'
import { msg } from '@/test/render-intl'

/**
 * The photo viewer: a client island wrapping the server grid, catching the press on a cell with event delegation and opening
 * a `<dialog>` with `showModal()`.
 *
 * jsdom 29 has HTMLDialogElement but neither `showModal` nor `close` (it only mirrors the `open`
 * attribute), so this file installs the two functions with exactly the behavior to pin: `close` fires the
 * `close` event like a browser, and `showModal` throws InvalidStateError when the dialog is already open — that is the
 * behavior of older browsers, and it is what makes the bug "showModal called twice" (StrictMode, switching image) show up
 * as a red test instead of silently.
 *
 * Keyboard, swipe and backdrop presses are all fired at the real element the browser would target (the button that has
 * focus, the image, the `<dialog>` itself — a press on ::backdrop has the dialog as its target).
 */

const original = {
  showModal: HTMLDialogElement.prototype.showModal,
  close: HTMLDialogElement.prototype.close,
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    if (this.open) throw new DOMException('The dialog is already open.', 'InvalidStateError')
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

afterAll(() => {
  HTMLDialogElement.prototype.showModal = original.showModal
  HTMLDialogElement.prototype.close = original.close
})

afterEach(() => {
  vi.restoreAllMocks()
  document.head.querySelectorAll('link[rel="preload"]').forEach((link) => link.remove())
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function photo(n: number, extra: Partial<Omit<GalleryPhoto, 'image'>> = {}): GalleryPhoto {
  return {
    id: uuid(100 + n),
    image: {
      id: uuid(n),
      fileName: `${uuid(n)}.jpg`,
      width: n % 2 === 0 ? 1200 : 1600,
      height: n % 2 === 0 ? 1600 : 1200,
      altText: `Photo description number ${n}`,
      dominantColor: '#5a6b7c',
    },
    caption: null,
    takenOn: null,
    ...extra,
  }
}

const SIX = [1, 2, 3, 4, 5, 6].map((n) => photo(n))

function renderGallery(photos: GalleryPhoto[] = SIX, { strict = false } = {}) {
  const ui = (
    <GalleryLightbox photos={photos}>
      <GalleryGrid photos={photos} />
    </GalleryLightbox>
  )
  return render(strict ? <StrictMode>{ui}</StrictMode> : ui)
}

const dialog = () => document.querySelector('dialog')!
const box = () => within(dialog())
const tile = (n: number) => screen.getByRole('link', { name: `Photo description number ${n}` })
/** The text the eye sees of the counter. */
const counterText = () => box().getByText(/^\d+ \/ \d+$/).textContent
const shownAlt = () => box().getByRole('img').getAttribute('alt')

/** The `url` value that the default next/image loader writes into src: the path of the original image. */
const sourceOf = (img: HTMLElement) => new URL(img.getAttribute('src') ?? '', 'http://localhost').searchParams.get('url')

function openAt(n: number) {
  return fireEvent.click(tile(n))
}

function pressKey(key: string, init: KeyboardEventInit = {}) {
  // Keys go into the focused element and then bubble up to the dialog, like in a browser.
  fireEvent.keyDown(document.activeElement ?? dialog(), { key, ...init })
}

function swipe(target: Element, from: [number, number], to: [number, number], pointerType = 'touch') {
  fireEvent.pointerDown(target, { clientX: from[0], clientY: from[1], isPrimary: true, pointerType })
  fireEvent.pointerUp(target, { clientX: to[0], clientY: to[1], isPrimary: true, pointerType })
}

describe('GalleryLightbox: open', () => {
  it('closed and empty before any press; the grid is still real links', () => {
    renderGallery()

    expect(dialog()).not.toBeNull()
    expect(dialog().open).toBe(false)
    expect(dialog().childElementCount).toBe(0)
    expect(tile(1)).toHaveAttribute('href', mediaPath(SIX[0]!.image))
  })

  it('pressing a cell: prevents navigation, showModal, focus on "Close", the right image and the name "Photo n of N"', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    renderGallery()

    // false = defaultPrevented: the browser does not leave the page to open the original image file.
    expect(openAt(2)).toBe(false)

    expect(dialog().open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(dialog()).toHaveAttribute('aria-label', msg('Site.gallery.dialogLabel', { index: '2', total: '6' }))
    expect(box().getByRole('button', { name: msg('Site.gallery.close') })).toHaveFocus()

    const img = box().getByRole('img')
    expect(img).toHaveAttribute('alt', 'Photo description number 2')
    expect(sourceOf(img)).toBe(mediaPath(SIX[1]!.image))
    // The viewer shows the whole image, not cropped like the square cell.
    expect(img.getAttribute('class')).toContain('object-contain')
  })

  it('pressing with Ctrl/⌘/Shift/Alt leaves the browser to do its own job (open a new tab, download)', () => {
    renderGallery()

    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      expect(fireEvent.click(tile(3), { [modifier]: true }), modifier).toBe(true)
      expect(dialog().open, modifier).toBe(false)
    }

    // The "has one" pair: a plain press opens it.
    expect(openAt(3)).toBe(false)
    expect(dialog().open).toBe(true)
  })

  it('in StrictMode it still calls showModal only once, and does not throw', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    renderGallery(SIX, { strict: true })

    openAt(1)

    expect(dialog().open).toBe(true)
    expect(showModal).toHaveBeenCalledTimes(1)
  })
})

describe('GalleryLightbox: switching image', () => {
  it('the counter "n / N" sits in an aria-live region, with the spoken sentence "Photo n of N"', () => {
    renderGallery()
    openAt(2)

    const visible = box().getByText('2 / 6')
    const live = visible.closest('[aria-live]')
    expect(live).toHaveAttribute('aria-live', 'polite')
    // The eye sees "2 / 6", a screen reader hears the full sentence instead of "2 slash 6".
    expect(visible).toHaveAttribute('aria-hidden', 'true')
    expect(within(live as HTMLElement).getByText(msg('Site.gallery.dialogLabel', { index: '2', total: '6' }))).toHaveClass(
      'sr-only',
    )
  })

  it('→ and ← switch image, the counter and the dialog name follow', () => {
    renderGallery()
    openAt(2)

    pressKey('ArrowRight')
    expect(counterText()).toBe('3 / 6')
    expect(shownAlt()).toBe('Photo description number 3')
    expect(dialog()).toHaveAttribute('aria-label', msg('Site.gallery.dialogLabel', { index: '3', total: '6' }))

    pressKey('ArrowLeft')
    pressKey('ArrowLeft')
    expect(counterText()).toBe('1 / 6')
    expect(shownAlt()).toBe('Photo description number 1')
  })

  it('wraps around within the page: after the last image is the first, before the first is the last', () => {
    renderGallery()
    openAt(6)

    pressKey('ArrowRight')
    expect(counterText()).toBe('1 / 6')
    pressKey('ArrowLeft')
    expect(counterText()).toBe('6 / 6')
  })

  it('keys with Alt/Ctrl/⌘ are not swallowed: Alt+← is still the browser "back"', () => {
    renderGallery()
    openAt(2)

    pressKey('ArrowLeft', { altKey: true })
    pressKey('ArrowRight', { metaKey: true })
    expect(counterText()).toBe('2 / 6')
  })

  it('the "Previous photo" and "Next photo" buttons are 44px tall; from 640px they sit on either side of the image', () => {
    renderGallery()
    openAt(2)

    const next = box().getByRole('button', { name: msg('Site.gallery.next') })
    const previous = box().getByRole('button', { name: msg('Site.gallery.previous') })
    fireEvent.click(next)
    expect(counterText()).toBe('3 / 6')
    fireEvent.click(previous)
    fireEvent.click(previous)
    expect(counterText()).toBe('1 / 6')

    for (const button of [next, previous, box().getByRole('button', { name: msg('Site.gallery.close') })]) {
      expect(button.getAttribute('class')).toMatch(/(^|\s)h-11(\s|$)/)
      expect(button.getAttribute('class')).toMatch(/(^|\s)w-11(\s|$)/)
    }
    // Below 640px: the bottom bar (row 3). From 640px: the same row as the image.
    expect(previous).toHaveClass('row-start-3', 'sm:row-start-2', 'col-start-1')
    // The focus ring is drawn inside the button: all three buttons sit against the edge of the overflow-hidden dialog, a ring pushed
    // outside (outline-offset-2) would be mostly cut off.
    for (const button of [next, previous, box().getByRole('button', { name: msg('Site.gallery.close') })]) {
      expect(button).toHaveClass('focus-visible:outline-2', 'focus-visible:-outline-offset-2', 'focus-visible:outline-brand')
      expect(button).not.toHaveClass('focus-visible:outline-offset-2')
    }
    expect(next).toHaveClass('row-start-3', 'sm:row-start-2', 'col-start-3')
  })

  it('a horizontal finger swipe (|dx| ≥ 48 and |dx| > |dy|) switches image; a short swipe or a vertical swipe does not', () => {
    renderGallery()
    openAt(2)
    const img = box().getByRole('img')

    swipe(img, [300, 200], [220, 210])
    expect(counterText()).toBe('3 / 6')

    swipe(box().getByRole('img'), [100, 200], [180, 190])
    expect(counterText()).toBe('2 / 6')

    // 30px: not past the threshold.
    swipe(box().getByRole('img'), [300, 200], [270, 200])
    // More vertical than horizontal: that is scrolling, not flipping the image.
    swipe(box().getByRole('img'), [300, 100], [240, 200])
    expect(counterText()).toBe('2 / 6')
  })

  it('dragging the mouse does not flip the image: swiping is a touch gesture, dragging the mouse selects the caption text', () => {
    renderGallery()
    openAt(2)

    swipe(box().getByRole('img'), [300, 200], [100, 200], 'mouse')
    expect(counterText()).toBe('2 / 6')
  })

  it('one image has no previous/next buttons and the arrow keys do nothing', () => {
    const one = [photo(1)]
    renderGallery(one)
    openAt(1)

    expect(counterText()).toBe('1 / 1')
    expect(box().queryByRole('button', { name: msg('Site.gallery.next') })).not.toBeInTheDocument()
    expect(box().queryByRole('button', { name: msg('Site.gallery.previous') })).not.toBeInTheDocument()
    pressKey('ArrowRight')
    expect(counterText()).toBe('1 / 1')
    // The "has one" pair: the Close button is still there.
    expect(box().getByRole('button', { name: msg('Site.gallery.close') })).toBeInTheDocument()
  })
})

describe('GalleryLightbox: caption', () => {
  it('figcaption = caption · shooting date, the date in <time> as yyyy-MM-dd', () => {
    const photos = [photo(1, { caption: 'Boats at early dawn', takenOn: '2026-09-14' }), photo(2)]
    renderGallery(photos)
    openAt(1)

    const caption = dialog().querySelector('figcaption')!
    const date = formatDate('2026-09-14')!
    expect(date).toBeTruthy()
    expect(caption.textContent).toBe(`Boats at early dawn · ${date}`)
    expect(caption.querySelector('time')).toHaveAttribute('dateTime', '2026-09-14')
  })

  it('only a date has no · mark; nothing at all has no figcaption', () => {
    const photos = [photo(1, { takenOn: '2026-09-14' }), photo(2), photo(3, { caption: 'West Lake' })]
    renderGallery(photos)
    openAt(1)

    expect(dialog().querySelector('figcaption')?.textContent).toBe(formatDate('2026-09-14'))

    pressKey('ArrowRight')
    expect(dialog().querySelector('figure')).not.toBeNull()
    expect(dialog().querySelector('figcaption')).toBeNull()

    pressKey('ArrowRight')
    expect(dialog().querySelector('figcaption')?.textContent).toBe('West Lake')
  })
})

describe('GalleryLightbox: close', () => {
  it('Esc closes and returns focus to the exact cell that was opened, even after flipping to another image', () => {
    renderGallery()
    openAt(2)
    pressKey('ArrowRight')
    pressKey('ArrowRight')

    pressKey('Escape')

    expect(dialog().open).toBe(false)
    expect(dialog().childElementCount).toBe(0)
    expect(tile(2)).toHaveFocus()
  })

  it('the "Close" button closes and returns focus to the cell', () => {
    renderGallery()
    openAt(4)

    fireEvent.click(box().getByRole('button', { name: msg('Site.gallery.close') }))

    expect(dialog().open).toBe(false)
    expect(tile(4)).toHaveFocus()
  })

  it('pressing the backdrop (target is the <dialog> itself) closes; pressing the image does not', () => {
    renderGallery()
    openAt(3)

    const img = box().getByRole('img')
    fireEvent.pointerDown(img, { isPrimary: true, pointerType: 'mouse' })
    fireEvent.click(img)
    expect(dialog().open).toBe(true)

    fireEvent.pointerDown(dialog(), { isPrimary: true, pointerType: 'mouse' })
    fireEvent.click(dialog())
    expect(dialog().open).toBe(false)
    expect(tile(3)).toHaveFocus()
  })

  it('pressing down on the image and releasing outside on the backdrop does not close (that click has the dialog as its target)', () => {
    renderGallery()
    openAt(3)

    fireEvent.pointerDown(box().getByRole('img'), { isPrimary: true, pointerType: 'mouse' })
    fireEvent.click(dialog())

    expect(dialog().open).toBe(true)
  })

  it('a press following a swipe on the backdrop does not close the viewer', () => {
    renderGallery()
    openAt(3)

    swipe(dialog(), [300, 200], [200, 200])
    fireEvent.click(dialog())

    expect(dialog().open).toBe(true)
    expect(counterText()).toBe('4 / 6')

    // The "has one" pair: the next press on the backdrop closes.
    fireEvent.pointerDown(dialog(), { isPrimary: true, pointerType: 'touch' })
    fireEvent.click(dialog())
    expect(dialog().open).toBe(false)
  })

  it('reopening after closing: starts at the cell just pressed, showModal again', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    renderGallery()
    openAt(2)
    pressKey('Escape')

    openAt(5)

    expect(showModal).toHaveBeenCalledTimes(2)
    expect(counterText()).toBe('5 / 6')
    expect(box().getByRole('button', { name: msg('Site.gallery.close') })).toHaveFocus()
  })
})

describe('GalleryLightbox: appearance', () => {
  it('always a dark background whatever the theme, full screen below 640px, a centered panel ≤64rem from 640px', () => {
    renderGallery()
    openAt(1)

    const classes = (dialog().getAttribute('class') ?? '').split(/\s+/)
    expect(classes).toEqual(
      expect.arrayContaining([
        'bg-neutral-950',
        'text-neutral-100',
        'backdrop:bg-black/80',
        'h-dvh',
        'w-full',
        'max-h-none',
        'max-w-none',
        'm-0',
        'sm:m-auto',
        'sm:max-w-5xl',
      ]),
    )
    // "Always" dark: no dark: variant changes the background by theme.
    expect(classes.filter((c) => c.startsWith('dark:'))).toEqual([])
  })

  it('icons aria-hidden, no animation, no shadow', () => {
    renderGallery()
    openAt(1)

    const svgs = Array.from(dialog().querySelectorAll('svg'))
    expect(svgs.length).toBeGreaterThanOrEqual(3)
    for (const svg of svgs) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('focusable', 'false')
    }
    const allClasses = [dialog(), ...Array.from(dialog().querySelectorAll('*'))].flatMap((el) =>
      (el.getAttribute('class') ?? '').split(/\s+/),
    )
    expect(allClasses.filter((c) => /^(animate-|shadow|transition-all|bg-gradient)/.test(c))).toEqual([])
  })
})

describe('globals.css: page scroll lock while the viewer is open', () => {
  it('exactly one rule html:has(dialog[open]:modal) { overflow: hidden }, at the outermost level', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    // Only outermost-level rules: inside a @media it would lock scrolling only conditionally.
    const rules = Array.from(style.sheet!.cssRules).filter(
      (rule): rule is CSSStyleRule => 'selectorText' in rule && String(rule.selectorText).includes('dialog'),
    )
    style.remove()

    expect(rules).toHaveLength(1)
    expect(rules[0]!.selectorText).toBe('html:has(dialog[open]:modal)')
    expect(rules[0]!.style.overflow).toBe('hidden')
  })
})
