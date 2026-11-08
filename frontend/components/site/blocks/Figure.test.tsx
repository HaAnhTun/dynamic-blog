import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'

async function draw(markdown: string) {
  const { content } = await renderMarkdown(markdown)
  return render(<>{content}</>)
}

const FULL =
  '::figure{src="/media/9f3a.png#800x600" alt="A chart of monthly visits" caption="Visits doubled in March." attribution="Chart by the team"}'

describe('figure block', () => {
  it('is a figure around the image, with the caption and the attribution in its figcaption', async () => {
    const { container, getByRole } = await draw(FULL)

    const figure = container.querySelector('[data-block="figure"] figure')!
    expect(figure).not.toBeNull()
    expect(getByRole('img', { name: 'A chart of monthly visits' })).toBeInTheDocument()
    const caption = figure.querySelector('figcaption')!
    expect(caption).toHaveTextContent('Visits doubled in March.')
    expect(caption).toHaveTextContent('Chart by the team')
  })

  it('goes through the image pipeline: size hint taken from #WxH, lazy loading, async decoding', async () => {
    const { getByRole } = await draw(FULL)

    const image = getByRole('img')
    expect(image).toHaveAttribute('src', '/media/9f3a.png')
    expect(image).toHaveAttribute('width', '800')
    expect(image).toHaveAttribute('height', '600')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
  })

  it('leaves a package-relative path and an https address exactly as written', async () => {
    const relative = await draw('::figure{src="assets/diagram.png" alt="A diagram"}')
    expect(relative.getByRole('img')).toHaveAttribute('src', 'assets/diagram.png')
    relative.unmount()

    const remote = await draw('::figure{src="https://example.com/a.webp" alt="A photo"}')
    expect(remote.getByRole('img')).toHaveAttribute('src', 'https://example.com/a.webp')
  })

  it('has no figcaption when there is neither a caption nor an attribution', async () => {
    const { container } = await draw('::figure{src="/media/9f3a.png#800x600" alt="A chart"}')

    expect(container.querySelector('[data-block="figure"]')).not.toBeNull()
    expect(container.querySelector('figcaption')).toBeNull()
  })

  it('has a standard and a wide variant that differ in their classes and never set a pixel width', async () => {
    const standard = await draw('::figure{src="/media/a.png#10x10" alt="A"}')
    const standardHtml = standard.container.innerHTML
    expect(standard.container.querySelector('[data-block]')).toHaveAttribute('data-variant', 'standard')
    standard.unmount()

    const wide = await draw('::figure{src="/media/a.png#10x10" alt="A" variant=wide}')
    const root = wide.container.querySelector('[data-block]')!
    expect(root).toHaveAttribute('data-variant', 'wide')
    expect(wide.container.innerHTML).not.toBe(standardHtml)
    for (const html of [standardHtml, wide.container.innerHTML]) {
      expect(html).not.toMatch(/\b(?:w|min-w|max-w)-\[\d+px\]|(?:^|[\s;"])width:\s*\d+px/)
    }
    expect(root.className).toContain('not-prose')
    expect(root.className).toContain('max-w-full')
    expect(root.className).toContain('min-w-0')
  })

  it('has dark mode classes on the attribution', async () => {
    const { container } = await draw(FULL)

    expect(container.querySelector('figcaption')!.innerHTML).toMatch(/dark:/)
  })

  it('sets a wrapping rule on the caption and the attribution', async () => {
    const { getByText } = await draw(FULL)

    expect(getByText('Visits doubled in March.').className).toContain('[overflow-wrap:anywhere]')
    expect(getByText('Chart by the team').className).toContain('[overflow-wrap:anywhere]')
  })

  it('is plain content when the alternative text is missing or the address is not allowed', async () => {
    for (const source of ['::figure{src="assets/a.png"}', '::figure{src="javascript:alert(1)" alt="x"}']) {
      const { container, unmount } = await draw(source)

      expect(container.querySelector('[data-block]'), source).toBeNull()
      expect(container.querySelector('img'), source).toBeNull()
      unmount()
    }
  })

  it('becomes a figure with an absolute image address in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(FULL, 'https://example.com/posts/a')

    expect(html).toContain('<figure>')
    expect(html).toContain('src="https://example.com/media/9f3a.png"')
    expect(html).toContain('<figcaption>Visits doubled in March. — Chart by the team</figcaption>')
    expect(html).not.toContain('ai-block')
  })
})
