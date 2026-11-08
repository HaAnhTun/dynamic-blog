import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TABLE_SCROLL_CLASS, renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { msg } from '@/test/render-intl'

async function draw(markdown: string) {
  const { content } = await renderMarkdown(markdown)
  return render(<>{content}</>)
}

const TABLE = ['| Option | Cost |', '| --- | --- |', '| A | 1 |', '| B | 2 |'].join('\n')
const FULL = `:::comparison{title="Which plan fits" caption="Prices per month, in USD."}\n${TABLE}\n:::`

describe('comparison block', () => {
  it('is a titled panel around the table with the caption under it', async () => {
    const { container, getByRole, getByText } = await draw(FULL)

    const panel = container.querySelector('[data-block="comparison"]')!
    expect(panel).toHaveTextContent('Which plan fits')
    expect(panel).toHaveTextContent('Prices per month, in USD.')
    expect(getByRole('group', { name: 'Which plan fits' })).toBe(panel)
    expect(getByRole('table')).toBeInTheDocument()
    expect(getByRole('columnheader', { name: 'Option' })).toBeInTheDocument()
    expect(getByText('Prices per month, in USD.')).toBeInTheDocument()
  })

  it('keeps the horizontal scroll wrapper of the table with its accessible name, reachable by keyboard', async () => {
    const { container, getByRole } = await draw(FULL)

    const region = getByRole('region', { name: msg('Site.article.tableNamed', { label: 'Option, Cost' }) })
    expect(region).toHaveClass(TABLE_SCROLL_CLASS)
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.querySelector('table')).not.toBeNull()
    // The CSS of the wrapper belongs to `.prose .table-scroll`: the panel keeps a `.prose` around its content.
    expect(region.closest('.prose')).not.toBeNull()
    expect(container.querySelectorAll(`.${TABLE_SCROLL_CLASS}`)).toHaveLength(1)
  })

  it('works with no title and no caption, and then is not a named group', async () => {
    const { container, queryByRole } = await draw(`:::comparison\n${TABLE}\n:::`)

    expect(container.querySelector('[data-block="comparison"]')).not.toBeNull()
    expect(queryByRole('group')).toBeNull()
    expect(container.querySelector('[data-block="comparison"] > p')).toBeNull()
  })

  it('sets no pixel width, stays inside the body, leaves the typography to its content and has dark mode classes', async () => {
    const { container } = await draw(FULL)

    const panel = container.querySelector('[data-block="comparison"]')!
    expect(panel.className).toContain('not-prose')
    expect(panel.className).toContain('min-w-0')
    expect(panel.className).toContain('max-w-full')
    expect(panel.className).toMatch(/\bdark:/)
    expect(container.innerHTML).not.toMatch(/\b(?:w|min-w|max-w)-\[\d+px\]|(?:^|[\s;"])width:\s*\d+px/)
  })

  it('sets a wrapping rule on the title, the caption and the content', async () => {
    const { container, getByText } = await draw(FULL)

    expect(getByText('Which plan fits').className).toContain('[overflow-wrap:anywhere]')
    expect(getByText('Prices per month, in USD.').className).toContain('[overflow-wrap:anywhere]')
    expect(container.querySelector('[data-block="comparison"] .prose')!.className).toContain('[overflow-wrap:anywhere]')
  })

  it('is plain content when the body holds no table, and keeps its text', async () => {
    const { container, getByText } = await draw(':::comparison{title="Empty"}\nJust a sentence.\n:::')

    expect(container.querySelector('[data-block]')).toBeNull()
    expect(getByText('Just a sentence.')).toBeInTheDocument()
  })

  it('becomes its table with the title above and the caption below in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(FULL, 'https://example.com/p/a')

    expect(html.indexOf('<strong>Which plan fits</strong>')).toBeLessThan(html.indexOf('<table>'))
    expect(html.indexOf('</table>')).toBeLessThan(html.indexOf('<em>Prices per month, in USD.</em>'))
    expect(html).not.toContain('ai-block')
    expect(html).not.toContain(TABLE_SCROLL_CLASS)
  })
})
