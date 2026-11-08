import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postUrl } from './ArticleJsonLd'
import { NativeShare } from './NativeShare'
import { msg } from '@/test/render-intl'

/**
 * The operating system's share button: present only when the browser has `navigator.share` — on a
 * phone it reaches Zalo, Messenger, places the three fixed links do not reach.
 */

function stubShare(share: unknown) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true })
}

afterEach(() => {
  // jsdom has no navigator.share; delete it so later tests see exactly that state.
  delete (navigator as { share?: unknown }).share
})

describe('NativeShare', () => {
  it('renders nothing when the browser has no navigator.share', () => {
    expect('share' in navigator).toBe(false)

    const { container } = render(<NativeShare slug="setting-the-scene" title="Post" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('with navigator.share: one button calls share with the title and the canonical URL', () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubShare(share)

    render(<NativeShare slug="setting-the-scene" title="Setting the scene" />)
    // "send via…", not "share…": the button sits right after ShareBar's share label.
    const button = screen.getByRole('button', { name: msg('Site.share.sendVia') })
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    // Below 640px icon only, a 44px cell like the three brand cells; text shows from 640px, 32px tall like the whole row.
    expect(within(button).getByText(msg('Site.share.sendVia'))).toHaveClass('sr-only', 'sm:not-sr-only')
    expect(button).toHaveClass('h-11', 'w-11', 'sm:h-8', 'sm:w-auto')
    fireEvent.click(button)

    expect(share).toHaveBeenCalledTimes(1)
    expect(share).toHaveBeenCalledWith({ title: 'Setting the scene', url: postUrl('setting-the-scene') })
  })

  it('shares the URL of the post in its own language', () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubShare(share)

    render(<NativeShare slug="setting-the-scene" title="Post" language="en" />)
    fireEvent.click(screen.getByRole('button', { name: msg('Site.share.sendVia') }))

    expect(share).toHaveBeenCalledWith({ title: 'Post', url: postUrl('setting-the-scene', 'en') })
    expect(postUrl('setting-the-scene', 'en')).toContain('/en/posts/')
  })

  it('a reader closing the share sheet (AbortError) does not become an uncaught error', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('Share canceled', 'AbortError'))
    stubShare(share)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      render(<NativeShare slug="setting-the-scene" title="Post" />)
      fireEvent.click(screen.getByRole('button', { name: msg('Site.share.sendVia') }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', unhandled)
    }

    expect(share).toHaveBeenCalledTimes(1)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
