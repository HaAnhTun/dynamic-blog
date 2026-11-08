import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { msg } from '@/test/render-intl'

const TYPES = ['info', 'note', 'tip', 'warning', 'danger'] as const

async function draw(markdown: string) {
  const { content } = await renderMarkdown(markdown)
  return render(<>{content}</>)
}

describe('callout block', () => {
  it('is a note with its content, and an info callout when no type is given', async () => {
    const { container, getByRole } = await draw(':::callout\nKeep **this** in mind.\n:::')

    const note = getByRole('note')
    expect(note).toHaveAttribute('data-block', 'callout')
    expect(note).toHaveTextContent('Keep this in mind.')
    expect(note.querySelector('strong')).toHaveTextContent('this')
    expect(note).toHaveTextContent(msg('Site.blocks.callout.types.info'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('says the kind in words for every type and draws a different icon for each', async () => {
    const icons = new Set<string>()
    const labels = new Set<string>()
    for (const type of TYPES) {
      const { getByRole, unmount } = await draw(`:::callout{type=${type}}\nText.\n:::`)
      const note = getByRole('note')
      const label = msg(`Site.blocks.callout.types.${type}`)

      expect(note, type).toHaveTextContent(label)
      expect(note.getAttribute('data-type'), type).toBe(type)
      const icon = note.querySelector('svg')!
      expect(icon, type).toHaveAttribute('aria-hidden', 'true')
      icons.add(icon.innerHTML)
      labels.add(label)
      unmount()
    }
    expect(icons.size).toBe(TYPES.length)
    expect(labels.size).toBe(TYPES.length)
  })

  it('shows the title next to the label, and the label alone without a title', async () => {
    const withTitle = await draw(':::callout{type=tip title="Before you start"}\nText.\n:::')
    expect(withTitle.getByRole('note')).toHaveTextContent('Before you start')
    expect(withTitle.getByText('Before you start')).toBeInTheDocument()
    withTitle.unmount()

    const without = await draw(':::callout{type=tip}\nText.\n:::')
    expect(without.getByRole('note').textContent).toBe(`${msg('Site.blocks.callout.types.tip')}Text.`)
  })

  it('has a compact and a prominent variant that differ in their classes', async () => {
    const compact = await draw(':::callout{type=warning}\nText.\n:::')
    const compactClass = compact.getByRole('note').className
    expect(compact.getByRole('note')).toHaveAttribute('data-variant', 'compact')
    compact.unmount()

    const prominent = await draw(':::callout{type=warning variant=prominent}\nText.\n:::')
    expect(prominent.getByRole('note')).toHaveAttribute('data-variant', 'prominent')
    expect(prominent.getByRole('note').className).not.toBe(compactClass)
  })

  it('is styled for dark mode, leaves the typography to its content and sets no fixed pixel width', async () => {
    for (const type of TYPES) {
      for (const variant of ['compact', 'prominent']) {
        const { container, getByRole, unmount } = await draw(`:::callout{type=${type} variant=${variant}}\nText.\n:::`)
        const note = getByRole('note')

        expect(note.className, `${type} ${variant}`).toMatch(/\bdark:/)
        expect(note.className).toContain('not-prose')
        expect(note.className).toContain('min-w-0')
        expect(note.className).toContain('max-w-full')
        expect(container.innerHTML).not.toMatch(/\b(?:w|min-w|max-w)-\[\d+px\]|width:\s*\d+px/)
        expect(note.querySelector('.prose')).not.toBeNull()
        unmount()
      }
    }
  })

  it('draws a callout with a type that does not exist as plain content', async () => {
    const { container, getByText } = await draw(':::callout{type=alert}\nStill here.\n:::')

    expect(container.querySelector('[data-block]')).toBeNull()
    expect(getByText('Still here.')).toBeInTheDocument()
  })

  it('sets a wrapping rule on the content and on the title, so a long unbroken word breaks inside the box', async () => {
    const title = 'titlesupercalifragilistic-'.repeat(4)
    const body = 'bodysupercalifragilistic-'.repeat(4)
    const { getByRole, getByText } = await draw(`:::callout{title="${title}"}\n${body}\n:::`)

    expect(getByRole('note').className).toMatch(/\bmin-w-0\b/)
    expect(getByRole('note').querySelector('.prose')!.className).toContain('[overflow-wrap:anywhere]')
    expect(getByText(title).className).toContain('[overflow-wrap:anywhere]')
  })

  it('becomes a blockquote with its title in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(
      ':::callout{type=tip title="Heads up"}\nRead this.\n:::',
      'https://example.com/posts/a',
    )

    expect(html).toContain('<blockquote>')
    expect(html).toContain('<strong>Heads up</strong>')
    expect(html).toContain('Read this.')
    expect(html).not.toContain('ai-block')
  })

  it('keeps the kind as text in the feed, so a danger callout and a tip read differently', async () => {
    const feed = (markdown: string) => renderMarkdownToFeedHtml(markdown, 'https://example.com/posts/a')

    const [tip, danger] = await Promise.all([
      feed(':::callout{type=tip}\nRead this.\n:::'),
      feed(':::callout{type=danger}\nRead this.\n:::'),
    ])

    expect(tip).toContain('<blockquote><p><strong>Tip</strong></p>')
    expect(danger).toContain('<blockquote><p><strong>Danger</strong></p>')
    expect(tip).not.toBe(danger)
    // The kind comes before the title, and the callout without a type is an info callout.
    const titled = await feed(':::callout{title="Heads up"}\nBody.\n:::')
    expect(titled.indexOf('Info')).toBeGreaterThan(-1)
    expect(titled.indexOf('Info')).toBeLessThan(titled.indexOf('Heads up'))
  })
})
