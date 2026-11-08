import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SITE_HEADER_VAR } from '@/lib/scroll-ui'
import { SITE_HEADER_VISIBLE_VAR, useStickyHeader } from './useStickyHeader'

/**
 * The hook writes two variables on <html>: `--site-header-h` (the measured height, always) and `--site-header-visible-h` (the height while the
 * header is shown, `0px` while it is hidden by the scroll), which the sticky sidebar and right column of the post page start under.
 * The sliding behavior itself is tested through the real Header (Header.test.tsx); this file pins the new variable.
 */

function Probe() {
  const ref = useRef<HTMLElement>(null)
  const { hidden } = useStickyHeader(ref)
  return (
    <header ref={ref} data-hidden={hidden ? 'true' : 'false'}>
      Header
    </header>
  )
}

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let headerHeight: number
let resizeCallback: (() => void) | null

const root = () => document.documentElement
const visible = () => root().style.getPropertyValue(SITE_HEADER_VISIBLE_VAR)
const measured = () => root().style.getPropertyValue(SITE_HEADER_VAR)

function flushFrames() {
  act(() => {
    const pending = Array.from(frames.entries())
    frames.clear()
    for (const [, callback] of pending) callback(0)
  })
}

function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true })
  act(() => {
    window.dispatchEvent(new Event('scroll'))
  })
  flushFrames()
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  headerHeight = 64
  resizeCallback = null
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
  // jsdom builds no layout: give the page a height so there is room to scroll.
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 10_000, configurable: true })
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (document.documentElement as { scrollHeight?: number }).scrollHeight
  root().style.removeProperty(SITE_HEADER_VAR)
  root().style.removeProperty(SITE_HEADER_VISIBLE_VAR)
})

describe('useStickyHeader: --site-header-visible-h', () => {
  it('is the variable name the stylesheet declares', () => {
    expect(SITE_HEADER_VISIBLE_VAR).toBe('--site-header-visible-h')
  })

  it('is the measured height while the header is shown, from the first render', () => {
    render(<Probe />)

    expect(measured()).toBe('64px')
    expect(visible()).toBe('64px')
  })

  it('goes to 0px when the header hides on scroll down and returns to the height when it shows on scroll up; --site-header-h stays', () => {
    render(<Probe />)
    flushFrames()
    flushFrames()

    scrollTo(800)
    expect(document.querySelector('header')!.getAttribute('data-hidden')).toBe('true')
    expect(visible()).toBe('0px')
    expect(measured(), 'the measured height does not change while hidden').toBe('64px')

    scrollTo(700)
    expect(document.querySelector('header')!.getAttribute('data-hidden')).toBe('false')
    expect(visible()).toBe('64px')
    expect(measured()).toBe('64px')
  })

  it('a resize while the header is hidden keeps 0px; a resize while shown follows the new height', () => {
    render(<Probe />)
    flushFrames()
    flushFrames()

    headerHeight = 97
    act(() => resizeCallback!())
    expect(visible()).toBe('97px')
    expect(measured()).toBe('97px')

    scrollTo(900)
    expect(visible()).toBe('0px')

    headerHeight = 80
    act(() => resizeCallback!())
    expect(visible()).toBe('0px')
    expect(measured()).toBe('80px')
  })

  it('unmount removes both variables from <html>', () => {
    const { unmount } = render(<Probe />)
    expect(visible()).toBe('64px')

    unmount()

    expect(visible()).toBe('')
    expect(measured()).toBe('')
  })
})
