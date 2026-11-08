import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeScrollCue } from './CodeScrollCue'

/** jsdom has no layout: a box is made to look `client` wide over `scroll` of content. */
function size(element: HTMLElement, client: number, scroll: number) {
  const left = { value: 0 }
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: client })
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(element, 'scrollLeft', { configurable: true, get: () => left.value })
  return left
}

describe('CodeScrollCue', () => {
  it('marks every code block of the body, follows the scroll and stops at the end', () => {
    const { container } = render(
      <div data-post-body="">
        <pre id="long">a very long line of code</pre>
        <pre id="short">x</pre>
        <CodeScrollCue />
      </div>,
    )
    const long = container.querySelector<HTMLElement>('#long')!
    const left = size(long, 300, 900)

    fireEvent.scroll(long)
    expect(long).toHaveAttribute('data-more', 'true')
    left.value = 600
    fireEvent.scroll(long)
    expect(long).toHaveAttribute('data-more', 'false')
    // A block that fits has nothing to scroll to.
    expect(container.querySelector('#short')).toHaveAttribute('data-more', 'false')
  })

  it('leaves a code block outside the body alone (the admin editor, a comment)', () => {
    const { container } = render(
      <div>
        <pre id="outside">code</pre>
        <CodeScrollCue />
      </div>,
    )

    expect(container.querySelector('#outside')).not.toHaveAttribute('data-more')
  })

  it('stops watching when it unmounts', () => {
    const { container, unmount } = render(
      <div data-post-body="">
        <pre id="long">code</pre>
        <CodeScrollCue />
      </div>,
    )
    const long = container.querySelector<HTMLElement>('#long')!
    size(long, 300, 900)
    unmount()
    long.removeAttribute('data-more')

    fireEvent.scroll(long)
    expect(long).not.toHaveAttribute('data-more')
  })

  it('draws nothing', () => {
    const { container } = render(<CodeScrollCue />)
    expect(container).toBeEmptyDOMElement()
  })
})
