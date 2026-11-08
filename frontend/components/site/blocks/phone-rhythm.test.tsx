import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { IntlWrapper } from '@/test/intl'

async function draw(markdown: string) {
  const { content } = await renderMarkdown(markdown)
  return render(<IntlWrapper>{content}</IntlWrapper>)
}

const TABLE = ['| Option | Cost |', '| --- | --- |', '| A | 1 |'].join('\n')

/**
 * Blocks are 24px apart on a phone and 32px from sm (the pull quote 32 and 40px): one rhythm for every block of an article, so a long post
 * does not breathe differently from one block to the next. The block roots carry the margin themselves (a block is `not-prose`).
 */
describe('blocks: the vertical rhythm of a phone', () => {
  const BLOCKS: Array<[name: string, markdown: string]> = [
    ['steps', '::::steps\n:::step{title="One"}\nText\n:::\n::::'],
    [
      'timeline',
      '::::timeline\n:::event{when="2020" title="One"}\nText\n:::\n:::event{when="2021" title="Two"}\nText\n:::\n::::',
    ],
    ['metrics', '::::metrics\n::metric{label="Latency" value="12 ms"}\n::metric{label="Errors" value="0.2%"}\n::::'],
    ['compare', '::::compare\n:::pane{title="A"}\nText\n:::\n:::pane{title="B"}\nText\n:::\n::::'],
    [
      'gallery',
      ':::gallery\n![one](/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png)\n![two](/media/1b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png)\n:::',
    ],
    ['takeaways', ':::takeaways\n- one\n:::'],
    ['checklist', ':::checklist\n- [x] one\n- [ ] two\n:::'],
    ['comparison', `:::comparison\n${TABLE}\n:::`],
  ]

  it.each(BLOCKS)('%s is 24px from its neighbours on a phone and 32px from sm', async (name, markdown) => {
    const { container } = await draw(markdown)

    const root = container.querySelector(`[data-block="${name}"]`)
    expect(root, name).not.toBeNull()
    expect(root).toHaveClass('my-6', 'sm:my-8')
  })

  it('the pull quote is 32px from its neighbours on a phone and 40px from sm', async () => {
    const { container } = await draw(':::pullquote\nA sentence.\n:::')

    const root = container.querySelector('[data-block="pullquote"]')
    expect(root).not.toBeNull()
    expect(root).toHaveClass('my-8', 'sm:my-10')
  })
})
