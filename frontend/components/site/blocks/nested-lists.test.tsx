import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { renderWithIntl } from '@/test/render-intl'

/**
 * The body of a tab, a step or a details block carries the shared prose rules `[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ps-6
 * [&_ol]:ps-6`, which are more specific than a plain `list-none` or `p-0`. A block that draws its own list must win with the
 * important modifier, or it shows markers next to its badges and an indent it does not want inside another block.
 */
async function draw(markdown: string) {
  const { content, problems } = await renderMarkdown(markdown)
  expect(problems).toEqual([])
  return renderWithIntl(<>{content}</>)
}

const STEPS = ['::::steps', ':::step{title="Install"}', 'Get it.', ':::', ':::step{title="Run"}', 'Start it.', ':::', '::::']

const TREE = ['::::file-tree', '- src/', '  - app/', '    - main.py', '  - README.md', '::::']

const treeBody = (container: HTMLElement) => container.querySelector('[data-block="file-tree"] > div')!

describe('steps inside the body of another block', () => {
  it.each([
    [
      'a tab',
      [
        '::::::tabs',
        ':::::tab{title="Windows"}',
        ...STEPS,
        ':::::',
        ':::::tab{title="Linux"}',
        'Use the package manager.',
        ':::::',
        '::::::',
      ],
    ],
    ['a details block', ['::::::details{title="More"}', ...STEPS, '::::::']],
  ])('keeps the list of %s free of markers and indent', async (_name, lines) => {
    const { container } = await draw(lines.join('\n'))

    const list = container.querySelector('[data-block="steps"] > ol')!
    expect(list).toHaveClass('list-none!', 'p-0!', 'ps-0!')
  })
})

describe('a file tree inside the body of another block', () => {
  it.each([
    [
      'a tab',
      ['::::::tabs', ':::::tab{title="Files"}', ...TREE, ':::::', ':::::tab{title="Other"}', 'Nothing here.', ':::::', '::::::'],
    ],
    ['a step', ['::::::steps', ':::::step{title="Look"}', ...TREE, ':::::', '::::::']],
    ['a details block', ['::::::details{title="Layout"}', ...TREE, '::::::']],
  ])('keeps the root list of %s flush and the nested lists indented by the tree', async (_name, lines) => {
    const { container } = await draw(lines.join('\n'))

    const body = treeBody(container)
    expect(body).toHaveClass('[&_ul]:list-none!', '[&_ul]:p-0!', '[&_ul]:ps-0!', '[&_ul_ul]:ps-3!')
    // The tree lines are what the block draws: a nested list is a real nested list.
    expect(body.querySelectorAll('ul ul')).toHaveLength(2)
  })
})
