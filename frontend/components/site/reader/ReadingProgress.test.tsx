import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { msg, renderWithIntl } from '@/test/render-intl'
import { ReadingProgress } from './ReadingProgress'

/*
 * The formula is in lib/reading-progress.test.ts. Here it is the island: the body found through [data-post-body], the
 * scroll listener throttled by requestAnimationFrame, the writes through refs, the cleanup. jsdom has no layout, so
 * getBoundingClientRect is mocked.
 */

let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1
const cancelFrame = vi.fn((id: number) => {
  frames.delete(id)
})

function flushFrames() {
  act(() => {
    const pending = [...frames.values()]
    frames = new Map()
    for (const callback of pending) callback(0)
  })
}

function rectAt(top: number, height: number) {
  return () => ({ top, height, bottom: top + height }) as DOMRect
}

/** A 3000px body whose top is at `top`, in an 800px viewport. */
function addBody(top: number, height = 3000) {
  const body = document.createElement('div')
  body.setAttribute('data-post-body', '')
  body.getBoundingClientRect = rectAt(top, height)
  document.body.append(body)
  return body
}

function scrollTo(body: HTMLElement, top: number, height = 3000) {
  body.getBoundingClientRect = rectAt(top, height)
  act(() => {
    window.dispatchEvent(new Event('scroll'))
  })
  flushFrames()
}

const bar = (container: HTMLElement) => container.firstElementChild as HTMLElement
const fill = (container: HTMLElement) => container.querySelector<HTMLElement>('.h-full')!
const value = (container: HTMLElement) => container.querySelector('[data-progress-value]')!

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  cancelFrame.mockClear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  vi.stubGlobal('innerHeight', 800)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.querySelectorAll('[data-post-body]').forEach((node) => node.remove())
})

describe('ReadingProgress', () => {
  it('renders the fixed bar and the labelled meter at 0, both hidden from assistive technology, with nothing live', () => {
    const { container } = renderWithIntl(<ReadingProgress />)

    const topBar = bar(container)
    expect(topBar).toHaveAttribute('aria-hidden', 'true')
    expect(topBar).toHaveClass(
      'fixed',
      'inset-x-0',
      'top-0',
      'z-50',
      'h-0.5',
      'origin-left',
      'bg-brand',
      'rail:hidden',
      'print:hidden',
    )
    expect(topBar.style.transform).toBe('scaleX(0)')

    const meter = topBar.nextElementSibling!
    expect(meter).toHaveAttribute('aria-hidden', 'true')
    expect(meter).toHaveClass('hidden', 'shrink-0', 'rail:block')
    expect(meter).toHaveTextContent(msg('Site.reader.progressLabel'))
    expect(value(container)).toHaveTextContent('0%')
    expect(container.querySelector('[aria-live], [role=status], [role=progressbar], [role=meter]')).toBeNull()
    // No transition: the bar follows the scroll directly.
    expect(container.innerHTML).not.toMatch(/transition/)
  })

  it('moves the bar, the meter fill and the percentage with the scroll, without act warnings or state updates', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = addBody(0)
    const { container } = renderWithIntl(<ReadingProgress />)
    flushFrames()
    expect(bar(container).style.transform).toBe('scaleX(0)')
    expect(value(container)).toHaveTextContent('0%')

    // 3000px body, 800px viewport: 2200px scrollable, 1100px scrolled is half way.
    scrollTo(body, -1100)
    expect(bar(container).style.transform).toBe('scaleX(0.5)')
    expect(fill(container).style.transform).toBe('scaleX(0.5)')
    expect(value(container)).toHaveTextContent('50%')

    scrollTo(body, -2200)
    expect(bar(container).style.transform).toBe('scaleX(1)')
    expect(value(container)).toHaveTextContent('100%')

    scrollTo(body, -9000)
    expect(bar(container).style.transform).toBe('scaleX(1)')
    scrollTo(body, 100)
    expect(bar(container).style.transform).toBe('scaleX(0)')
    expect(value(container)).toHaveTextContent('0%')
    expect(errors).not.toHaveBeenCalled()
  })

  it('formats the percentage for the locale', () => {
    const body = addBody(0)
    const { container } = renderWithIntl(<ReadingProgress />, { locale: 'en' })
    flushFrames()
    scrollTo(body, -550)
    expect(value(container)).toHaveTextContent('25%')
  })

  it('throttles to one update per frame however many scroll events arrive', () => {
    const body = addBody(0)
    renderWithIntl(<ReadingProgress />)
    flushFrames()
    const spy = vi.spyOn(body, 'getBoundingClientRect')

    act(() => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('resize'))
    })
    expect(frames.size).toBe(1)
    flushFrames()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('registers one passive scroll and one resize listener, and removes both and cancels the pending frame on unmount', () => {
    addBody(0)
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderWithIntl(<ReadingProgress />)

    const scroll = add.mock.calls.filter(([type]) => type === 'scroll')
    const resize = add.mock.calls.filter(([type]) => type === 'resize')
    expect(scroll).toHaveLength(1)
    expect(scroll[0]![2]).toEqual({ passive: true })
    expect(resize).toHaveLength(1)

    // A frame is still pending from the first schedule.
    expect(frames.size).toBe(1)
    unmount()
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
    expect(remove.mock.calls.filter(([type]) => type === 'scroll')[0]![1]).toBe(scroll[0]![1])
    expect(remove.mock.calls.filter(([type]) => type === 'resize')[0]![1]).toBe(resize[0]![1])
  })

  it('does nothing without a post body: no listener, no frame, the bar stays at 0', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const { container } = renderWithIntl(<ReadingProgress />)

    expect(add.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize')).toHaveLength(0)
    expect(frames.size).toBe(0)
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(bar(container).style.transform).toBe('scaleX(0)')
  })

  it('renders under the default provider as well (the meter label comes from Site.reader)', () => {
    render(<ReadingProgress />)
    expect(screen.getByText(msg('Site.reader.progressLabel'), { exact: false })).toBeInTheDocument()
  })
})
