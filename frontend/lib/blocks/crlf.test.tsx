import { render } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { BLOCK_COMPONENTS } from '@/components/site/blocks'
import { translatorFor } from '@/test/intl'
import { useBlockDoubles } from '@/test/block-doubles'
import { lintPost } from '../post-lint'
import { renderMarkdown, renderMarkdownToFeedHtml } from '../markdown'
import { validateBlocks } from './validate'

/*
 * A post saved from the editor has CRLF line endings, so every consumer of the body has to read a CRLF document the way it reads the
 * same document with LF. The document uses every block that cuts or keeps text by lines: a callout, steps with steps, code tabs with
 * fence titles, a diagram with raw source, a gallery, a details block and a table.
 */

const LINES = [
  '## Intro',
  '',
  ':::callout{type=warning title="Careful"}',
  'Do **not** run this twice.',
  ':::',
  '',
  '::::steps{variant=grouped}',
  ':::step{title="One"}',
  'First.',
  ':::',
  ':::step{title="Two"}',
  'Second.',
  ':::',
  '::::',
  '',
  ':::code-tabs{title="Hello"}',
  '```python title="hello.py"',
  'print(1)',
  '```',
  '```bash title="Shell"',
  'echo 1',
  '```',
  ':::',
  '',
  '### Flow',
  '',
  ':::diagram{type=mermaid alt="Request flow"}',
  'graph TD',
  '  A[Client] --> B[Server]',
  '',
  '  B --> C[(Store)]',
  ':::',
  '',
  ':::gallery{columns=2}',
  '![First](assets/a.png)',
  '![Second](assets/b.png)',
  ':::',
  '',
  ':::details{title="More" open}',
  'Hidden text.',
  ':::',
  '',
  ':::comparison{title="Options"}',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  ':::',
  '',
  '## Outro',
  '',
  'The end.',
]
const LF = LINES.join('\n')
const CRLF = LINES.join('\r\n')
const BASE_URL = 'https://blog.example/posts/bai-mau'

/** The props the pipeline gave to the first block of a type (the doubles of `useBlockDoubles` record every call). */
function propsOf(type: keyof typeof BLOCK_COMPONENTS): Record<string, unknown> {
  const calls = (BLOCK_COMPONENTS[type] as unknown as Mock).mock.calls
  expect(calls.length, `a ${type} block was drawn`).toBeGreaterThan(0)
  const { props, source } = calls[0]![0] as { props?: Record<string, unknown>; source?: string }
  return { ...props, ...(source === undefined ? {} : { source }) }
}

describe('a CRLF document: validateBlocks', () => {
  it('has the same problems as the LF document: none', () => {
    expect(validateBlocks(CRLF)).toEqual([])
    expect(validateBlocks(LF)).toEqual([])
  })

  it('reports a mistake on the same line, with the same message, as the LF document', () => {
    const broken = (eol: string) =>
      ['Intro.', '', ':::callout{type=alert}', 'Text.', ':::', '', '::::steps', ':::step{title=A}', 'x', '::::'].join(eol)

    expect(validateBlocks(broken('\r\n'))).toEqual(validateBlocks(broken('\n')))
    expect(validateBlocks(broken('\r\n')).map((p) => [p.line, p.code])).toEqual([
      [3, 'bad-attribute'],
      [8, 'unclosed-block'],
    ])
  })

  it('does not take a carriage return into a diagram source, so the length limit counts the same text', () => {
    const source = Array.from({ length: 40 }, (_, i) => `  A${i} --> B${i}`)
    const text = (eol: string) => `:::diagram{type=mermaid}${eol}${source.join(eol)}${eol}:::`

    expect(validateBlocks(text('\r\n'))).toEqual(validateBlocks(text('\n')))
  })
})

describe('a CRLF document: renderMarkdown', () => {
  useBlockDoubles()

  it('draws every block with the props it has in the LF document', async () => {
    render(<>{(await renderMarkdown(CRLF)).content}</>)

    expect(propsOf('callout')).toMatchObject({ type: 'warning', title: 'Careful' })
    expect(propsOf('steps')).toMatchObject({ variant: 'grouped' })
    expect(propsOf('step')).toMatchObject({ title: 'One' })
    expect(propsOf('code-tabs')).toMatchObject({ title: 'Hello' })
    expect(propsOf('diagram')).toMatchObject({ type: 'mermaid', alt: 'Request flow' })
    expect(propsOf('gallery')).toMatchObject({ columns: 2 })
    expect(propsOf('details')).toMatchObject({ title: 'More', open: true })
    expect(propsOf('comparison')).toMatchObject({ title: 'Options' })
  })

  it('renders what the LF document renders: no problems, and the line break inside a paragraph is the only difference', async () => {
    const lf = await renderMarkdown(LF)
    const lfView = render(<>{lf.content}</>)
    const crlf = await renderMarkdown(CRLF)
    const crlfView = render(<>{crlf.content}</>)

    expect(crlf.problems).toEqual([])
    // A soft line break inside a paragraph (between the two gallery images) keeps the line ending the author wrote: it is whitespace.
    expect(crlfView.container.innerHTML.replaceAll('\r\n', '\n')).toBe(lfView.container.innerHTML)
    expect(crlfView.container.innerHTML.replaceAll('\r\n', '')).not.toContain('\r')
  })

  it('hands the diagram its source exactly as written, with LF line breaks only', async () => {
    const { content } = await renderMarkdown(CRLF)
    const { container } = render(<>{content}</>)

    const source = container.querySelector('[data-block="diagram"] pre')!.textContent
    expect(source).toBe('graph TD\n  A[Client] --> B[Server]\n\n  B --> C[(Store)]')
    expect(source).not.toContain('\r')
    expect(propsOf('diagram').source).toBe(source)
  })

  it('reads the title of each code fence, without a carriage return in it', async () => {
    const { content } = await renderMarkdown(CRLF)
    const { container } = render(<>{content}</>)

    const pres = [...container.querySelectorAll('[data-block="code-tabs"] pre')]
    expect(pres.map((pre) => pre.getAttribute('data-title'))).toEqual(['hello.py', 'Shell'])
    expect(pres.map((pre) => pre.textContent)).toEqual(['print(1)', 'echo 1'])
  })

  it('keeps the headings and the table of contents the LF document has', async () => {
    const lf = await renderMarkdown(LF)
    const crlf = await renderMarkdown(CRLF)

    expect(crlf.toc).toEqual(lf.toc)
    expect(crlf.toc.map((entry) => [entry.depth, entry.id, entry.text])).toEqual([
      [2, 'intro', 'Intro'],
      [3, 'flow', 'Flow'],
      [2, 'outro', 'Outro'],
    ])
  })

  it('reports a mistake with the same line and code as the LF document', async () => {
    const broken = (eol: string) =>
      [':::callout{type=alert}', 'Bad.', ':::', '', '```java title="A.java"', 'class A {}', '```'].join(eol)
    const lf = await renderMarkdown(broken('\n'))
    const crlf = await renderMarkdown(broken('\r\n'))

    expect(crlf.problems.map((p) => [p.line, p.code])).toEqual(lf.problems.map((p) => [p.line, p.code]))
    expect(crlf.problems).toHaveLength(1)
    expect(vi.isMockFunction(BLOCK_COMPONENTS.callout)).toBe(true)
  })
})

describe('a CRLF document: the pre-publish lint', () => {
  const t = translatorFor('en', 'Admin.lint')
  const excerpt =
    'A description long enough for a post, saying what the post is about and what the reader gets after reading it all.'

  it('has no warning for a document the LF version passes: no fence reported as missing a language, no problem in a block', () => {
    expect(lintPost({ excerpt, content: LF }, t)).toEqual([])
    expect(lintPost({ excerpt, content: CRLF }, t)).toEqual([])
  })

  it('warns about the same lines as the LF document', () => {
    const content = (eol: string) =>
      ['# Title', '', ':::callout{type=alert}', 'x', ':::', '', '```', 'ls', '```', '', '```python', 'never closed'].join(eol)

    const crlf = lintPost({ excerpt, content: content('\r\n') }, t)
    expect(crlf).toEqual(lintPost({ excerpt, content: content('\n') }, t))
    expect(crlf.map((w) => [w.rule, w.line])).toEqual([
      ['body-h1', 1],
      ['block-problem', 3],
      ['fence-language-missing', 7],
      ['fence-unclosed', 11],
    ])
  })
})

describe('a CRLF document: the feed', () => {
  it('becomes the same HTML as the LF document, with the diagram source and the fence titles intact', async () => {
    const html = await renderMarkdownToFeedHtml(CRLF, BASE_URL)

    // The line ending between the two gallery images is whitespace inside a paragraph and stays as written; nothing else differs.
    expect(html.replaceAll('\r\n', '\n')).toBe(await renderMarkdownToFeedHtml(LF, BASE_URL))
    expect(html.replaceAll('\r\n', '')).not.toContain('\r')
    expect(html).toContain(
      '<pre><code class="language-mermaid">graph TD\n  A[Client] --> B[Server]\n\n  B --> C[(Store)]</code></pre>',
    )
    expect(html).toContain('<p><strong>hello.py</strong></p>')
    expect(html).toContain('<p><strong>Shell</strong></p>')
    expect(html).toContain('<details open>')
    expect(html).not.toMatch(/ai-block|data-block|:::/)
  })

  it('draws an invalid block as its plain content in a CRLF document too, with no marker left behind', async () => {
    const html = await renderMarkdownToFeedHtml(':::callot\r\nKept text.\r\n:::\r\n\r\nAfter.', BASE_URL)

    expect(html).toBe(await renderMarkdownToFeedHtml(':::callot\nKept text.\n:::\n\nAfter.', BASE_URL))
    expect(html).toContain('<p>Kept text.</p>')
    expect(html).not.toContain('\r')
  })
})
