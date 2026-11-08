import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from './markdown'

/**
 * The fence features of the pipeline that are not blocks: the line highlight (`highlight="2,5-7"`) and the `diff` language. The
 * highlight is read by the block syntax step, carried through the sanitize step and the highlighter, and ends as `data-highlighted` on
 * the lines; the code panel (`components/site/CodeBlock.tsx`) draws them.
 */

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

async function page(markdown: string) {
  const result = await renderMarkdown(markdown)
  const view = render(<>{result.content}</>)
  return { ...result, ...view }
}

const lineTexts = (elements: Iterable<Element>) => [...elements].map((line) => line.textContent)

describe('a code fence with a highlight', () => {
  it('marks exactly the lines it names, and keeps the title and the code as they were', async () => {
    const { container, problems } = await page('```yaml title="limits.yaml" highlight="2,5-7"\n' + YAML + '\n```')

    const pre = container.querySelector('pre.shiki')
    expect(problems).toEqual([])
    expect(pre).toHaveAttribute('data-title', 'limits.yaml')
    expect(pre).toHaveAttribute('data-highlight', '2,5-7')
    expect(lineTexts(container.querySelectorAll('pre code .line[data-highlighted]'))).toEqual([
      '  retries: 5',
      '  name: default',
      '  depth: 5000',
      '  rate: 100',
    ])
    expect(container.querySelectorAll('pre code .line')).toHaveLength(8)
    // What the copy button copies is the code of the pre, and nothing of the meta text.
    expect(pre?.textContent).toBe(YAML)
  })

  it('marks a line on a fence with no title, and the title does not need the highlight', async () => {
    const { container } = await page('```yaml highlight=1\n' + YAML + '\n```\n\n```yaml title="t.yaml"\n' + YAML + '\n```')

    const [highlighted, titled] = [...container.querySelectorAll('pre.shiki')]
    expect(highlighted).toHaveAttribute('data-highlight', '1')
    expect(highlighted).not.toHaveAttribute('data-title')
    expect(highlighted!.querySelectorAll('.line[data-highlighted]')).toHaveLength(1)
    expect(titled).toHaveAttribute('data-title', 't.yaml')
    expect(titled).not.toHaveAttribute('data-highlight')
    expect(titled!.querySelectorAll('[data-highlighted]')).toHaveLength(0)
  })

  it('highlights a fence of a language that is not listed too, because it is drawn as text', async () => {
    const { container, problems } = await page('```kotlin highlight="2"\nfun a() {}\nfun b() {}\n```')

    expect(problems).toEqual([])
    expect(lineTexts(container.querySelectorAll('.line[data-highlighted]'))).toEqual(['fun b() {}'])
  })

  it('works on a tab of a code-tabs block', async () => {
    const { container, problems } = await page(
      [':::code-tabs', '```yaml title="A" highlight="1"', YAML, '```', '```yaml title="B"', YAML, '```', ':::'].join('\n'),
    )

    expect(problems).toEqual([])
    expect(container.querySelectorAll('[data-highlighted]')).toHaveLength(1)
  })

  it('draws the code without a highlight it cannot use, and reports it', async () => {
    for (const meta of ['highlight="5,2"', 'highlight="9"', 'highlight="x"', 'highlight=""']) {
      const { container, problems, unmount } = await page('```yaml ' + meta + '\n' + YAML + '\n```')

      expect(
        problems.map((problem) => problem.code),
        meta,
      ).toEqual(['bad-fence-highlight'])
      expect(container.querySelector('pre.shiki'), meta).not.toHaveAttribute('data-highlight')
      expect(container.querySelectorAll('[data-highlighted]'), meta).toHaveLength(0)
      unmount()
    }
  })

  it('lets a fence of HTML carry a highlight, and only one the rules accept', async () => {
    const html = (value: string) => `<pre><code class="language-yaml" data-highlight="${value}">${YAML}</code></pre>`

    const good = await page(html('2'))
    expect(good.container.querySelectorAll('.line[data-highlighted]')).toHaveLength(1)
    good.unmount()

    const bad = await page(html('7,2'))
    expect(bad.container.querySelector('pre.shiki')).not.toHaveAttribute('data-highlight')
    expect(bad.container.querySelectorAll('[data-highlighted]')).toHaveLength(0)
  })

  it('is left out of the feed, where the code is shown as it is', async () => {
    const html = await renderMarkdownToFeedHtml(
      '```yaml title="limits.yaml" highlight="2"\n' + YAML + '\n```',
      'https://blog.example/posts/a',
    )

    expect(html).toContain('<p><strong>limits.yaml</strong></p><pre><code class="language-yaml">')
    expect(html).not.toMatch(/highlight/i)
  })
})

describe('a diff fence', () => {
  const diff = ['@@ -1,4 +1,4 @@', ' limits:', '-  retries: 50', '+  retries: 5', '   timeout: 30s'].join('\n')

  it('colours added and removed lines apart from each other and from the rest, and keeps the + and - in the text', async () => {
    const { container } = await page('```diff title="deploy.yaml"\n' + diff + '\n```')

    const lines = [...container.querySelectorAll('pre code .line')]
    expect(lines.map((line) => line.textContent)).toEqual(diff.split('\n'))
    // Every token is coloured for both themes through the github themes, so the colours follow the theme of the page.
    const styleOf = (line: Element) =>
      [...new Set([...line.querySelectorAll('span')].map((span) => span.getAttribute('style')))].join('|')
    const [, context, removed, added] = lines.map(styleOf)
    expect(removed).toMatch(/(?:^|[ ;])color: ?(?:rgb\(|#)/)
    expect(removed).toMatch(/--shiki-dark: ?#[0-9a-f]{6}/i)
    expect(added).toMatch(/(?:^|[ ;])color: ?(?:rgb\(|#)/)
    expect(new Set([context, removed, added]).size).toBe(3)
  })
})

describe('the languages of round two', () => {
  it.each([
    ['diff', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'],
    ['shellsession', '$ npm install\nadded 1 package\n$ npm test'],
    ['go', 'package main\n\nfunc main() { println("hi") }'],
    ['rust', 'fn main() { let x: u32 = 1; println!("{}", x); }'],
    ['html', '<div class="a"><p>Hi</p></div>'],
    ['css', 'a { color: red; margin: 0 auto; }'],
    ['dockerfile', 'FROM node:22\nRUN npm ci\nCMD ["node", "index.js"]'],
    ['toml', '[server]\nport = 8080\nname = "relay"'],
    ['markdown', '# Title\n\n- **bold** and `code`'],
    ['ini', '[core]\nname = relay\nretries = 5'],
  ])('highlights %s', async (language, code) => {
    const { container } = await page('```' + language + '\n' + code + '\n```')

    // An unlisted language is drawn as text and has no coloured token at all (see markdown.test.tsx), so any colour proves the grammar.
    const coloured = [...container.querySelectorAll('pre.shiki code span')].filter((span) =>
      (span.getAttribute('style') ?? '').includes('color:'),
    )
    expect(coloured.length, language).toBeGreaterThan(2)
  })
})
