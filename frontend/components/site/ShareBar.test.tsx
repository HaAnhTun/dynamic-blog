import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareBar } from './ShareBar'
import { msg } from '@/test/render-intl'
import { DIACRITIC_SLUG } from '@/test/fixtures/vi/slug-diacritics'

/**
 * The share row at the end of a post: Facebook, LinkedIn, X are links opening a new tab, the URL built from
 * `postUrl(slug)` — exactly the canonical string, not the address bar. No copy button: Copy link lives in the hero.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

const CANONICAL = 'https://example.com/posts/setting-the-scene'

describe('ShareBar', () => {
  it('three share links built from the canonical URL, opening a new tab with rel noopener noreferrer', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    render(<ShareBar slug="setting-the-scene" title="Setting the scene & how to measure" />)

    const url = encodeURIComponent(CANONICAL)
    const expected: [string, string][] = [
      [msg('Site.share.shareOn', { target: 'Facebook' }), `https://www.facebook.com/sharer/sharer.php?u=${url}`],
      [msg('Site.share.shareOn', { target: 'LinkedIn' }), `https://www.linkedin.com/sharing/share-offsite/?url=${url}`],
      [
        msg('Site.share.shareOn', { target: 'X' }),
        `https://x.com/intent/post?url=${url}&text=${encodeURIComponent('Setting the scene & how to measure')}`,
      ],
    ]

    const list = screen.getByRole('list', { name: msg('Site.share.label') })
    const links = within(list).getAllByRole('link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual(expected)
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      // The brand mark is a decorative shape: the link name comes from the sr-only text.
      const icon = link.querySelector('svg')
      expect(icon).toHaveAttribute('aria-hidden', 'true')
      expect(link.querySelector('.sr-only')?.textContent).toBe(link.textContent)
    }
  })

  it('shares the canonical URL of an English post: its own language prefix', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    render(<ShareBar slug="setting-the-scene" title="Post" language="en" />)

    const facebook = screen.getByRole('link', { name: msg('Site.share.shareOn', { target: 'Facebook' }) })
    expect(new URL(facebook.getAttribute('href')!).searchParams.get('u')).toBe('https://example.com/en/posts/setting-the-scene')
  })

  it('encodes the URL exactly once, including a slug with diacritics', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com')
    render(<ShareBar slug={DIACRITIC_SLUG} title="Post" />)

    const href = screen.getByRole('link', { name: msg('Site.share.shareOn', { target: 'Facebook' }) }).getAttribute('href') ?? ''
    // Decoding once gives exactly the canonical URL (the slug percent-encoded as postPath() does).
    expect(new URL(href).searchParams.get('u')).toBe(`https://example.com/posts/${encodeURIComponent(DIACRITIC_SLUG)}`)
  })

  it('has the "Share" label (id chia-se) beside one row of icon cells (above it from rail), and no Copy link button', () => {
    const { container } = render(<ShareBar slug="setting-the-scene" title="Post" />)

    const label = screen.getByText(msg('Site.share.label'))
    expect(label).toHaveAttribute('id', 'chia-se')
    expect(label).not.toHaveClass('sr-only')
    const root = container.firstElementChild!
    // One line below rail (the toolbar under the article); the label above the icons in the column of the rail.
    expect(root).toHaveClass('flex', 'items-center', 'rail:flex-col', 'rail:items-start')
    expect(root).not.toHaveClass('flex-col')
    expect(root.firstElementChild).toBe(label)
    const row = root.lastElementChild!
    expect(row).toHaveClass('flex', 'flex-wrap', 'gap-2')
    expect(row).toContainElement(screen.getByRole('list', { name: msg('Site.share.label') }))
    expect(screen.queryByRole('button', { name: msg('Site.share.copyLink') })).not.toBeInTheDocument()
    expect(screen.queryByText(msg('Site.share.copyLink'))).not.toBeInTheDocument()
  })

  it('cells are 44px below the rail breakpoint and on a coarse pointer, 32px from rail on a fine pointer', () => {
    render(<ShareBar slug="setting-the-scene" title="Post" />)

    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveClass('h-11', 'w-11', 'rail:pointer-fine:h-8', 'rail:pointer-fine:w-8')
      expect(link).not.toHaveClass('sm:h-8')
    }
  })

  it('does not print: the whole bar cannot be clicked on paper', () => {
    const { container } = render(<ShareBar slug="setting-the-scene" title="Post" />)

    expect(container.firstElementChild).toHaveClass('print:hidden')
  })

  it('has no outer margin or border of its own: the actions toolbar owns the rhythm', () => {
    const { container } = render(<ShareBar slug="setting-the-scene" title="Post" />)

    const root = container.firstElementChild!
    expect(root.className).not.toMatch(/(?:^|\s)(?:mt-|mb-|my-|border-t|border-b|border(?=\s|$)|pt-)/)
  })

  it('one list named Site.share.label with the three networks, one #chia-se', () => {
    const { container } = render(<ShareBar slug="setting-the-scene" title="Post" />)

    expect(container.querySelectorAll('ul[aria-labelledby="chia-se"]')).toHaveLength(1)
    expect(container.querySelectorAll('#chia-se')).toHaveLength(1)
    const list = screen.getByRole('list', { name: msg('Site.share.label') })
    expect(within(list).getAllByRole('link')).toHaveLength(3)
    expect(screen.getAllByRole('list')).toHaveLength(1)
  })

  it('the operating system share button sits in the same row after the networks when the browser has one', async () => {
    vi.stubGlobal('navigator', { ...navigator, share: vi.fn() })
    const { container } = render(<ShareBar slug="setting-the-scene" title="Post" />)

    const row = container.firstElementChild!.lastElementChild!
    const send = await screen.findByRole('button', { name: new RegExp(msg('Site.share.sendVia')) })
    expect(row).toContainElement(send)
    expect(row.firstElementChild).toBe(screen.getByRole('list', { name: msg('Site.share.label') }))
    vi.unstubAllGlobals()
  })
})
