import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRailAnchor } from './use-rail-anchor'

function Block({ sticky = true }: { sticky?: boolean }) {
  useRailAnchor('luot-thich')
  return (
    <aside data-testid="aside">
      <div data-rail-sticky="" style={{ position: sticky ? 'sticky' : 'static' }}>
        <div id="luot-thich">like</div>
      </div>
    </aside>
  )
}

const frames: FrameRequestCallback[] = []
const scrollIntoView = vi.fn()

function flushFrames() {
  while (frames.length > 0) frames.shift()!(0)
}

beforeEach(() => {
  frames.length = 0
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('useRailAnchor', () => {
  it('scrolls the aside (not the sticky block) to the top when the page opens on its fragment', () => {
    window.history.replaceState(null, '', '/posts/x#luot-thich')
    const { getByTestId } = render(<Block />)

    flushFrames()

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(getByTestId('aside'))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' })
  })

  it('does nothing for another fragment or none', () => {
    window.history.replaceState(null, '', '/posts/x#binh-luan')
    render(<Block />)
    flushFrames()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('does nothing when the rail is not sticky (below the rail breakpoint the browser scroll is right)', () => {
    window.history.replaceState(null, '', '/posts/x#luot-thich')
    render(<Block sticky={false} />)
    flushFrames()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
