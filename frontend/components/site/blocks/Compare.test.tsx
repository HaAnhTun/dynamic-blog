import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'

async function draw(markdown: string) {
  const { content } = await renderMarkdown(markdown)
  return render(<>{content}</>)
}

const TWO = [
  '::::compare',
  ':::pane{title="Option A"}',
  'Fast to start.',
  '',
  '```bash',
  'make run',
  '```',
  ':::',
  ':::pane{title="Option B"}',
  'Cheap to keep.',
  '',
  '![A sketch of option B](/media/b.png#20x10)',
  ':::',
  '::::',
].join('\n')

/** The same block with one more pane before its closing fence. */
const withThirdPane = (source: string) =>
  `${source.slice(0, source.lastIndexOf('::::'))}:::pane{title="Option C"}\nSafe.\n:::\n::::`

const THREE = withThirdPane(TWO)

describe('compare block and its panes', () => {
  it('draws one labelled group per pane, in order, named by the title and holding its text, code and images', async () => {
    const { getAllByRole, container } = await draw(TWO)

    const groups = getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-labelledby'))).not.toContain(null)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveAccessibleName('Option A')
    expect(groups[1]).toHaveAccessibleName('Option B')
    expect(groups[0]).toHaveTextContent('Fast to start.')
    expect(groups[0]!.querySelector('pre')).not.toBeNull()
    expect(groups[1]!.querySelector('img')).toHaveAttribute('alt', 'A sketch of option B')
    expect(container.querySelector('[data-block="compare"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-block="pane"]')).toHaveLength(2)
  })

  it('gives every pane its own label id, so two compare blocks in one article do not mix their names', async () => {
    const { container } = await draw(`${TWO}\n\n${TWO}`)

    const ids = [...container.querySelectorAll('[data-block="pane"]')].map((pane) => pane.getAttribute('aria-labelledby'))
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) expect(container.querySelector(`[id="${id}"]`)).not.toBeNull()
  })

  it('puts the panes side by side from a container width and stacks them below it, whatever the window', async () => {
    const two = await draw(TWO)
    const grid2 = two.container.querySelector('[data-block="compare"] > div')!.className
    const root = two.container.querySelector('[data-block="compare"]')!
    expect(root.className).toContain('@container')
    expect(grid2).toMatch(/grid-cols-1/)
    expect(grid2).toMatch(/@xl:grid-cols-2/)
    two.unmount()

    const three = await draw(THREE)
    expect(three.getAllByRole('group')).toHaveLength(3)
    const grid3 = three.container.querySelector('[data-block="compare"] > div')!.className
    expect(grid3).toMatch(/grid-cols-1/)
    expect(grid3).toMatch(/@3xl:grid-cols-3/)
  })

  it('has a columns and a before-after variant; the second adds an arrow between the panes that screen readers skip', async () => {
    const columns = await draw(TWO)
    expect(columns.container.querySelector('[data-block="compare"]')).toHaveAttribute('data-variant', 'columns')
    expect(columns.container.querySelector('[data-block="compare"] > div > svg')).toBeNull()
    columns.unmount()

    const beforeAfter = await draw(TWO.replace('::::compare', '::::compare{variant=before-after}'))
    const root = beforeAfter.container.querySelector('[data-block="compare"]')!
    expect(root).toHaveAttribute('data-variant', 'before-after')
    const arrow = root.querySelector(':scope > div > svg')!
    expect(arrow).toHaveAttribute('aria-hidden', 'true')
    expect(beforeAfter.getAllByRole('group')).toHaveLength(2)
    expect(arrow.compareDocumentPosition(root.querySelectorAll('[data-block="pane"]')[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps the typography of the content, never sets a pixel width and has dark mode classes', async () => {
    const { container } = await draw(TWO)

    for (const pane of container.querySelectorAll('[data-block="pane"]')) {
      expect(pane.className).toContain('not-prose')
      expect(pane.className).toContain('min-w-0')
      expect(pane.className).toMatch(/\bdark:/)
      expect(pane.querySelector('.prose')).not.toBeNull()
    }
    expect(container.innerHTML).not.toMatch(/\b(?:w|min-w|max-w)-\[\d+px\]|(?:^|[\s;"])width:\s*\d+px/)
  })

  it('sets a wrapping rule on the pane titles and content, so a long unbroken word breaks inside the card', async () => {
    const { container } = await draw(TWO)

    for (const pane of container.querySelectorAll('[data-block="pane"]')) {
      expect(pane.querySelector('p')!.className).toContain('[overflow-wrap:anywhere]')
      expect(pane.querySelector('.prose')!.className).toContain('[overflow-wrap:anywhere]')
    }
  })

  it('is plain content with fewer than two panes, a third pane in before-after or a pane outside a compare block', async () => {
    const cases = [
      '::::compare\n:::pane{title="Only"}\nAlone.\n:::\n::::',
      withThirdPane(TWO.replace('::::compare', '::::compare{variant=before-after}')),
      ':::pane{title="Loose"}\nOutside.\n:::',
    ]
    for (const source of cases) {
      const { container, unmount } = await draw(source)

      expect(container.querySelector('[data-block="compare"]'), source).toBeNull()
      expect(container.querySelector('[data-block="pane"]'), source).toBeNull()
      expect(container.textContent!.length, source).toBeGreaterThan(0)
      unmount()
    }
  })

  it('becomes a sequence of titled sections in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(TWO, 'https://example.com/p/a')

    expect(html).toContain('<section><p><strong>Option A</strong></p>')
    expect(html).toContain('<section><p><strong>Option B</strong></p>')
    expect(html.indexOf('Option A')).toBeLessThan(html.indexOf('Option B'))
    expect(html).toContain('src="https://example.com/media/b.png"')
    expect(html).not.toContain('ai-block')
  })
})
