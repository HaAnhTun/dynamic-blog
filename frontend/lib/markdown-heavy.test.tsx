import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { countBlocks } from './blocks/summary'
import { validateBlocks } from './blocks/validate'
import { renderMarkdown, renderMarkdownToFeedHtml } from './markdown'

/**
 * An article that would cost the Markdown parser more than its budget (lib/blocks/parse-budget.ts) is never given to the parser: every
 * parser of the article asks first (the page, the preview and the feed through `sanitizedPipeline`, and `validateBlocks` and
 * `countBlocks`), and reads the text as plain text with one `too-heavy` problem. The shapes below took the real parser from seconds to
 * minutes before the guard (24 KB of `*]` took 25 s; 100 KB of `a`, a line and `---` took 46 s; 100 KB of quotes took 42 s). Nothing
 * here measures a clock except one loose ceiling, a thousand times the real cost: without the guard the first test would not end.
 */

const SECOND_PARAGRAPH = 'A second paragraph that is perfectly ordinary text.'

/** A run of `*]` that the parser needs half a minute for, with a heading, a script and a second paragraph around it. */
function heavyArticle(): string {
  return ['# Not a heading', '', '<script>alert(1)</script> ' + '*]'.repeat(6000), '', SECOND_PARAGRAPH, ''].join('\n')
}

describe('an article too heavy for the Markdown parser', () => {
  it('is shown as plain text within a few seconds, with one problem, and no text is lost', async () => {
    const started = performance.now()
    const { content, toc, problems } = await renderMarkdown(heavyArticle())
    const { container } = render(<>{content}</>)

    expect(performance.now() - started).toBeLessThan(10_000)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ code: 'too-heavy' })
    expect(problems[0]?.message).toContain('plain text')
    // The heading marker is text, not a heading; the script is text, not an element; the second paragraph is intact.
    expect(toc).toEqual([])
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText('# Not a heading')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('*]*]*]')
    expect(screen.getByText(SECOND_PARAGRAPH)).toBeInTheDocument()
    expect(container.querySelectorAll('p')).toHaveLength(3)
  }, 30_000)

  it('goes through the same sanitizer: HTML typed in the text stays text, links stay text', async () => {
    const { content } = await renderMarkdown(
      '[click](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n' + '> a\n\n'.repeat(4000),
    )
    const { container } = render(<>{content}</>)

    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[click](javascript:alert(1))')
  }, 30_000)

  it('is shown the same way in the feed, as escaped text in paragraphs', async () => {
    const html = await renderMarkdownToFeedHtml(heavyArticle(), 'https://example.test/posts/x')

    expect(html).not.toContain('<script')
    expect(html).not.toContain('<h1')
    // `<` is written as a character reference, so the script is text to a feed reader.
    expect(html).toContain('&#x3C;script>alert(1)')
    expect(html).toContain(SECOND_PARAGRAPH)
  }, 30_000)

  it('is reported by validateBlocks, which parses nothing, and has no blocks for countBlocks', () => {
    const article = ':::callout{type="note"}\nA block.\n:::\n\n' + heavyArticle()

    const problems = validateBlocks(article)
    expect(problems.map((problem) => problem.code)).toEqual(['too-heavy'])
    expect(countBlocks(article)).toEqual([])
  })

  it('an article inside the budget is read as before, blocks included', async () => {
    const article = '## Title\n\n:::callout{type="note"}\nA *block*.\n:::\n'
    const { problems, toc } = await renderMarkdown(article)

    expect(problems).toEqual([])
    expect(toc.map((entry) => entry.text)).toEqual(['Title'])
    expect(validateBlocks(article)).toEqual([])
    expect(countBlocks(article)).toEqual([{ type: 'callout', count: 1 }])
  })
})

describe('an article the parser cannot walk to the end', () => {
  // Thousands of open tags overflow the call stack long before they cost much time, so the budget lets them in: that is a RangeError,
  // which would be a 500 on the page, the preview and the feed.
  const nested = 'before\n\n' + '<div> '.repeat(3000) + '\n\nafter\n'

  it('is shown as plain text with a problem, not as an error', async () => {
    const { content, problems } = await renderMarkdown(nested)
    const { container } = render(<>{content}</>)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ code: 'too-heavy' })
    expect(problems[0]?.message).toContain('gave up')
    expect(container.querySelector('div div')).toBeNull()
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
    expect(container.textContent).toContain('<div> <div>')
  }, 30_000)

  it('is shown as plain text in the feed too', async () => {
    const html = await renderMarkdownToFeedHtml(nested, 'https://example.test/posts/x')

    expect(html).toContain('before')
    expect(html).toContain('after')
    expect(html).not.toContain('<div>')
  }, 30_000)
})

describe('a code fence that would cost the highlighter too much', () => {
  // Lines of one repeated letter, with no marker the parse budget prices: the parser reads the fence in one piece, and the TypeScript
  // grammar of Shiki takes the square of the line length for each line (200 ms for 2,000 characters, about 1.2 s for 5,000, and
  // twice that for the two themes). Before the limits of lib/blocks/highlight-budget.ts these ten lines took tens of seconds.
  const longLines = ('a'.repeat(5000) + '\n').repeat(10)

  it('is drawn without colour within seconds, with every character of the code in the page', async () => {
    const started = performance.now()
    const { content, problems } = await renderMarkdown('Before.\n\n```typescript\n' + longLines + '```\n\nAfter.')
    const { container } = render(<>{content}</>)

    expect(performance.now() - started).toBeLessThan(4_000)
    expect(problems).toEqual([])
    expect(container.querySelector('pre code')?.textContent).toBe(longLines.trimEnd())
    expect(screen.getByText('Before.')).toBeInTheDocument()
    expect(screen.getByText('After.')).toBeInTheDocument()
  }, 60_000)

  it('still highlights a block of ordinary lines, the same article after the long fence', async () => {
    const { content } = await renderMarkdown('```typescript\n' + longLines + '```\n\n```typescript\nconst answer = 42\n```\n')
    const { container } = render(<>{content}</>)

    const blocks = container.querySelectorAll('pre code')
    expect(blocks).toHaveLength(2)
    // `const` is a keyword of the grammar: it is a token of its own, with its own colour, unlike plain text.
    expect(blocks[1]?.querySelectorAll('span[style*="--shiki"]').length).toBeGreaterThan(2)
  }, 60_000)
})
