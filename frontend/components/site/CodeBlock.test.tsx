import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { msg, renderWithIntl } from '@/test/render-intl'
import { CodeBlock } from './CodeBlock'

/** The copy button of `CopyCodeButton` needs a clipboard, which jsdom does not have (see CopyCodeButton.test.tsx). */
function installClipboard() {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  return writeText
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('CodeBlock', () => {
  it('draws a block without a title as before: the <pre> and the copy button, no title bar', () => {
    const { container } = renderWithIntl(
      <CodeBlock className="shiki" tabIndex={0}>
        <code>x = 1</code>
      </CodeBlock>,
    )

    const frame = container.querySelector('[data-code-block]')!
    expect(frame.querySelector(':scope > pre')).toHaveTextContent('x = 1')
    expect(frame.querySelector('[data-code-title]')).toBeNull()
    expect(screen.getByRole('button', { name: msg('Site.code.copy') })).toBeInTheDocument()
  })

  it('shows the title of the fence above the code, inside the same frame as the copy button', () => {
    const { container } = renderWithIntl(
      <CodeBlock className="shiki" tabIndex={0} data-title="app/main.py">
        <code>x = 1</code>
      </CodeBlock>,
    )

    const frame = container.querySelector('[data-code-block]')!
    const bar = frame.querySelector(':scope > [data-code-title]')
    expect(bar).toHaveTextContent('app/main.py')
    // The title comes before the code in reading order, and the button stays after the <pre>, as before.
    expect(bar!.compareDocumentPosition(frame.querySelector('pre')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(frame.querySelector('pre + button')).toBe(screen.getByRole('button', { name: msg('Site.code.copy') }))
  })

  it('copies only the code, never the title', async () => {
    const writeText = installClipboard()
    renderWithIntl(
      <CodeBlock className="shiki" tabIndex={0} data-title="app/main.py">
        <code>x = 1</code>
      </CodeBlock>,
    )

    await act(async () => {
      screen.getByRole('button', { name: msg('Site.code.copy') }).click()
    })

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('x = 1')
  })

  it('treats an empty title as no title', () => {
    const { container } = renderWithIntl(
      <CodeBlock data-title="">
        <code>x</code>
      </CodeBlock>,
    )

    expect(container.querySelector('[data-code-title]')).toBeNull()
  })
})

describe('CodeBlock: through the Markdown pipeline', () => {
  it('falls back to plain text for a language it does not highlight, with the code intact and no error', async () => {
    const { content } = await renderMarkdown('```cobol title="legacy.cob"\nMOVE 1 TO X.\n```')
    const { container } = renderWithIntl(<>{content}</>)

    const pre = container.querySelector('pre')!
    expect(pre.textContent).toBe('MOVE 1 TO X.')
    expect(pre).toHaveAttribute('data-title', 'legacy.cob')
    expect(container.querySelector('[data-code-title]')).toHaveTextContent('legacy.cob')
  })

  it('shows a titled fence of a highlighted language with its title bar and the highlight', async () => {
    const { content } = await renderMarkdown('```python title="app.py"\nx = 1\n```')
    const { container } = renderWithIntl(<>{content}</>)

    expect(container.querySelector('[data-code-title]')).toHaveTextContent('app.py')
    expect(container.querySelector('pre.shiki')).toHaveTextContent('x = 1')
  })
})

const YAML = [
  'limits:',
  '  retries: 5',
  '  timeout: 30s',
  'queue:',
  '  name: default',
  '  depth: 5000',
  '  rate: 100',
  'end: true',
].join('\n')

/** The sentence a screen reader gets for the code: the text of the element the `<pre>` points to with `aria-describedby`. */
function describedBy(pre: Element): string | null {
  const id = pre.getAttribute('aria-describedby')
  return id === null ? null : (pre.ownerDocument.getElementById(id)?.textContent ?? null)
}

describe('CodeBlock: highlighted lines', () => {
  it('names the highlighted lines in text for a screen reader, and draws them with a start border in both themes', async () => {
    const { content } = await renderMarkdown('```yaml highlight="2,5-7"\n' + YAML + '\n```')
    const { container } = renderWithIntl(<>{content}</>)

    const frame = container.querySelector('[data-code-block]')!
    const pre = container.querySelector('pre.shiki')!
    const lines = msg('Site.code.lineRange', { start: 5, end: 7 })
    expect(describedBy(pre)).toBe(msg('Site.code.highlightedLines', { count: 4, lines: `2, ${lines}` }))
    // The description is text of the page next to the code, not a part of it.
    expect(pre.contains(pre.ownerDocument.getElementById(pre.getAttribute('aria-describedby')!))).toBe(false)
    expect(frame.className).toMatch(/border-s-/)
    expect(frame.className).toMatch(/data-highlighted/)
    expect(frame.className).toMatch(/dark:\S*data-highlighted/)
  })

  it('counts the lines for the plural of the sentence, and writes a range as a range', async () => {
    const { content } = await renderMarkdown('```yaml highlight="3"\n' + YAML + '\n```')
    const { container } = renderWithIntl(<>{content}</>)

    expect(describedBy(container.querySelector('pre')!)).toBe(msg('Site.code.highlightedLines', { count: 1, lines: '3' }))
    // English has a singular and a plural; the count is the number of lines, not of ranges.
    expect(msg('Site.code.highlightedLines', { count: 1, lines: '3' }, 'en')).not.toBe(
      msg('Site.code.highlightedLines', { count: 2, lines: '3' }, 'en'),
    )
  })

  it('has no description and no extra element for a fence without a highlight', async () => {
    const { content } = await renderMarkdown('```yaml\n' + YAML + '\n```')
    const { container } = renderWithIntl(<>{content}</>)

    expect(container.querySelector('pre')).not.toHaveAttribute('aria-describedby')
    expect(container.querySelector('[data-code-description]')).toBeNull()
  })

  it('keeps the title bar of a titled panel, and copies only the code', async () => {
    const writeText = installClipboard()
    const { content } = await renderMarkdown('```yaml title="limits.yaml" highlight="2"\n' + YAML + '\n```')
    const { container } = renderWithIntl(<>{content}</>)

    expect(container.querySelector('[data-code-title]')).toHaveTextContent('limits.yaml')
    expect(describedBy(container.querySelector('pre')!)).toBe(msg('Site.code.highlightedLines', { count: 1, lines: '2' }))
    await act(async () => {
      screen.getByRole('button', { name: msg('Site.code.copy') }).click()
    })
    expect(writeText).toHaveBeenCalledWith(YAML)
  })

  it('does not trust a highlight value that is not a valid list of ranges', () => {
    const { container } = renderWithIntl(
      <CodeBlock data-highlight="9,2">
        <code>x</code>
      </CodeBlock>,
    )

    expect(container.querySelector('pre')).not.toHaveAttribute('aria-describedby')
  })
})

describe('CodeBlock: a diff fence', () => {
  const DIFF = ['--- a/app.py', '+++ b/app.py', '@@ -1,3 +1,3 @@', ' keep', '-old', '+new'].join('\n')

  it('marks the added and the removed lines, keeps the + and - characters and explains them in text', async () => {
    const { content } = await renderMarkdown('```diff\n' + DIFF + '\n```')
    const { container } = renderWithIntl(<>{content}</>)

    const pre = container.querySelector('pre.shiki')!
    expect([...pre.querySelectorAll('.line[data-diff="add"]')].map((line) => line.textContent)).toEqual(['+new'])
    expect([...pre.querySelectorAll('.line[data-diff="remove"]')].map((line) => line.textContent)).toEqual(['-old'])
    // The two file header lines and the hunk header are not changes.
    expect(pre.querySelectorAll('.line[data-diff]')).toHaveLength(2)
    expect(pre.textContent).toBe(DIFF)
    expect(describedBy(pre)).toBe(msg('Site.code.diffHint'))
    expect(container.querySelector('[data-code-block]')!.className).toMatch(/dark:\S*data-diff/)
  })

  it('says both things for a diff with highlighted lines', async () => {
    const { content } = await renderMarkdown('```diff highlight="5"\n' + DIFF + '\n```')
    const { container } = renderWithIntl(<>{content}</>)

    const text = describedBy(container.querySelector('pre')!)
    expect(text).toContain(msg('Site.code.highlightedLines', { count: 1, lines: '5' }))
    expect(text).toContain(msg('Site.code.diffHint'))
  })

  it('does not take a diff mark from raw HTML: only the fence of a diff language gets one', async () => {
    const { content } = await renderMarkdown('<pre data-diff="" class="x"><code>+a\n-b</code></pre>\n\n```yaml\n+a\n```')
    const { container } = renderWithIntl(<>{content}</>)

    expect(container.querySelector('[data-diff]')).toBeNull()
    for (const pre of container.querySelectorAll('pre')) expect(pre).not.toHaveAttribute('aria-describedby')
  })
})
