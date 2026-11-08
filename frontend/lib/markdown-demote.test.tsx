import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

/** The `demoteTopHeading` option: for a Markdown body that sits under a page which already has its own `h1` (the About page). */
const MARKDOWN = ['# Top', '', 'Text.', '', '## Second', '', '```sh', '# a comment in a fence', '```'].join('\n')

describe('renderMarkdown with demoteTopHeading', () => {
  it('draws a level-1 heading as a level 2, with the same id and a table of contents entry of depth 2', async () => {
    const { content, toc } = await renderMarkdown(MARKDOWN, { demoteTopHeading: true })
    const { container } = render(<>{content}</>)

    expect(container.querySelectorAll('h1')).toHaveLength(0)
    expect(container.querySelector('h2#top')).toHaveTextContent('Top')
    expect(toc).toEqual([
      { depth: 2, id: 'top', text: 'Top' },
      { depth: 2, id: 'second', text: 'Second' },
    ])
  })

  it('changes nothing by default: the level-1 heading stays an h1 and stays out of the table of contents', async () => {
    const { content, toc } = await renderMarkdown(MARKDOWN)
    const { container } = render(<>{content}</>)

    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(toc.map((entry) => entry.id)).toEqual(['second'])
  })
})
