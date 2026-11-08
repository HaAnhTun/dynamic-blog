import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import MarkdownPreview from './MarkdownPreview'
import { renderMarkdown } from '@/lib/markdown'
import { validateBlocks } from '@/lib/blocks/validate'
import { useBlockDoubles } from '@/test/block-doubles'
import { msg } from '@/test/render-intl'

const WITH_BLOCKS = [
  '## Design',
  '',
  ':::callout{type=warning title="Careful"}',
  'Do **not** run twice.',
  ':::',
  '',
  '::::steps{title="Install"}',
  ':::step{title="Get it"}',
  'Download.',
  ':::',
  '::::',
  '',
  ':::diagram{type=mermaid}',
  'graph TD',
  '  A --> B',
  ':::',
  '',
  '```java title="A.java"',
  'class A {}',
  '```',
  '',
  ':::callot',
  'A typo kept as plain text.',
  ':::',
].join('\n')

describe('MarkdownPreview with blocks', () => {
  useBlockDoubles()

  it('renders the same markup as the public renderer for a document with blocks, valid and invalid alike', async () => {
    const preview = render(await MarkdownPreview({ markdown: WITH_BLOCKS })).container.innerHTML
    const publicMarkup = render(<>{(await renderMarkdown(WITH_BLOCKS)).content}</>).container.innerHTML

    expect(publicMarkup).toContain('data-block="callout"')
    expect(publicMarkup).toContain('data-block="steps"')
    expect(publicMarkup).toContain('data-block="diagram"')
    expect(publicMarkup).toContain('data-title="A.java"')
    expect(preview).toContain(publicMarkup)
  })

  it('keeps the text of an invalid block in the preview, so the author sees what the page will show', async () => {
    const { container } = render(await MarkdownPreview({ markdown: WITH_BLOCKS }))

    expect(container).toHaveTextContent('A typo kept as plain text.')
    expect(container.textContent).not.toContain(':::')
  })

  it('does not let a raw <ai-block> through the preview either', async () => {
    const { container } = render(
      await MarkdownPreview({ markdown: '<ai-block block="callout" type="danger">x</ai-block>\n\ntext' }),
    )

    expect(container.querySelector('ai-block, [data-block]')).toBeNull()
    expect(container).toHaveTextContent('text')
  })

  it('lists the problems with their lines above the preview, the same ones validateBlocks reports', async () => {
    const { container, getByRole } = render(await MarkdownPreview({ markdown: WITH_BLOCKS }))

    const problems = validateBlocks(WITH_BLOCKS)
    expect(problems.length).toBeGreaterThan(0)
    const list = getByRole('region', { name: msg('Admin.editor.blockProblemsTitle') })
    expect(list.querySelectorAll('li')).toHaveLength(problems.length)
    expect(list).toHaveTextContent(
      msg('Admin.editor.blockProblemLine', { line: String(problems[0]!.line), message: problems[0]!.message }),
    )
    expect(container.querySelector('article')).not.toBeNull()
  })

  it('lists nothing for a document whose blocks are all valid', async () => {
    const markdown = [':::callout{type=tip}', 'Fine.', ':::'].join('\n')
    const { queryByRole } = render(await MarkdownPreview({ markdown }))

    expect(queryByRole('region', { name: msg('Admin.editor.blockProblemsTitle') })).toBeNull()
  })
})
