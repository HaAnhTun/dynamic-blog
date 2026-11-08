import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { BLOCK_MARKER, BLOCK_PROSE, BLOCK_PROSE_BASE } from './content-prose'

const base = BLOCK_PROSE_BASE.split(' ')

/**
 * A block root carries `not-prose`, and the typography plugin leaves EVERY descendant of a `not-prose` element alone: a nested
 * `.prose` does not switch it back on. These classes are therefore the only styling the Markdown inside a block gets for these
 * elements. The checks read the class list because jsdom does no layout; the browser run of the verification ticket measures the
 * result (no horizontal overflow of a code block in a step at 320 px, table cells with padding, bullets in takeaways).
 */
describe('the typography of the Markdown inside a block', () => {
  it('lets a code block scroll sideways instead of widening the page', () => {
    expect(base).toContain('[&_pre]:overflow-x-auto')
  })

  it('keeps a code block apart from the text around it', () => {
    expect(base).toContain('[&_[data-code-block]:not(:first-child)]:mt-6')
    expect(base).toContain('[&_[data-code-block]:not(:last-child)]:mb-6')
  })

  it('separates list items by 12px on a phone only: a wrapped item is not mistaken for two, and the desktop lists keep their rhythm', () => {
    expect(base).toContain('max-sm:[&_li]:my-1.5')
    expect(base).not.toContain('[&_li]:my-1.5')
  })

  it('draws bullets and numbers for lists', () => {
    expect(base).toContain('[&_ul]:list-disc')
    expect(base).toContain('[&_ol]:list-decimal')
    expect(base).toContain('[&_ul]:ps-6')
    expect(base).toContain('[&_ol]:ps-6')
  })

  it('gives table cells room and aligns the header with its column', () => {
    for (const token of ['[&_th]:px-3', '[&_th]:py-2', '[&_td]:px-3', '[&_td]:py-2', '[&_th]:text-start']) {
      expect(base).toContain(token)
    }
  })

  it('stretches a table over the whole block, as the plugin does for a table in an ordinary article', () => {
    expect(base).toContain('[&_table]:w-full')
  })

  it('does not break a word of a table cell in the middle, the wide table scrolls in its frame instead', () => {
    expect(base).toContain('[&_th]:[overflow-wrap:normal]')
    expect(base).toContain('[&_td]:[overflow-wrap:normal]')
  })

  it('shows links as links', () => {
    expect(base).toContain('[&_a]:text-brand')
    expect(base).toContain('[&_a]:underline')
  })

  it('does not depend on plugin variants, which are inert inside not-prose', () => {
    expect(base.filter((token) => token.startsWith('prose-a:') || token.startsWith('prose-li:'))).toEqual([])
    expect(BLOCK_MARKER).toBe('[&_li::marker]:text-neutral-400')
    expect(BLOCK_PROSE).toContain(BLOCK_MARKER)
  })
})

const NEWLINE = String.fromCharCode(10)
const lines = (...parts: string[]) => parts.join(NEWLINE)

const FENCE = lines('```sh', 'npm install --global some-very-long-package-name-for-a-narrow-screen', '```')

const BLOCKS: Record<string, string> = {
  step: lines('::::steps', ':::step{title="One"}', FENCE, ':::', '::::'),
  callout: lines(':::callout{type="tip"}', FENCE, ':::'),
  details: lines(':::details{title="More"}', FENCE, ':::'),
  pane: lines('::::compare', ':::pane{title="A"}', FENCE, ':::', ':::pane{title="B"}', 'Text', ':::', '::::'),
}

/** The classes of every ancestor of `element` up to the block root (a step or a pane lies inside its steps or compare root). */
function ancestorClasses(element: Element): string[] {
  const classes: string[] = []
  for (let node = element.parentElement; node; node = node.parentElement) {
    classes.push(node.className)
    if (node.hasAttribute('data-block') && !['step', 'pane'].includes(node.getAttribute('data-block')!)) break
  }
  return classes
}

describe('a fenced code block inside a block', () => {
  for (const [name, markdown] of Object.entries(BLOCKS)) {
    it(`scrolls sideways inside the body of a ${name}, so it cannot widen the page`, async () => {
      const { content, problems } = await renderMarkdown(markdown)
      expect(problems).toEqual([])
      const { container } = render(<>{content}</>)

      const code = container.querySelector('pre')
      expect(code, 'the code block is drawn').not.toBeNull()
      expect(ancestorClasses(code!).some((value) => value.split(' ').includes('[&_pre]:overflow-x-auto'))).toBe(true)
    })
  }
})
