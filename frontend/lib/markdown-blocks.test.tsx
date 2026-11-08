import { IntlWrapper } from '@/test/intl'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from './markdown'
import { useBlockDoubles } from '@/test/block-doubles'
import { msg } from '@/test/render-intl'

const page = async (markdown: string) => {
  const result = await renderMarkdown(markdown)
  const view = render(<>{result.content}</>)
  return { ...result, ...view }
}
const feed = (markdown: string) => renderMarkdownToFeedHtml(markdown, 'https://blog.example/posts/bai-mau')

describe('renderMarkdown with blocks', () => {
  useBlockDoubles()

  it('draws a valid block through its component and keeps the Markdown inside it', async () => {
    const { container, problems } = await page(
      ':::callout{type=warning title="Careful"}\nDo **not** run this twice.\n:::\n\nAfter.',
    )

    const block = container.querySelector('[data-block="callout"]')
    expect(block).not.toBeNull()
    expect(block?.querySelector('strong')).toHaveTextContent('not')
    expect(block).toHaveTextContent('Do not run this twice.')
    expect(screen.getByText('After.')).toBeInTheDocument()
    expect(problems).toEqual([])
    // The markers and the attributes are not content.
    expect(container.textContent).not.toContain(':::')
    expect(container.textContent).not.toContain('warning')
    expect(container.querySelector('ai-block')).toBeNull()
  })

  it('nests blocks: steps around step, compare around pane, with Markdown, code and a figure inside', async () => {
    const markdown = [
      '::::steps{title="Install"}',
      ':::step{title="Get it"}',
      'Download the archive.',
      '',
      '```bash',
      'curl -O https://example.com/a.zip',
      '```',
      ':::',
      ':::step{title="Run it"}',
      '::figure{src="assets/run.png" alt="The terminal"}',
      ':::',
      '::::',
      '',
      '::::compare{variant=before-after}',
      ':::pane{title="Before"}',
      'Slow.',
      ':::',
      ':::pane{title="After"}',
      'Fast.',
      ':::',
      '::::',
    ].join('\n')
    const { container, problems } = await page(markdown)

    expect(problems).toEqual([])
    const steps = container.querySelector('[data-block="steps"]')!
    expect(steps.querySelectorAll(':scope > [data-block="step"]')).toHaveLength(2)
    expect(steps.querySelector('pre')).toHaveTextContent('curl -O https://example.com/a.zip')
    expect(container.querySelectorAll('[data-block="compare"] > [data-block="pane"]')).toHaveLength(2)
    const img = container.querySelector('[data-block="figure"] img')
    expect(img).toHaveAttribute('src', 'assets/run.png')
    expect(img).toHaveAttribute('alt', 'The terminal')
  })

  it('gives a figure the image rules of any Markdown image: size hint, lazy loading, async decoding', async () => {
    const { container } = await page(
      '::figure{src="/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#640x480" alt="A chart" caption="The chart"}',
    )

    const img = container.querySelector('[data-block="figure"] img')!
    expect(img).toHaveAttribute('src', '/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png')
    expect(img).toHaveAttribute('width', '640')
    expect(img).toHaveAttribute('height', '480')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
  })

  it('keeps the source of a diagram exactly as written and does not read it as Markdown', async () => {
    const source = '# a comment\ngraph TD\n  A[<b>Client</b>] --> B[Server]\n\n- not a list\n:::inner\n'
    const { container, toc, problems } = await page(`## Flow\n\n:::diagram{type=mermaid alt="Request flow"}\n${source}:::\n`)

    expect(problems).toEqual([])
    const body = container.querySelector('[data-block="diagram"] pre')!
    expect(body.textContent?.trim()).toBe(source.trim())
    // Nothing inside it became an element, a heading or a TOC entry.
    expect(container.querySelector('[data-block="diagram"] h1, [data-block="diagram"] ul, [data-block="diagram"] b')).toBeNull()
    expect(toc.map((entry) => entry.text)).toEqual(['Flow'])
  })

  it('gives a code fence title to the highlighted code, and none to a fence that has no title', async () => {
    const { container } = await page(
      '```java title="Hello.java"\nclass Hello {}\n```\n\n```text title="plain.txt"\nno highlighting\n```\n\n```java\nclass B {}\n```',
    )

    const pres = [...container.querySelectorAll('pre')]
    expect(pres).toHaveLength(3)
    expect(pres[0]).toHaveClass('shiki')
    expect(pres[0]).toHaveAttribute('data-title', 'Hello.java')
    expect(pres[1]).toHaveAttribute('data-title', 'plain.txt')
    expect(pres[2]).not.toHaveAttribute('data-title')
    // The title is not part of the code the copy button copies.
    expect(pres[0]!.textContent).toBe('class Hello {}')
  })

  it('draws an invalid or unknown block as its plain content and reports it', async () => {
    const markdown = [
      ':::callot{type=note}',
      'Typo in the name.',
      ':::',
      '',
      ':::callout{type=alert}',
      'Bad value.',
      ':::',
      '',
      '::unknown{a=1}',
      '',
      '::::steps',
      ':::step{title=A}',
      'Unclosed step.',
      '::::',
    ].join('\n')
    const { container, problems } = await page(markdown)

    expect(problems.map((p) => [p.line, p.code])).toEqual([
      [1, 'unknown-block'],
      [5, 'bad-attribute'],
      [9, 'unknown-block'],
      [12, 'unclosed-block'],
    ])
    // Nothing of the author's text is lost and no block component was used.
    for (const text of ['Typo in the name.', 'Bad value.', 'Unclosed step.']) expect(container.textContent).toContain(text)
    expect(container.textContent).toContain('::unknown{a=1}')
    expect(container.querySelector('[data-block]')).toBeNull()
  })

  it('a block with a heading inside is plain content, and the heading takes its place in the table of contents', async () => {
    const { container, toc, problems } = await page('## Before\n\n:::callout\nText.\n\n## Inside\n:::\n\n## After')

    expect(problems.map((p) => [p.line, p.code])).toEqual([[6, 'heading-in-block']])
    expect(container.querySelector('[data-block]')).toBeNull()
    expect(toc.map((entry) => entry.text)).toEqual(['Before', 'Inside', 'After'])
    for (const entry of toc) expect(container.querySelector(`#${CSS.escape(entry.id)}`)).not.toBeNull()
  })

  it('heading ids and the table of contents are the same with blocks around the headings as without them', async () => {
    const headings = '## One\n\ntext\n\n### Two\n\ntext\n\n## One\n\n#### Four\n\ntext'
    const plain = await renderMarkdown(headings)
    const withBlocks = await renderMarkdown(
      '## One\n\n:::callout\nA.\n:::\n\ntext\n\n### Two\n\n:::takeaways\n- x\n:::\n\ntext\n\n## One\n\n:::diagram{type=mermaid}\ngraph TD\n:::\n\n#### Four\n\ntext',
    )

    expect(withBlocks.toc).toEqual(plain.toc)
  })

  it('leaves prose with colons exactly as it was: no directive is made of times, ratios, emoji codes or words after a colon', async () => {
    const markdown = 'Meet at 10:30, ratio 3:2, Note:this and :smile: and `:::callout` inside code.\n\n## Ratio 3:2 heading'
    const { container, toc, problems } = await page(markdown)

    expect(problems).toEqual([])
    expect(container.querySelector('p')?.innerHTML).toBe(
      'Meet at 10:30, ratio 3:2, Note:this and :smile: and <code data-short="">:::callout</code> inside code.',
    )
    expect(toc[0]?.text).toBe('Ratio 3:2 heading')
    expect(toc[0]?.id).toBe('ratio-32-heading')
  })

  it('a text directive that looks like a block is reported and its text is kept', async () => {
    const { container, problems } = await page('Use :callout{type=note} for asides.')

    expect(problems.map((p) => p.code)).toEqual(['text-directive'])
    expect(container.querySelector('p')).toHaveTextContent('Use :callout{type=note} for asides.')
  })

  it('a raw <ai-block> typed into the Markdown draws nothing: it is literal text, and nothing it names is built', async () => {
    const markdown = [
      '<ai-block block="figure" src="javascript:alert(1)" alt="x"></ai-block>',
      '',
      '<div><ai-block block="callout" type="danger">forged</ai-block></div>',
      '',
      'Before <ai-block block="diagram">graph TD</ai-block> after.',
    ].join('\n')
    const { container, problems } = await page(markdown)

    expect(problems.map((p) => p.code)).toEqual(['reserved-tag', 'reserved-tag', 'reserved-tag'])
    expect(container.querySelector('ai-block')).toBeNull()
    expect(container.querySelector('[data-block], img, a')).toBeNull()
    expect(container.innerHTML).not.toContain('href')
  })

  it('does not change what a document with no directives renders', async () => {
    const { container } = await page(
      '# Title\n\nA paragraph with `code` and a [link](https://example.com).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    )

    expect(container.querySelector('[data-block]')).toBeNull()
    expect(container.querySelectorAll('h1, p, table')).toHaveLength(3)
  })

  it('hydrates a document with blocks with no recoverable error', async () => {
    const markdown = [
      '## Intro',
      '',
      ':::callout{type=tip}',
      'Cache it.',
      ':::',
      '',
      '::::steps',
      ':::step{title="One"}',
      'Do it.',
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
    ].join('\n')
    const { content } = await renderMarkdown(markdown)
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)
    document.body.append(host)

    const errors: unknown[] = []
    const root = hydrateRoot(host, <IntlWrapper>{content}</IntlWrapper>, { onRecoverableError: (error) => errors.push(error) })
    await act(async () => {})

    expect(errors).toEqual([])
    expect(host.querySelectorAll('[data-block]').length).toBeGreaterThanOrEqual(4)
    root.unmount()
    host.remove()
  })

  it('renders the same twice: the problems list does not carry over between calls', async () => {
    const first = await renderMarkdown(':::callot\nx\n:::')
    const second = await renderMarkdown('plain')

    expect(first.problems).toHaveLength(1)
    expect(second.problems).toEqual([])
  })
})

describe('renderMarkdownToFeedHtml with blocks', () => {
  it('rewrites each block to plain HTML a feed reader draws', async () => {
    const html = await feed(
      [
        ':::callout{type=warning title="Careful"}',
        'Do not run twice.',
        ':::',
        '',
        '::figure{src="assets/a.png" alt="A chart" caption="The chart" attribution="A. Author"}',
        '',
        ':::details{title="More" open}',
        'Hidden text.',
        ':::',
        '',
        ':::diagram{type=mermaid title="Flow" caption="How it flows"}',
        'graph TD',
        '  A --> B',
        ':::',
        '',
        '::::steps{title="Steps"}',
        ':::step{title="One"}',
        'First.',
        ':::',
        ':::step{title="Two"}',
        'Second.',
        ':::',
        '::::',
      ].join('\n'),
    )

    expect(html).not.toMatch(/ai-block|data-block|:::/)
    expect(html).toContain(
      '<blockquote><p><strong>Warning</strong></p><p><strong>Careful</strong></p><p>Do not run twice.</p></blockquote>',
    )
    expect(html).toMatch(
      /<figure><img [^>]*src="https:\/\/blog\.example\/posts\/assets\/a\.png"[^>]*><figcaption>The chart — A\. Author<\/figcaption><\/figure>/,
    )
    expect(html).toContain('<details open>')
    expect(html).toContain('<summary>More</summary>')
    expect(html).toContain('<pre><code class="language-mermaid">graph TD\n  A --> B</code></pre>')
    expect(html).toContain('<p><strong>Flow</strong></p>')
    expect(html).toContain('<p><em>How it flows</em></p>')
    expect(html).toContain(
      '<ol><li><p><strong>One</strong></p><p>First.</p></li><li><p><strong>Two</strong></p><p>Second.</p></li></ol>',
    )
  })

  it('compare becomes a sequence of titled sections, comparison keeps its table, code tabs become titled code blocks', async () => {
    const html = await feed(
      [
        '::::compare',
        ':::pane{title="Left"}',
        'One.',
        ':::',
        ':::pane{title="Right"}',
        'Two.',
        ':::',
        '::::',
        '',
        ':::comparison{title="Options"}',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        ':::',
        '',
        ':::code-tabs',
        '```python title="hello.py"',
        'print(1)',
        '```',
        '```bash title="Shell"',
        'echo 1',
        '```',
        ':::',
      ].join('\n'),
    )

    expect(html).toContain(
      '<section><p><strong>Left</strong></p><p>One.</p></section><section><p><strong>Right</strong></p><p>Two.</p></section>',
    )
    expect(html).toMatch(/<p><strong>Options<\/strong><\/p>\s*<table>/)
    expect(html).toContain('<p><strong>hello.py</strong></p><pre><code class="language-python">print(1)\n</code></pre>')
    expect(html).toContain('<p><strong>Shell</strong></p><pre><code class="language-bash">echo 1\n</code></pre>')
    expect(html).not.toMatch(/data-title|ai-block/)
  })

  it('an invalid block is plain content in the feed too, and a raw <ai-block> is escaped text', async () => {
    const html = await feed(':::callot\nKept text.\n:::\n\n<ai-block block="callout">x</ai-block>')

    expect(html).toContain('<p>Kept text.</p>')
    expect(html).not.toMatch(/<ai-block|<blockquote/)
    expect(html).toContain('&#x3C;ai-block')
  })
})

const GOLDEN_DOC = [
  '# Title',
  '',
  'Meet at 10:30, ratio 3:2, Note:this, :smile: and [a link](https://example.com/a:b) with `code`.',
  '',
  '## Section :two',
  '',
  '- one',
  '- [x] two',
  '',
  '> quote:text',
  '',
  '| a | b |',
  '| - | - |',
  '| 1:2 | x |',
  '',
  '![alt](/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png#64x48 "Caption")',
  '',
  '```text',
  'a:b',
  '```',
  '',
  'Footnote[^1].',
  '',
  '[^1]: The note.',
  '',
  '<div class="x">raw html</div>',
].join('\n')

/**
 * What the pipeline produced for GOLDEN_DOC before the block directives existed, recorded from the commit before this feature. Two things
 * were changed on purpose when the sanitizer stopped trusting the author: the `class="x"` an author wrote on the raw `div` is gone, and
 * the footnote label carries the `user-content-` prefix like every other id the sanitizer sees. Everything else is as recorded.
 */
const GOLDEN_HTML = [
  '<h1 id="title">Title<a class="heading-anchor" aria-hidden="true" tabindex="-1" href="#title"></a></h1>',
  '<p>Meet at 10:30, ratio 3:2, Note:this, :smile: and <a href="https://example.com/a:b">a link</a> with <code data-short="">code</code>.</p>',
  '<h2 id="section-two">Section :two<a class="heading-anchor" aria-hidden="true" tabindex="-1" href="#section-two"></a></h2>',
  '<ul class="contains-task-list">',
  '<li>one</li>',
  '<li class="task-list-item"><input type="checkbox" disabled="" checked=""/> two</li>',
  '</ul>',
  '<blockquote>',
  '<p>quote:text</p>',
  '</blockquote>',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  `<div class="table-scroll" role="region" tabindex="0" aria-label="${msg('Site.article.tableNamed', { label: 'a, b' })}"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1:2</td><td>x</td></tr></tbody></table></div>`,
  '<figure><img src="/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png" alt="alt" loading="lazy" decoding="async" width="64" height="48"/><figcaption>Caption</figcaption></figure>',
  `<div data-code-block="" class="relative"><pre class="shiki shiki-themes github-light github-dark" style="background-color:#fff;--shiki-dark-bg:#24292e;color:#24292e;--shiki-dark:#e1e4e8" tabindex="0"><code><span class="line"><span>a:b</span></span></code></pre><button type="button" aria-label="${msg('Site.code.copy')}" data-state="idle" class="absolute top-0 right-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-brand sm:h-8 sm:w-8 dark:text-neutral-400 dark:hover:bg-white/10 print:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand transition-colors duration-[120ms] motion-reduce:transition-none"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="h-4 w-4 shrink-0"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg></button><span role="status" aria-live="polite" class="sr-only"></span></div>`,
  '<p>Footnote<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref="" aria-describedby="user-content-footnote-label">1</a></sup>.</p>',
  '<div>raw html</div>',
  '<section data-footnotes="" class="footnotes"><h2 class="sr-only" id="user-content-footnote-label">Footnotes<a class="heading-anchor" aria-hidden="true" tabindex="-1" href="#user-content-footnote-label"></a></h2>',
  '<ol>',
  '<li id="user-content-fn-1">',
  '<p>The note. <a href="#user-content-fnref-1" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">↩</a></p>',
  '</li>',
  '</ol>',
  '</section>',
].join('\n')

const GOLDEN_FEED = [
  '<h1>Title</h1>',
  '<p>Meet at 10:30, ratio 3:2, Note:this, :smile: and <a href="https://example.com/a:b">a link</a> with <code>code</code>.</p>',
  '<h2>Section :two</h2>',
  '<ul class="contains-task-list">',
  '<li>one</li>',
  '<li class="task-list-item"><input type="checkbox" checked disabled> two</li>',
  '</ul>',
  '<blockquote>',
  '<p>quote:text</p>',
  '</blockquote>',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1:2</td><td>x</td></tr></tbody></table>',
  '<figure><img src="https://blog.example/media/0b5c3f1e-2d4a-4b6c-8d9e-0f1a2b3c4d5e.png" alt="alt" loading="lazy" decoding="async" width="64" height="48"><figcaption>Caption</figcaption></figure>',
  '<pre><code class="language-text">a:b',
  '</code></pre>',
  '<p>Footnote<sup><a href="https://blog.example/posts/p#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref="" aria-describedby="user-content-footnote-label">1</a></sup>.</p>',
  '<div>raw html</div>',
  '<section data-footnotes="" class="footnotes"><h2 class="sr-only" id="user-content-footnote-label">Footnotes</h2>',
  '<ol>',
  '<li id="user-content-fn-1">',
  '<p>The note. <a href="https://blog.example/posts/p#user-content-fnref-1" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">↩</a></p>',
  '</li>',
  '</ol>',
  '</section>',
].join('\n')

describe('a document with no directives', () => {
  it('renders byte for byte as it did before blocks existed, page and feed alike', async () => {
    const { content, toc, problems } = await renderMarkdown(GOLDEN_DOC)

    expect(problems).toEqual([])
    expect(renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)).toBe(GOLDEN_HTML)
    expect(toc).toEqual([{ depth: 2, id: 'section-two', text: 'Section :two' }])
    expect(await renderMarkdownToFeedHtml(GOLDEN_DOC, 'https://blog.example/posts/p')).toBe(GOLDEN_FEED)
  })
})

describe('a document nested too deeply for the block parser', () => {
  useBlockDoubles()

  // 2000 blocks that are never closed: the directive parser needs half a minute for this before the guard, and a few milliseconds without it.
  const HOSTILE = ':::callout\nx\n\n'.repeat(2000)
  const SECONDS = 2_000

  /**
   * The bounds below are relative to what the same text costs with nothing hostile in it, measured in the same run: a fixed second failed
   * under the load of the full suite (1.2 s for 2,000 paragraphs), and the cost the guard prevents is 30 s or more.
   */
  async function plainMs(markdown: string): Promise<number> {
    await renderMarkdown('warm up the highlighter')
    const reference = performance.now()
    // Every line with text becomes an ordinary line and the blank lines stay, so the paragraphs are as many as in the hostile text.
    await renderMarkdown(
      markdown
        .split('\n')
        .map((line) => (line.trim() === '' ? line : 'a plain line'))
        .join('\n'),
    )
    return performance.now() - reference
  }

  it(
    'reads the Markdown as plain content in about the time of a plain document and reports why, so one post cannot hold the server',
    async () => {
      const referenceMs = await plainMs(HOSTILE)

      const started = performance.now()
      const { content, problems } = await renderMarkdown(HOSTILE)
      const elapsed = performance.now() - started
      const { container } = render(<>{content}</>)

      expect(elapsed, `${Math.round(elapsed)} ms against ${Math.round(referenceMs)} ms for a plain document`).toBeLessThan(
        referenceMs * 3 + 500,
      )
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatchObject({ code: 'too-deep', line: 25 })
      expect(container.querySelector('[data-block]')).toBeNull()
      // The text is all there: the markers show as text, as any block that is not valid does.
      expect(container.textContent).toContain(':::callout')
      expect(container.querySelectorAll('p')).toHaveLength(2000)
    },
    SECONDS * 10,
  )

  it(
    'does the same in the feed, in plain HTML and without a block element',
    async () => {
      const started = performance.now()
      const html = await renderMarkdownToFeedHtml(HOSTILE, 'https://blog.example/posts/p')
      const elapsed = performance.now() - started

      expect(elapsed).toBeLessThan(1_000)
      expect(html).toContain('<p>:::callout')
      expect(html).not.toContain('ai-block')
    },
    SECONDS * 10,
  )

  it(
    'keeps the rest of the document as it is: Markdown, a code fence and a raw <ai-block> still go through the same checks',
    async () => {
      const markdown = [
        '## Title',
        '',
        '```js title="a.js"',
        'let a = 1',
        '```',
        '',
        '<ai-block block="callout"></ai-block>',
        '',
        HOSTILE,
      ].join('\n')
      const { container, toc, problems } = await page(markdown)

      expect(toc.map((entry) => entry.text)).toEqual(['Title'])
      expect(container.querySelector('pre.shiki')).not.toBeNull()
      expect(container.querySelector('ai-block')).toBeNull()
      expect(problems.map((problem) => problem.code)).toEqual(['reserved-tag', 'too-deep'])
      expect(problems.map((problem) => problem.line)).toEqual([...problems.map((problem) => problem.line)].sort((a, b) => a - b))
    },
    SECONDS * 10,
  )

  // The first version of the guard counted only blocks whose name starts with an ASCII letter. Each text below nests the parser a few hundred
  // levels deep in under 30 KB and keeps it busy for seconds when read with the directive syntax (measured on the real parser).
  const OTHER_WAYS = [
    ['a block whose name starts with a digit', ':::1\nx\n\n'.repeat(600)],
    ['a block whose name starts with a letter outside ASCII', `:::${String.fromCodePoint(0xe9)}\nx\n\n`.repeat(600)],
    [
      // 100 fences of 102 colons down to 3: the nesting guard answers, not the budget. Colons are priced for the directive parser
      // (lib/blocks/parse-budget.ts), and 300 such lines, 45,000 colons in one stretch, are refused there first.
      'a block whose name is a tab, each fence one colon shorter',
      Array.from({ length: 100 }, (_, index) => `${':'.repeat(102 - index)}\t`).join('\n'),
    ],
    [
      // 17 levels is one past the 16 a line may open behind a prefix, and 64 columns of indent, the 32 levels a line may sit in
      // (lib/blocks/parse-budget.ts): the nesting guard answers, not the budget.
      'blocks opened in footnote definitions',
      Array.from({ length: 17 }, (_, level) => `${' '.repeat(4 * level)}[^x]: :::callout`).join('\n'),
    ],
    ['real blocks hidden behind a line that is not a block', (':::a b\n' + '::::x\n'.repeat(7) + ':::\n').repeat(120)],
  ] as const

  it.each(OTHER_WAYS)(
    'reads %s as plain content in about the time of a plain document of as many lines',
    async (_name, markdown) => {
      const referenceMs = await plainMs(markdown)

      const started = performance.now()
      const { content, problems } = await renderMarkdown(markdown)
      const elapsed = performance.now() - started
      const { container } = render(<>{content}</>)

      expect(elapsed, `${Math.round(elapsed)} ms against ${Math.round(referenceMs)} ms for a plain document`).toBeLessThan(
        referenceMs * 3 + 500,
      )
      expect(problems.map((problem) => problem.code)).toEqual(['too-deep'])
      expect(container.querySelector('[data-block]')).toBeNull()
    },
    SECONDS * 10,
  )

  // Under the depth limits, and still slow: the parser checks every line against every block still open, so what it costs is (blocks
  // open) x (lines). Measured before the line-weighted budget on the real parser: 25 s for the first text, 4.8 s for the third.
  //
  // The third element is the problem that answers. A text of 100,000 non-blank lines is over the parse budget (lib/blocks/parse-budget.ts,
  // about 5,000 non-blank lines) before the nesting guard looks at it, and is read as plain text for that reason. Blank lines cost the
  // budget nothing, so the nesting guard still answers for them, and for the quote shape at sizes the budget lets in (the last two).
  const SHORT_LINES = [
    ['64 quoted blocks and 100000 lines of a bare quote marker', '> :::a\n'.repeat(64) + '>\n'.repeat(100_000), 'too-heavy'],
    ['16 quoted blocks and 100000 lines of a bare quote marker', '> :::a\n'.repeat(16) + '>\n'.repeat(100_000), 'too-heavy'],
    ['8 plain blocks and 200000 blank lines', ':::a\n'.repeat(8) + '\n'.repeat(200_000), 'too-deep'],
    ['2 plain blocks and 300000 blank lines', ':::a\n'.repeat(2) + '\n'.repeat(300_000), 'too-deep'],
    ['64 quoted blocks and 3000 lines of a bare quote marker', '> :::a\n'.repeat(64) + '>\n'.repeat(3_000), 'too-deep'],
    ['32 quoted blocks and 4000 lines of a bare quote marker', '> :::a\n'.repeat(32) + '>\n'.repeat(4_000), 'too-deep'],
  ] as const

  // The bound is relative to a reference measured in the same run, not a fixed second: the full suite runs a dozen jsdom workers at once, and
  // the same text takes twice as long there as alone (0.5 s alone, up to 2 s under load). The reference is a document of as many lines as
  // the heaviest hostile text with nothing in them and no directive at all, i.e. what the Markdown parser costs for those lines (not a
  // quote marker on each line: since the parse budget, that text is not given to the parser). The cost the guards prevent is 5 to 60 s,
  // ten times or more above the bound.
  it.each(SHORT_LINES)(
    'reads %s as plain content in about the time of a plain document of as many lines, although the lines are short',
    async (_name, markdown, answer) => {
      await renderMarkdown('warm up the highlighter')
      const reference = performance.now()
      await renderMarkdown('\n'.repeat(300_000))
      const plainMs = performance.now() - reference

      const started = performance.now()
      const { content, problems } = await renderMarkdown(markdown)
      const elapsed = performance.now() - started
      const { container } = render(<>{content}</>)

      expect(problems.map((problem) => problem.code)).toEqual([answer])
      expect(container.querySelector('[data-block]')).toBeNull()
      expect(elapsed, `${Math.round(elapsed)} ms against ${Math.round(plainMs)} ms for a plain document`).toBeLessThan(
        plainMs * 3 + 500,
      )
    },
    SECONDS * 30,
  )

  it('reads footnote definitions nested a hundred levels deep as plain text for the container depth of the parse budget, before the nesting guard', async () => {
    const markdown = Array.from({ length: 120 }, (_, level) => `${' '.repeat(4 * level)}[^x]: :::callout`).join('\n')
    // The bound is relative to a plain document of as many lines measured in the same run, like the cases above: a fixed second failed
    // under the load of the full suite.
    await renderMarkdown('warm up the highlighter')
    const reference = performance.now()
    await renderMarkdown(Array.from({ length: 120 }, () => 'a plain line').join('\n'))
    const plainMs = performance.now() - reference
    const started = performance.now()
    const { content, problems } = await renderMarkdown(markdown)
    const elapsed = performance.now() - started
    const { container } = render(<>{content}</>)

    expect(elapsed, `${Math.round(elapsed)} ms against ${Math.round(plainMs)} ms for a plain document`).toBeLessThan(
      plainMs * 3 + 500,
    )
    expect(problems.map((problem) => problem.code)).toEqual(['too-heavy'])
    expect(problems[0]?.message).toContain('nested too deeply')
    expect(container.querySelector('[data-block]')).toBeNull()
    expect(container.textContent).toContain(':::callout')
  })

  it('does not touch a document whose blocks are nested as the registry asks', async () => {
    const markdown = ['::::steps{title="Install"}', ':::step{title="Get it"}', 'Download it.', ':::', '::::'].join('\n')
    const { container, problems } = await page(markdown)

    expect(problems).toEqual([])
    expect(container.querySelector('[data-block="steps"]')).not.toBeNull()
  })
})
