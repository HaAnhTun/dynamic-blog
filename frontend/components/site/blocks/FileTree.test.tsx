import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '@/lib/markdown'
import { msg } from '@/test/render-intl'
import { FileTree } from './FileTree'

const FIXED_WIDTH = /(^|\s)(w|min-w|max-w)-\[\d+px\]|(^|\s)-m[xlrtb]?-/

/** Every class of the block, root and body together: the tree styles sit on the body, the frame on the root. */
const classesOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-block="file-tree"], [data-block="file-tree"] > div'))
    .map((element) => element.getAttribute('class'))
    .join(' ')

const tree = (title?: string) => (
  <FileTree props={{ title }}>
    <ul>
      <li>
        src/
        <ul>
          <li>
            app/
            <ul>
              <li>main.py</li>
            </ul>
          </li>
          <li>README.md</li>
        </ul>
      </li>
      <li>LICENSE</li>
    </ul>
  </FileTree>
)

describe('FileTree', () => {
  it('is a real nested list inside a not-prose root marked as a file tree', () => {
    const { container } = render(tree())

    const root = container.querySelector('[data-block="file-tree"]')!
    expect(root).not.toBeNull()
    expect(root.className).toContain('not-prose')
    const lists = container.querySelectorAll('ul')
    expect(lists).toHaveLength(3)
    expect(container.querySelector('ul ul ul li')).toHaveTextContent('main.py')
  })

  it('names the group by its title, or by a default label, and the title is not a heading', () => {
    const titled = render(tree('Project layout'))
    const group = titled.container.querySelector('[data-block="file-tree"]')!
    expect(screen.getByText('Project layout')).toHaveAttribute('id', group.getAttribute('aria-labelledby'))
    expect(titled.container.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    titled.unmount()

    render(tree())
    expect(screen.getByRole('group', { name: msg('Site.blocks.fileTreeLabel') })).toBeInTheDocument()
  })

  it('tells a folder apart by the trailing slash in its text, never by an icon alone', () => {
    const { container } = render(tree())

    const folders = Array.from(container.querySelectorAll('li:has(> ul)'))
    expect(folders).toHaveLength(2)
    for (const folder of folders) expect(folder.firstChild?.textContent?.trim()).toMatch(/\/$/)
    expect(container.querySelector('svg, img')).toBeNull()
  })

  it('draws the tree in a mono font with tree lines, a nested list of lines per level', () => {
    const { container } = render(tree())

    const classes = classesOf(container)
    expect(classes).toMatch(/font-mono/)
    expect(classes).toMatch(/\[&_ul_ul\]:border-s/)
    expect(classes).toMatch(/\[&_li:has\(>ul\)\]:font-semibold/)
    expect(classes).toMatch(/\[&_ul\]:list-none/)
  })

  it('wraps a long name inside the frame and sets no fixed pixel width', () => {
    const { container } = render(
      <FileTree props={{}}>
        <ul>
          <li>{'a-very-long-file-name-'.repeat(12)}.txt</li>
        </ul>
      </FileTree>,
    )

    const root = container.querySelector('[data-block="file-tree"]')!
    expect(classesOf(container)).toContain('[overflow-wrap:anywhere]')
    expect(root.className).toContain('min-w-0')
    expect(root.className).toContain('max-w-full')
    for (const element of container.querySelectorAll('[class]')) {
      expect(element.getAttribute('class'), element.tagName).not.toMatch(FIXED_WIDTH)
    }
  })

  it('has a dark mode for the frame, the text and the tree lines', () => {
    const { container } = render(tree())

    const classes = classesOf(container)
    expect(classes).toMatch(/dark:bg-/)
    expect(classes).toMatch(/dark:text-/)
    expect(classes).toMatch(/dark:\[&_ul\]:border-/)
    expect(classes).toMatch(/dark:border-/)
  })

  it('draws a Markdown list through the whole pipeline as a nested list and keeps its links and code', async () => {
    const { content, problems } = await renderMarkdown(
      [':::file-tree{title="Layout"}', '- src/', '  - `main.py`', '  - [docs](https://example.com/docs)', ':::'].join('\n'),
    )
    const { container } = render(<>{content}</>)

    expect(problems).toEqual([])
    const root = container.querySelector('[data-block="file-tree"]')!
    expect(root.querySelector('ul ul li code')).toHaveTextContent('main.py')
    expect(root.querySelector('ul ul a')).toHaveAttribute('href', 'https://example.com/docs')
    expect(root).toHaveTextContent('Layout')
  })

  it('falls back to the list itself in the feed', async () => {
    const html = await renderMarkdownToFeedHtml(
      [':::file-tree{title="Layout"}', '- src/', '  - main.py', ':::'].join('\n'),
      'https://blog.example/posts/a',
    )

    expect(html).toContain('Layout')
    expect(html).toMatch(/<ul>\s*<li>src\/\s*<ul>\s*<li>main\.py<\/li>/)
    expect(html).not.toContain('data-block')
  })
})
