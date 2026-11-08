import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'

async function draw(markdown: string) {
  const { content } = await renderMarkdown(markdown)
  return render(<>{content}</>)
}

const THREE = [
  '![First view](/media/a.png#40x30)',
  '![Second view](/media/b.png#40x30 "The second one")',
  '![Third view](assets/c.png)',
].join('\n')

describe('gallery block', () => {
  it('lists every image of the body once, each with its alternative text, whether the lines are together or apart', async () => {
    for (const body of [THREE, THREE.split('\n').join('\n\n')]) {
      const { container, getAllByRole, unmount } = await draw(`:::gallery\n${body}\n:::`)

      const items = getAllByRole('listitem')
      expect(items).toHaveLength(3)
      expect(items.map((item) => item.querySelector('img')!.getAttribute('alt'))).toEqual([
        'First view',
        'Second view',
        'Third view',
      ])
      expect(container.querySelectorAll('img')).toHaveLength(3)
      unmount()
    }
  })

  it('keeps what the image pipeline does: size hint, lazy loading, the title as a figcaption, a package path as written', async () => {
    const { container } = await draw(`:::gallery\n${THREE}\n:::`)

    const [first, second, third] = [...container.querySelectorAll('img')]
    expect(first).toHaveAttribute('src', '/media/a.png')
    expect(first).toHaveAttribute('width', '40')
    expect(first).toHaveAttribute('loading', 'lazy')
    expect(second!.closest('figure')!.querySelector('figcaption')).toHaveTextContent('The second one')
    expect(third).toHaveAttribute('src', 'assets/c.png')
  })

  it('keeps its list free of bullets and indent, also inside the body of another block whose typography draws them', async () => {
    const { container } = await draw(`:::gallery
${THREE}
:::`)

    // `[&_ul]:list-disc` and `[&_ul]:ps-6` of a block body are more specific than `list-none` and `p-0`, so the gallery list wins
    // only with the important modifier.
    expect(container.querySelector('ul')).toHaveClass('list-none!', 'p-0!', 'ps-0!')
  })

  it('shows the caption of the whole gallery', async () => {
    const { getByText } = await draw(`:::gallery{caption="The workshop, three views"}\n${THREE}\n:::`)

    expect(getByText('The workshop, three views')).toBeInTheDocument()
  })

  it('has two columns by default and three on request, chosen by the width of the container, one column below that', async () => {
    const two = await draw(`:::gallery\n${THREE}\n:::`)
    expect(two.container.querySelector('[data-block="gallery"]')).toHaveAttribute('data-columns', '2')
    const grid2 = two.getAllByRole('list')[0]!.className
    two.unmount()

    const three = await draw(`:::gallery{columns=3}\n${THREE}\n:::`)
    const grid3 = three.getAllByRole('list')[0]!.className
    expect(three.container.querySelector('[data-block="gallery"]')).toHaveAttribute('data-columns', '3')

    expect(grid2).toMatch(/grid-cols-1/)
    expect(grid2).toMatch(/@md:grid-cols-2/)
    expect(grid3).toMatch(/grid-cols-1/)
    expect(grid3).toMatch(/@xl:grid-cols-3/)
    expect(grid3).not.toBe(grid2)
    expect(three.container.querySelector('[data-block="gallery"]')!.className).toContain('@container')
  })

  it('sets no fixed pixel width, stays inside the body and has no lightbox', async () => {
    const { container, queryByRole } = await draw(`:::gallery\n${THREE}\n:::`)

    const root = container.querySelector('[data-block="gallery"]')!
    expect(root.className).toContain('not-prose')
    expect(root.className).toContain('min-w-0')
    expect(root.className).toContain('max-w-full')
    expect(container.innerHTML).not.toMatch(/\b(?:w|min-w|max-w)-\[\d+px\]|(?:^|[\s;"])width:\s*\d+px/)
    expect(queryByRole('button')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
  })

  it('has dark mode classes on the caption', async () => {
    const { container } = await draw(`:::gallery{caption="Views"}\n${THREE}\n:::`)

    expect(container.querySelector('[data-block="gallery"]')!.innerHTML).toMatch(/dark:/)
  })

  it('is plain content with a column count that does not exist', async () => {
    const { container, getAllByRole } = await draw(`:::gallery{columns=5}\n${THREE}\n:::`)

    expect(container.querySelector('[data-block]')).toBeNull()
    expect(getAllByRole('img')).toHaveLength(3)
  })

  it('becomes the images in order with the caption under them in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(`:::gallery{caption="Three views"}\n${THREE}\n:::`, 'https://example.com/p/a')

    expect(html.indexOf('First view')).toBeLessThan(html.indexOf('Second view'))
    expect(html.indexOf('Second view')).toBeLessThan(html.indexOf('Third view'))
    expect(html).toContain('src="https://example.com/media/a.png"')
    expect(html).toContain('<em>Three views</em>')
    expect(html).not.toContain('ai-block')
  })
})
