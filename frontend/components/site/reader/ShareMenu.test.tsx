import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { msg } from '@/test/render-intl'
import { ShareBar } from '../ShareBar'
import { ShareMenu } from './ShareMenu'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const TITLE = 'Setting the scene & how to measure'

function renderMenu() {
  const view = render(
    <div>
      <button type="button">outside</button>
      <ShareMenu slug="setting-the-scene" title={TITLE} />
    </div>,
  )
  const details = view.container.querySelector('details')!
  const summary = details.querySelector('summary')!
  return { ...view, details, summary }
}

/** Open the disclosure the way a reader does and wait for the native `toggle` event that tells the component. */
async function openMenu(details: HTMLDetailsElement, summary: HTMLElement) {
  fireEvent.click(summary)
  await waitFor(() => expect(details.open).toBe(true))
  // Let the toggle event land in the component's state, so its listeners are attached.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ShareMenu', () => {
  it('the summary is a hero button named Share (an icon-only 44px square below sm), with decorative icons', () => {
    const { summary } = renderMenu()

    expect(summary).toHaveTextContent(msg('Site.share.label'))
    expect(summary).toHaveClass('h-11', 'sm:h-10', 'rounded-lg', 'border', 'max-sm:w-11', 'max-sm:px-0')
    expect(within(summary).getByText(msg('Site.share.label'))).toHaveClass('max-sm:sr-only')
    for (const svg of summary.querySelectorAll('svg')) expect(svg).toHaveAttribute('aria-hidden', 'true')
  })

  it('is closed at first', () => {
    const { details } = renderMenu()

    expect(details.open).toBe(false)
  })

  it('links to the same three URLs as the share row of the right column, in the same order', () => {
    const bar = render(<ShareBar slug="setting-the-scene" title={TITLE} />)
    const barLinks = within(bar.getByRole('list', { name: msg('Site.share.label') })).getAllByRole('link')
    const expected = barLinks.map((a) => [a.textContent, a.getAttribute('href')])
    bar.unmount()

    const { details } = renderMenu()
    const links = Array.from(details.querySelectorAll('a'))

    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual(expected)
    expect(links).toHaveLength(3)
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('uses the canonical URL of the post in the language it is given', () => {
    const { container } = render(<ShareMenu slug="dat-van-de" title="T" language="en" />)

    const href = container.querySelector('a')!.getAttribute('href')!
    expect(href).toContain(encodeURIComponent('https://example.com/en/posts/dat-van-de'))
  })

  it('the list has no accessible name, so the page keeps exactly one list named Share', () => {
    const { details } = renderMenu()
    details.open = true

    const list = details.querySelector('ul')!
    expect(list).not.toHaveAttribute('aria-label')
    expect(list).not.toHaveAttribute('aria-labelledby')
    expect(screen.queryByRole('list', { name: msg('Site.share.label') })).toBeNull()
    expect(details.querySelector('[id="chia-se"]')).toBeNull()
  })

  it('the panel is absolute, so opening it never moves the layout', () => {
    const { details } = renderMenu()
    const panel = details.querySelector('ul')!.parentElement!

    // Opens from the start edge below sm (the button is an icon in the middle of a row, a panel hung from its end would leave the window).
    expect(panel).toHaveClass('absolute', 'start-0', 'sm:start-auto', 'sm:end-0', 'top-full', 'z-30')
  })

  it('opens from the summary', async () => {
    const { details, summary } = renderMenu()

    await openMenu(details, summary)

    expect(details.open).toBe(true)
  })

  it('closes on Escape and returns focus to the summary', async () => {
    const { details, summary } = renderMenu()
    await openMenu(details, summary)
    const link = details.querySelector('a')!
    link.focus()

    fireEvent.keyDown(link, { key: 'Escape' })

    expect(details.open).toBe(false)
    expect(summary).toHaveFocus()
  })

  it('closes when focus moves out of the panel and leaves the focus where it went (no focus theft)', async () => {
    const { details, summary } = renderMenu()
    await openMenu(details, summary)
    details.querySelector('a')!.focus()
    const outside = screen.getByRole('button', { name: 'outside' })

    outside.focus()
    await waitFor(() => expect(details.open).toBe(false))
    fireEvent.keyDown(outside, { key: 'Escape' })

    expect(outside).toHaveFocus()
  })

  it('closes on a pointer press outside, and not on one inside', async () => {
    const { details, summary } = renderMenu()
    await openMenu(details, summary)

    fireEvent.pointerDown(details.querySelector('a')!)
    expect(details.open).toBe(true)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
    expect(details.open).toBe(false)
  })

  it('closes when a link is activated', async () => {
    const { details, summary } = renderMenu()
    await openMenu(details, summary)
    const link = details.querySelector('a')!
    // The new tab is not opened in jsdom; keep the click from navigating.
    link.addEventListener('click', (event) => event.preventDefault())

    fireEvent.click(link)

    expect(details.open).toBe(false)
  })

  it('stops listening once closed: Escape elsewhere does nothing to the focus', async () => {
    const { details, summary } = renderMenu()
    await openMenu(details, summary)
    fireEvent.click(summary)
    await waitFor(() => expect(details.open).toBe(false))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const outside = screen.getByRole('button', { name: 'outside' })
    outside.focus()

    fireEvent.keyDown(outside, { key: 'Escape' })

    expect(outside).toHaveFocus()
  })
})

describe('ShareMenu: alignEnd', () => {
  it('opens its panel towards the left at every width when the button sits at the end of its row', () => {
    const { container } = render(<ShareMenu slug="x" title="T" alignEnd />)

    const panel = container.querySelector('details > div')!
    expect(panel).toHaveClass('end-0')
    expect(panel).not.toHaveClass('start-0')
  })
})
