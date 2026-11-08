import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RailTipHost, TIP_DELAY_MS } from './RailTipHost'

const FULL = 'A very long title that does not fit in the sidebar'

type Box = { left: number; top: number; width: number; height: number }
const ROW_BOX: Box = { left: 24, top: 200, width: 220, height: 32 }

let boxes = new Map<Element, Box>()
let truncated = true
let tipHeight = 28
let focusVisible = true

function rectOf(box: Box): DOMRect {
  return {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect
}

function renderHost() {
  const result = render(
    <RailTipHost>
      <a href="/one" data-tip={FULL} data-testid="row">
        <span data-tip-text="" data-testid="text">
          {FULL.slice(0, 20)}
        </span>
      </a>
      <a href="/two" data-testid="plain">
        Plain
      </a>
      <a href="/three" data-tip="Fits" data-testid="short">
        <span data-tip-text="">Fits</span>
      </a>
    </RailTipHost>,
  )
  const row = screen.getByTestId('row')
  boxes.set(row, ROW_BOX)
  return { ...result, row, text: screen.getByTestId('text') }
}

const focusRow = (row: HTMLElement) => act(() => row.focus())
const tip = () => document.querySelector('[data-rail-tip]') as HTMLElement | null

function hover(el: Element, pointerType = 'mouse') {
  fireEvent.pointerOver(el, { pointerType })
}

beforeEach(() => {
  vi.useFakeTimers()
  boxes = new Map()
  truncated = true
  tipHeight = 28
  focusVisible = true
  // jsdom never matches :focus-visible after a programmatic focus(); the test decides.
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? focusVisible : matches.call(this, selector)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-rail-tip')) return rectOf({ left: 0, top: 0, width: 200, height: tipHeight })
    return rectOf(boxes.get(this) ?? { left: 0, top: 0, width: 0, height: 0 })
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-tip-text') && truncated ? 300 : 100
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 100)
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RailTipHost', () => {
  it('renders its children and no tooltip at rest', () => {
    const { row } = renderHost()
    expect(row).toBeInTheDocument()
    expect(tip()).toBeNull()
  })

  it('shows the tooltip after the hover delay, over the row, aligned to its start edge', () => {
    const { row } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS - 1)
    })
    expect(tip()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    const el = tip()!
    expect(el).not.toBeNull()
    expect(el.textContent).toBe(FULL)
    expect(el.style.left).toBe('24px')
    expect(el.style.top).toBe('200px')
    expect(el.style.minHeight).toBe('32px')
    expect(el.style.maxWidth).toBe('576px')
  })

  it('is a visual aid only: aria-hidden, no role, no pointer events, hidden on touch devices', () => {
    const { row } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    const el = tip()!
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.hasAttribute('role')).toBe(false)
    expect(el.className).toContain('pointer-events-none')
    expect(el.className).toContain('fixed')
    expect(el.className).toContain('[@media(hover:none)]:hidden')
    expect(row.hasAttribute('aria-describedby')).toBe(false)
  })

  it('caps the width to the room left in the window', () => {
    const { row } = renderHost()
    boxes.set(row, { ...ROW_BOX, left: 1000 })
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    expect(tip()!.style.maxWidth).toBe('264px')
  })

  it('shows nothing for a title that fits (no ellipsis)', () => {
    truncated = false
    const { row } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS * 2)
    })
    expect(tip()).toBeNull()
  })

  it('shows nothing for an element without data-tip and for a short row', () => {
    renderHost()
    hover(screen.getByTestId('plain'))
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS * 2)
    })
    expect(tip()).toBeNull()
  })

  it('never opens for a touch pointer', () => {
    const { row } = renderHost()
    hover(row, 'touch')
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS * 2)
    })
    expect(tip()).toBeNull()
  })

  it('opens for a pen like a mouse', () => {
    const { row } = renderHost()
    hover(row, 'pen')
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    expect(tip()).not.toBeNull()
  })

  it('leaving the row before the delay cancels it, leaving after the delay closes it at once', () => {
    const { row } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.pointerOut(row, { relatedTarget: document.body })
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS * 2)
    })
    expect(tip()).toBeNull()

    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    expect(tip()).not.toBeNull()
    fireEvent.pointerOut(row, { relatedTarget: document.body })
    expect(tip()).toBeNull()
  })

  it('moving between the children of one row keeps the tooltip', () => {
    const { row, text } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    fireEvent.pointerOut(row, { relatedTarget: text })
    expect(tip()).not.toBeNull()
  })

  it('moving to another row replaces the tooltip', () => {
    const { row } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    const other = screen.getByTestId('short')
    boxes.set(other, { left: 24, top: 240, width: 220, height: 32 })
    fireEvent.pointerOut(row, { relatedTarget: other })
    hover(other)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    expect(tip()!.textContent).toBe('Fits')
  })

  it('Escape closes it, scroll, resize and a pointer press too', () => {
    const { row } = renderHost()
    const open = () => {
      hover(row)
      act(() => {
        vi.advanceTimersByTime(TIP_DELAY_MS)
      })
      expect(tip()).not.toBeNull()
    }

    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(tip()).toBeNull()

    fireEvent.pointerOut(row, { relatedTarget: document.body })
    open()
    fireEvent.scroll(document.body)
    expect(tip()).toBeNull()

    fireEvent.pointerOut(row, { relatedTarget: document.body })
    open()
    fireEvent(window, new Event('resize'))
    expect(tip()).toBeNull()

    fireEvent.pointerOut(row, { relatedTarget: document.body })
    open()
    fireEvent.pointerDown(document.body)
    expect(tip()).toBeNull()
  })

  it('does not swallow Escape when no tooltip is open', () => {
    renderHost()
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('keyboard focus shows it at once, BELOW the row, never over it', () => {
    const { row } = renderHost()
    focusRow(row)
    const el = tip()!
    expect(el).not.toBeNull()
    expect(el.textContent).toBe(FULL)
    // rect.bottom (232) + 4px
    expect(el.style.top).toBe('236px')
    expect(el.style.left).toBe('24px')
    expect(el.style.minHeight).toBe('')
  })

  it('keyboard focus near the bottom of the window flips the tooltip ABOVE the row', () => {
    const { row } = renderHost()
    boxes.set(row, { ...ROW_BOX, top: 780, height: 16 })
    focusRow(row)
    const el = tip()!
    expect(el.style.top).toBe('auto')
    // innerHeight (800) - rect.top (780) + 4
    expect(el.style.bottom).toBe('24px')
  })

  it('a focus tooltip follows its row when focus scrolls the row into view, and goes when the row leaves the window', () => {
    const { row } = renderHost()
    boxes.set(row, { ...ROW_BOX, top: 900, height: 16 })
    focusRow(row)
    // The browser scrolled the row into view after the tooltip opened.
    boxes.set(row, { ...ROW_BOX, top: 300, height: 16 })
    fireEvent.scroll(document.body)
    expect(tip()).not.toBeNull()
    expect(tip()!.style.top).toBe('320px')
    expect(tip()!.style.bottom).toBe('')

    boxes.set(row, { ...ROW_BOX, top: -200, height: 16 })
    fireEvent.scroll(document.body)
    expect(tip()).toBeNull()
  })

  it('blur closes a focus tooltip, and so does Escape', () => {
    const { row } = renderHost()
    focusRow(row)
    expect(tip()).not.toBeNull()
    act(() => row.blur())
    expect(tip()).toBeNull()

    focusRow(row)
    expect(tip()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(tip()).toBeNull()
  })

  it('a focus tooltip stays when the pointer passes over and out of the row', () => {
    const { row } = renderHost()
    focusRow(row)
    fireEvent.pointerOut(row, { relatedTarget: document.body })
    expect(tip()).not.toBeNull()
  })

  it('shows nothing on focus when the title fits', () => {
    truncated = false
    const { row } = renderHost()
    focusRow(row)
    expect(tip()).toBeNull()
  })

  it('ignores focus that is not keyboard focus (a mouse click)', () => {
    focusVisible = false
    const { row } = renderHost()
    focusRow(row)
    expect(tip()).toBeNull()
  })

  it('reads the document direction: in RTL the inline-start edge is the row right edge', () => {
    const { row } = renderHost()
    const direction = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ direction: 'rtl' } as CSSStyleDeclaration)
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    direction.mockRestore()
    const el = tip()!
    // innerWidth 1280 - row.right 244
    expect(el.style.insetInlineStart).toBe('1036px')
    expect(el.style.left).toBe('')
  })

  it('removes its listeners and timers on unmount', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const { row, unmount } = renderHost()
    hover(row)
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS)
    })
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function))
    unmount()
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(tip()).toBeNull()

    // A pending hover timer is cleared too: nothing fires after unmount.
    const second = renderHost()
    hover(second.row)
    second.unmount()
    expect(() => vi.advanceTimersByTime(TIP_DELAY_MS * 2)).not.toThrow()
    expect(tip()).toBeNull()
  })
})
