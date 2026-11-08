// frontend/lib/markdown.test.tsx
import { IntlWrapper } from '@/test/intl'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TABLE_SCROLL_CLASS, renderMarkdown, renderMarkdownToFeedHtml } from './markdown'
import { RESERVED_PAGE_IDS } from './page-ids'
import { tocHref } from './toc'
import { msg } from '@/test/render-intl'
import { SLUG_DAT_VAN_DE } from '@/test/fixtures/vi/accented-text'
import { HEADING_DAT_LOWER, HEADING_DAT_VAN_DE, PARAGRAPH_DIACRITICS } from '@/test/fixtures/vi/markdown-vi'

describe('renderMarkdown', () => {
  it('renders headings and paragraphs', async () => {
    const { content } = await renderMarkdown('# ' + msg('Admin.editor.titleLabel') + '\n\nA paragraph.')
    render(<>{content}</>)

    expect(screen.getByRole('heading', { level: 1, name: msg('Admin.editor.titleLabel') })).toBeInTheDocument()
    expect(screen.getByText('A paragraph.')).toBeInTheDocument()
  })

  it('preserves Vietnamese diacritics byte-exactly', async () => {
    const { content } = await renderMarkdown(PARAGRAPH_DIACRITICS)
    render(<>{content}</>)

    expect(screen.getByText(PARAGRAPH_DIACRITICS)).toBeInTheDocument()
  })

  it('extracts a table of contents whose ids match the rendered headings', async () => {
    const { content, toc } = await renderMarkdown(`## ${HEADING_DAT_VAN_DE}\n\nx\n\n### Details\n\ny`)
    const { container } = render(<>{content}</>)

    expect(toc.map((t) => ({ depth: t.depth, text: t.text }))).toEqual([
      { depth: 2, text: HEADING_DAT_VAN_DE },
      { depth: 3, text: 'Details' },
    ])

    for (const entry of toc) {
      expect(container.querySelector(`#${CSS.escape(entry.id)}`)).not.toBeNull()
    }
  })

  it('headings with the same text get different ids, and each TOC href points at its own heading in the DOM', async () => {
    const ABOUT = msg('Site.footer.links.about')
    const { content, toc } = await renderMarkdown(
      `## ${ABOUT}\n\nA.\n\n### ${ABOUT}\n\nB.\n\n## ${ABOUT}\n\nC.\n\n## 1. ${ABOUT}\n\nD.`,
    )
    const { container } = render(<>{content}</>)
    const headings = [...container.querySelectorAll('h2, h3, h4')]

    expect(toc.map((t) => t.text)).toEqual([
      msg('Site.footer.links.about'),
      msg('Site.footer.links.about'),
      msg('Site.footer.links.about'),
      `1. ${ABOUT}`,
    ])
    expect(new Set(toc.map((t) => t.id)).size).toBe(4)
    expect(toc.map((t) => t.id)).toEqual(headings.map((h) => h.id))
    // Follow the browser's path: percent-encoded href → decode → getElementById (an id may start with a digit).
    toc.forEach((entry, index) => {
      expect(document.getElementById(decodeURIComponent(tocHref(entry.id).slice(1))), entry.id).toBe(headings[index])
    })
  })

  it('normalizes decomposed heading text so ids are stable', async () => {
    const composed = await renderMarkdown(`## ${HEADING_DAT_VAN_DE}`)
    const decomposed = await renderMarkdown(`## ${HEADING_DAT_VAN_DE}`.normalize('NFD'))

    expect(decomposed.toc[0].id).toBe(composed.toc[0].id)
  })

  it('highlights a fenced code block', async () => {
    const { content } = await renderMarkdown('```java\nclass A {}\n```')
    const { container } = render(<>{content}</>)

    expect(container.querySelector('pre.shiki')).not.toBeNull()
  })

  it('strips a script tag the author typed into the Markdown', async () => {
    const { content } = await renderMarkdown('Before<script>alert(1)</script>after')
    const { container } = render(<>{content}</>)

    expect(container.querySelector('script')).toBeNull()
  })

  it('renders a fenced block in an unlisted language as plain text rather than failing', async () => {
    const { content } = await renderMarkdown('```rust\nfn main() {}\n```')
    const { container } = render(<>{content}</>)

    expect(container.querySelector('pre')).not.toBeNull()
  })
})

/**
 * A naive suite asserts a `<script>` is absent. An absence assertion is worthless
 * unless something proves the selector could have matched, so every absence below was
 * first run against this exact pipeline with `rehypeSanitize` removed: each selector
 * matched there and matches nothing here. Two traps found while establishing that, and
 * deliberately NOT asserted on because the assertion would be vacuous:
 *   - `onerror="alert(1)"` never reaches the DOM even unsanitized — React drops string
 *     event handlers itself, so `getAttribute('onerror')` is null either way.
 *   - a `javascript:` href is *also* neutered by React (rewritten to a throwing URL),
 *     so only the attribute's absence — not its value — distinguishes the sanitizer.
 */
describe('renderMarkdown sanitization', () => {
  it('drops the script and its source while still rendering the text around it', async () => {
    const { content } = await renderMarkdown('Before<script>alert(1)</script>after')
    const { container } = render(<>{content}</>)

    // Positive control: the container is not empty, so the null below means removed.
    expect(container.textContent).toBe('Beforeafter')
    expect(container.querySelector('script')).toBeNull()
  })

  it('strips embedding and styling elements an author typed as raw HTML', async () => {
    const { content } = await renderMarkdown(
      [
        'keep me',
        '<iframe src="https://evil.example"></iframe>',
        '<style>body{display:none}</style>',
        '<object data="x.swf"></object>',
        '<embed src="y.swf">',
        '<form action="/x"><b>b</b></form>',
      ].join('\n\n'),
    )
    const { container } = render(<>{content}</>)

    expect(screen.getByText('keep me')).toBeInTheDocument()
    for (const selector of ['iframe', 'style', 'object', 'embed', 'form']) {
      expect(container.querySelector(selector)).toBeNull()
    }

    // Removing the tag is not enough for <style>. Unknown elements are unwrapped rather
    // than deleted, so the CSS survived as prose and rendered in the middle of the
    // article. The <b> from inside the <form> is the control: that text SHOULD survive
    // unwrapping, which is what makes the assertion above it a real one.
    expect(container.textContent).not.toContain('display:none')
    expect(screen.getByText('b')).toBeInTheDocument()
  })

  it('strips an SVG carrying an embedded script', async () => {
    const { content } = await renderMarkdown('keep me\n\n<svg><script>alert(1)</script><circle r="5"/></svg>')
    const { container } = render(<>{content}</>)

    expect(screen.getByText('keep me')).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('removes a javascript: href but keeps the link text', async () => {
    const { content } = await renderMarkdown('[click here](javascript:alert(1))')
    const { container } = render(<>{content}</>)

    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor).toHaveTextContent('click here')
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('removes target="_blank" instead of leaving it without rel', async () => {
    const { content } = await renderMarkdown('<a href="https://x.example" target="_blank">link</a>')
    const { container } = render(<>{content}</>)

    const anchor = container.querySelector('a')
    // Positive control: the safe half of the same element survived.
    expect(anchor?.getAttribute('href')).toBe('https://x.example')
    expect(anchor?.getAttribute('target')).toBeNull()
  })

  // The class an author writes is untrusted: a Tailwind utility that exists in the compiled stylesheet (`fixed inset-0 z-50`) can
  // cover the whole viewport on a public page and in the admin preview. The old test of this name asserted the opposite
  // (`div.note` survived); it encoded the bug and is replaced by its inverse.
  it('drops the class an author writes on any element, so a utility class cannot lay content over the page', async () => {
    const { content } = await renderMarkdown(
      [
        '<div class="fixed inset-x-0 top-0 z-50 min-h-dvh bg-white"><a class="fixed inset-x-0 top-0 z-50" href="https://x.example">x</a></div>',
        '<span class="fixed inset-0">span</span>',
        '<p class="fixed inset-0">paragraph</p>',
        '<h3 class="fixed inset-0">heading</h3>',
        '<blockquote class="fixed inset-0">quote</blockquote>',
        '<img class="fixed inset-0" src="/images/a.png" alt="a">',
        '<pre class="fixed inset-0">pre</pre>',
        '<table class="fixed inset-0"><tr><td class="fixed">cell</td></tr></table>',
      ].join('\n\n'),
    )
    const { container } = render(<>{content}</>)

    // Positive control: the safe half of the same elements survived, so the markup was parsed and kept.
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://x.example')
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.querySelectorAll('td')).toHaveLength(1)
    // No element the author wrote carries a class attribute at all, not even an empty one.
    const written = [
      screen.getByText('span'),
      screen.getByText('paragraph'),
      screen.getByRole('heading', { level: 3, name: 'heading' }),
      screen.getByText('quote'),
      screen.getByText('cell'),
      container.querySelector('a[href="https://x.example"]'),
      container.querySelector('a[href="https://x.example"]')?.parentElement,
      container.querySelector('img'),
      container.querySelector('table'),
    ]
    for (const element of written) {
      expect(element).not.toBeNull()
      expect(element).not.toHaveAttribute('class')
    }
    // What the pipeline adds itself is still there (the frame around the table), and none of the author's tokens is.
    expect(container.querySelector('table')?.parentElement).toHaveClass(TABLE_SCROLL_CLASS)
    expect(container.innerHTML).not.toMatch(/fixed|inset-0|inset-x-0|z-50|min-h-dvh/)
  })

  it('keeps only the exact classes the renderer needs: language-* on code, the GFM task list and footnote classes', async () => {
    const feed = await renderMarkdownToFeedHtml(
      [
        '<code class="language-java fixed inset-0">a</code>',
        '<code class="language-x y">b</code>',
        '<ul class="contains-task-list fixed"><li class="task-list-item fixed">c</li></ul>',
        '<section class="footnotes fixed" data-footnotes><h2 class="sr-only fixed">d</h2></section>',
        '<a class="data-footnote-backref fixed" href="#x">e</a>',
        '<ol class="fixed"><li class="fixed">f</li></ol>',
      ].join('\n\n'),
      'https://blog.example/posts/a',
    )

    // The feed is HTML text; read it back as a DOM so the check does not depend on the order of attributes.
    const dom = document.createElement('div')
    dom.innerHTML = feed
    const classOf = (selector: string) => dom.querySelector(selector)?.getAttribute('class') ?? null
    expect(classOf('code:nth-of-type(1)')).toBe('language-java')
    expect(dom.querySelectorAll('code')[1]?.getAttribute('class')).toBe('language-x')
    expect(classOf('ul')).toBe('contains-task-list')
    expect(classOf('ul > li')).toBe('task-list-item')
    expect(classOf('section')).toBe('footnotes')
    expect(classOf('section > h2')).toBe('sr-only')
    expect(classOf('a')).toBe('data-footnote-backref')
    expect(classOf('ol')).toBeNull()
    expect(classOf('ol > li')).toBeNull()
    expect(feed).not.toMatch(/fixed|inset-0/)
  })

  it('still gives a fenced code block its language class before Shiki, and a task list its classes', async () => {
    const feed = await renderMarkdownToFeedHtml(
      '```java\nclass A {}\n```\n\n- [x] done\n- [ ] open',
      'https://blog.example/posts/a',
    )

    expect(feed).toContain('<code class="language-java">')
    expect(feed).toContain('<ul class="contains-task-list">')
    expect(feed).toContain('<li class="task-list-item">')
  })

  // `id` and `name` of author HTML name properties of `document` and `window` ("DOM clobbering"): `<img name="currentScript">` makes
  // `document.currentScript` an element, which breaks the bootstrap code of Next and the `getElementById` calls of the site. The
  // default schema prefixes them with `user-content-`; the pipeline had turned that off.
  it('prefixes the id and name an author writes, so they cannot shadow a property of document or window', async () => {
    const { content } = await renderMarkdown(
      [
        '<img id="getElementById" name="getElementById" src="/images/a.png" alt="a">',
        '<img name="currentScript" src="/images/b.png" alt="b">',
        '<a name="currentScript" id="main-content">anchor</a>',
        '<form name="currentScript"><input name="getElementById"></form>',
        '<p id="search-input">text</p>',
      ].join('\n\n'),
    )
    const { container } = render(<>{content}</>)

    // Positive control: the elements are there, with their prefixed identifiers.
    const first = container.querySelector('img')
    expect(first?.getAttribute('id')).toBe('user-content-getElementById')
    expect(first?.getAttribute('name')).toBe('user-content-getElementById')
    expect(container.querySelector('img[name="user-content-currentScript"]')).not.toBeNull()
    expect(container.querySelector('a[id="user-content-main-content"]')).not.toBeNull()
    // No identifier an author wrote is left bare.
    for (const bare of ['getElementById', 'currentScript', 'main-content', 'search-input']) {
      expect(container.querySelector(`[id="${bare}"], [name="${bare}"]`), bare).toBeNull()
      expect(document.getElementById(bare), bare).toBeNull()
    }
    const identified = [...container.querySelectorAll('[id], [name]')]
    expect(identified.length).toBeGreaterThan(0)
    for (const element of identified) {
      expect(element.getAttribute('id') ?? element.getAttribute('name')).toMatch(/^user-content-/)
    }
  })

  // The ids of the headings are made by rehype-slug AFTER the sanitizer, so the prefix above does not reach them. github-slugger keeps
  // `_`, so `## __next_f` came out as `<h2 id="__next_f">`; the post is in the first HTML chunk and Next's flight script runs
  // `self.__next_f = self.__next_f || []` after it, finds the heading through the named access of `window` and throws, so the page never
  // hydrated. `## search q` made `id="search-q"`, the id the "/" shortcut of the header looks up. Both now get the prefix; every other
  // slug is left alone, so the public URLs of the headings do not change.
  describe('heading ids that could shadow the page', () => {
    const render_ = async (markdown: string) => {
      const { content, toc } = await renderMarkdown(markdown)
      const { container } = render(<>{content}</>)
      return { container, toc }
    }

    it('prefixes a slug that starts with an underscore or equals a fixed id of the page', async () => {
      const { container, toc } = await render_('## __next_f\n\n## search q\n\n## main content\n\n## Plain heading')

      // Positive control: the headings are there, under their prefixed ids, and an ordinary slug is untouched.
      const ids = [...container.querySelectorAll('h2')].map((heading) => heading.getAttribute('id'))
      expect(ids).toEqual(['user-content-__next_f', 'user-content-search-q', 'user-content-main-content', 'plain-heading'])
      for (const bare of ['__next_f', 'search-q', 'main-content']) {
        expect(container.querySelector(`[id="${bare}"], [name="${bare}"]`), bare).toBeNull()
        expect(document.getElementById(bare), bare).toBeNull()
      }
      // The table of contents and the anchor of each heading follow the rewritten id.
      expect(toc.map((entry) => entry.id)).toEqual(ids)
      for (const heading of container.querySelectorAll('h2')) {
        expect(heading.querySelector('a.heading-anchor')?.getAttribute('href')).toBe(`#${heading.getAttribute('id')}`)
      }
    })

    it('covers every fixed id the pages look up, at every heading level', async () => {
      const markdown = RESERVED_PAGE_IDS.map((id, index) => `${'#'.repeat((index % 6) + 1)} ${id.replaceAll('-', ' ')}`).join(
        '\n\n',
      )
      const { container } = await render_(markdown)

      for (const id of RESERVED_PAGE_IDS) expect(container.querySelector(`[id="${id}"]`), id).toBeNull()
      expect(container.querySelectorAll('[id^="user-content-"]')).toHaveLength(RESERVED_PAGE_IDS.length)
    })

    it('keeps the slug of an ordinary heading, with its duplicate suffix', async () => {
      const { container } = await render_('## Setup\n\n## Setup\n\n## _private\n\n## search q\n\n## search q')

      expect([...container.querySelectorAll('h2')].map((heading) => heading.getAttribute('id'))).toEqual([
        'setup',
        'setup-1',
        'user-content-_private',
        'user-content-search-q',
        'search-q-1',
      ])
    })

    it('does not give two headings the same id when the prefixed slug is already taken', async () => {
      const { container, toc } = await render_('## user-content-__next_f\n\n## __next_f\n\n## __next_f')

      const ids = [...container.querySelectorAll('h2')].map((heading) => heading.getAttribute('id'))
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.every((id) => id?.startsWith('user-content-'))).toBe(true)
      expect(toc.map((entry) => entry.id)).toEqual(ids)
    })
  })
})

describe('renderMarkdown highlighting', () => {
  const colouredTokens = (container: HTMLElement) =>
    [...container.querySelectorAll('pre.shiki code span')].filter((span) => (span.getAttribute('style') ?? '').includes('color:'))
      .length

  it('colours individual tokens, not merely the pre wrapper', async () => {
    const { content } = await renderMarkdown('```java\npublic class A { int x = 1; }\n```')
    const { container } = render(<>{content}</>)

    // `pre.shiki` existing proves the plugin ran; it does not prove anything is
    // highlighted. Per-token inline colours do.
    expect(container.querySelector('pre.shiki')).not.toBeNull()
    expect(colouredTokens(container)).toBeGreaterThan(2)
  })

  it('renders an unlisted language uncoloured, with its source intact', async () => {
    const { content } = await renderMarkdown('```kotlin\nfun main() {}\n```')
    const { container } = render(<>{content}</>)

    // fallbackLanguage: 'text' — Shiki neither throws nor tokenizes. The block keeps
    // the theme's background and foreground but gains no token colours, which is also
    // the negative control for the assertion above.
    expect(container.querySelector('pre.shiki')).not.toBeNull()
    expect(container.querySelector('code')).toHaveTextContent('fun main() {}')
    expect(colouredTokens(container)).toBe(0)
  })
})

/**
 * Everything below was added after a review pass. Each test names the mutant it
 * kills, because every one of these invariants was previously held by nothing.
 */
describe('renderMarkdown structure', () => {
  it('does not nest anchors when a heading contains a link', async () => {
    const { content } = await renderMarkdown('## [link](https://example.com)')
    const ssr = renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)

    // The real failure this guards is a hydration mismatch, and the mechanism is that
    // <a><a>…</a></a> is invalid HTML: the browser's parser re-nests it into siblings,
    // so the DOM the client builds from the SSR string differs from the tree React
    // expects. Parsing the SSR markup and comparing is the cheapest way to see it.
    const host = document.createElement('div')
    host.innerHTML = ssr

    expect(host.querySelector('a a')).toBeNull()
    expect(host.innerHTML).toBe(ssr)

    // And the heading's own link still works, rather than being swallowed by a wrapper.
    expect(host.querySelector('a[href="https://example.com"]')).toHaveTextContent('link')
  })

  it('hydrates a heading containing a link with no recoverable error', async () => {
    // The assertion above is structural; this is the thing itself. `behavior: 'wrap'`
    // produces "Hydration failed because the server rendered HTML didn't match the
    // client" here, and a plain heading is the control that proves the harness works.
    for (const md of ['## [link](https://example.com)', `## ${HEADING_DAT_VAN_DE}`]) {
      const { content } = await renderMarkdown(md)
      const host = document.createElement('div')
      host.innerHTML = renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)
      document.body.append(host)

      const errors: unknown[] = []
      const root = hydrateRoot(host, <IntlWrapper>{content}</IntlWrapper>, {
        onRecoverableError: (error) => errors.push(error),
      })
      await act(async () => {})

      expect(errors, md).toEqual([])
      root.unmount()
      host.remove()
    }
  })

  it('appends an anchor to each heading, with an accessible name', async () => {
    // Kills "remove rehypeAutolinkHeadings" and "wrap instead of append", both of
    // which the original suite let through.
    const { content } = await renderMarkdown(`## ${HEADING_DAT_VAN_DE}`)
    const { container } = render(<>{content}</>)

    const anchor = container.querySelector('h2 > a.heading-anchor')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBe(`#${SLUG_DAT_VAN_DE}`)
    // Decorative on purpose: see the comment on the plugin options. Both of these
    // matter — without them the heading's accessible name picks up the anchor's,
    // and the anchor joins the tab order on every heading in the article.
    expect(anchor?.getAttribute('aria-hidden')).toBe('true')
    expect(anchor?.getAttribute('tabindex')).toBe('-1')
    // And the heading's own name stays clean, which is what actually broke first.
    expect(screen.getByRole('heading', { level: 2, name: HEADING_DAT_VAN_DE })).toBeInTheDocument()
  })

  it('keeps footnotes working and off the table of contents', async () => {
    const { content, toc } = await renderMarkdown('A sentence[^1]\n\n[^1]: A note.')
    const { container } = render(<>{content}</>)

    // remark-gfm appends its own <h2 id="footnote-label">Footnotes</h2>, so before this
    // every post with a footnote grew a phantom, visually-hidden TOC entry.
    expect(toc).toEqual([])

    // And the reference must still resolve, with exactly ONE `user-content-` prefix. remark-gfm's ids are already prefixed, so the
    // sanitizer's own prefix would make them `user-content-user-content-fn-1` while the link still says #user-content-fn-1; a step
    // after sanitize folds the double prefix back. The back link goes the same way.
    const target = container.querySelector('a[href^="#"]')?.getAttribute('href')?.slice(1)
    expect(target).toBe('user-content-fn-1')
    expect(container.querySelector('[id="' + target + '"]')).not.toBeNull()
    const reference = container.querySelector('a[data-footnote-ref]')
    expect(reference?.getAttribute('id')).toBe('user-content-fnref-1')
    expect(container.querySelector('a[data-footnote-backref]')?.getAttribute('href')).toBe('#user-content-fnref-1')
    expect(container.querySelector('[id^="user-content-user-content-"]')).toBeNull()
    // The label that describes the reference is prefixed once as well, on both sides.
    expect(reference?.getAttribute('aria-describedby')).toBe('user-content-footnote-label')
    expect(container.querySelector('section.footnotes[data-footnotes] > h2.sr-only#user-content-footnote-label')).not.toBeNull()
  })

  it('renders GFM tables, strikethrough and task lists', async () => {
    // Kills "remove remarkGfm". The pipeline advertises GFM and nothing exercised it,
    // so a post with a table would have degraded to plain text with a green suite.
    const { content } = await renderMarkdown('| Column | Value |\n| --- | --- |\n| a | 1 |\n\n~~removed~~\n\n- [x] done')
    const { container } = render(<>{content}</>)

    expect(container.querySelector('table td')).not.toBeNull()
    expect(container.querySelector('del')).toHaveTextContent('removed')
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
  })

  it('wraps each table in a named horizontal scroll container that is keyboard focusable', async () => {
    // A table wider than the text column (a cell with unbreakable inline code) used to push the whole
    // page into horizontal scroll at 320px. A dedicated wrapper scrolls instead of the page; role + name +
    // tabIndex let the keyboard and screen readers reach it.
    const { content } = await renderMarkdown(
      '| Command | Meaning |\n| --- | --- |\n| `getent hosts $HOST` | DNS lookup |\n\nMiddle paragraph.\n\n|   |   |\n| --- | --- |\n| a | b |',
    )
    const { container } = render(<>{content}</>)

    const tables = container.querySelectorAll('table')
    expect(tables).toHaveLength(2)
    for (const table of tables) {
      const frame = table.parentElement!
      expect(frame.tagName).toBe('DIV')
      expect(frame).toHaveClass(TABLE_SCROLL_CLASS)
      expect(frame).toHaveAttribute('role', 'region')
      expect(frame).toHaveAttribute('tabindex', '0')
    }
    // The name is the header cells; a table with no header text is numbered.
    expect(screen.getByRole('region', { name: msg('Site.article.tableNamed', { label: 'Command, Meaning' }) })).toContainElement(
      tables[0]!,
    )
    expect(screen.getByRole('region', { name: msg('Site.article.tableNumbered', { n: '2' }) })).toContainElement(tables[1]!)
    // A table is still a table: display unchanged, row/column semantics kept.
    expect(screen.getAllByRole('table')).toHaveLength(2)
    expect(screen.getByRole('columnheader', { name: 'Command' })).toBeInTheDocument()
  })

  it('the named region is set only by the pipeline: an author-typed role is still stripped by sanitize', async () => {
    // scrollableTables runs AFTER sanitize, so the schema does not have to be loosened for `role`.
    const { content } = await renderMarkdown('<div role="region" aria-label="x">Text.</div>')
    const { container } = render(<>{content}</>)

    expect(container.querySelector('[role="region"]')).toBeNull()
    expect(screen.getByText('Text.')).toBeInTheDocument()
  })

  it('sanitizes the author HTML without touching what the pipeline then generates', async () => {
    // The ordering constraint is sanitize-before-SHIKI, not sanitize-before-slug. Moving
    // it before slug and autolink changes nothing measurable: `clobberPrefix: ''` stops
    // the id rewriting, and className, aria-hidden and tabindex all survive the schema.
    // Moving it after Shiki fails five tests, because Shiki's output is inline `style`
    // attributes that the schema strips. So what this pins is the generated markup
    // surviving intact alongside a sanitized author element in the same document.
    const { content, toc } = await renderMarkdown(
      '## ' + HEADING_DAT_VAN_DE + '\n\n<iframe src="https://evil.example"></iframe>\n\n```java\nclass A {}\n```',
    )
    const { container } = render(<>{content}</>)

    expect(container.querySelector('iframe')).toBeNull()
    expect(toc[0].id).toBe(SLUG_DAT_VAN_DE)
    expect(container.querySelector('h2')?.getAttribute('id')).toBe(SLUG_DAT_VAN_DE)
    expect(container.querySelector('h2 > a.heading-anchor')).not.toBeNull()
    expect(container.querySelector('pre.shiki')?.getAttribute('style')).toContain('--shiki-dark')
  })

  it('normalizes heading text to NFC without touching code fences', async () => {
    // Kills "unscope the normalizer to every text node". A code sample is the one place
    // the exact bytes can be the point, so NFD inside a fence must survive.
    const nfd = HEADING_DAT_LOWER.normalize('NFD')
    const { content, toc } = await renderMarkdown('## ' + nfd + '\n\n```text\n' + nfd + '\n```')
    const { container } = render(<>{content}</>)

    expect(toc[0].text).toBe(HEADING_DAT_LOWER)
    expect(toc[0].text.normalize('NFD')).not.toBe(toc[0].text)
    expect(container.querySelector('pre')?.textContent).toContain(nfd)
  })

  it('lists h2 to h4 only, and never the same id twice', async () => {
    // The bare '##' is a legal empty ATX heading; rehype-slug gives it id="", which the
    // post page would render as href="#". It must not reach the toc either.
    const { toc } = await renderMarkdown('## One\n\n### Two\n\n#### Three\n\n##### Four\n\n# None\n\n##')
    expect(toc.map((t) => t.depth)).toEqual([2, 3, 4])
    expect(toc.map((t) => t.id)).not.toContain('')
    expect(new Set(toc.map((t) => t.id)).size).toBe(toc.length)
  })

  it('gives a colliding author id to the table of contents only once', async () => {
    // An author writing raw HTML can mint the same id twice — github-slugger dedupes only
    // ids it minted itself. Duplicate DOM ids are the author's own visible problem;
    // duplicate React keys in the rendered TOC would not be, so the toc must not repeat one.
    const { toc } = await renderMarkdown('<h2 id="mot">Manual</h2>\n\n<h2 id="mot">Again</h2>')

    expect(toc.filter((t) => t.id === 'user-content-mot')).toHaveLength(1)
  })

  it('keeps an author id out of the namespace of the generated heading ids', async () => {
    // Before the author's id was prefixed, `<h2 id="mot">` could collide with the slug that rehype-slug makes of `## mot` (the old
    // test of the table of contents was built on that collision). Now the author's heading lives under `user-content-`, so both
    // stay in the table of contents, each with a working target.
    const { content, toc } = await renderMarkdown('<h2 id="mot">Manual</h2>\n\n## mot')
    const { container } = render(<>{content}</>)

    expect(toc.map((t) => t.id)).toEqual(['user-content-mot', 'mot'])
    for (const entry of toc) expect(container.querySelector(`[id="${entry.id}"]`)).not.toBeNull()
  })
})

/**
 * Every <pre> goes through components/site/CodeBlock.tsx, which wraps it with the
 * "Copy code" button. What must NOT change is the <pre> itself — its text is exactly what the
 * button copies, and the existing NFD test above reads `pre.textContent` too.
 */
describe('renderMarkdown code blocks', () => {
  const COPY = { name: msg('Site.code.copy') }

  it('gives every <pre> exactly one copy button, in its own frame: fenced, unlisted language, no language, raw HTML', async () => {
    const { content } = await renderMarkdown(
      ['```java\nclass A {}\n```', '```rust\nfn main() {}\n```', '```\nno language\n```', '<pre>typed by the author</pre>'].join(
        '\n\n',
      ),
    )
    const { container } = render(<>{content}</>)

    const pres = container.querySelectorAll('pre')
    expect(pres).toHaveLength(4)
    expect(screen.getAllByRole('button', COPY)).toHaveLength(4)
    for (const pre of pres) {
      const frame = pre.parentElement!
      expect(frame).toHaveAttribute('data-code-block')
      expect(frame).toHaveClass('relative')
      expect(frame.querySelectorAll('pre')).toHaveLength(1)
      expect(within(frame).getAllByRole('button', COPY)).toHaveLength(1)
      // One wrapper per block, no nesting.
      expect(frame.parentElement!.closest('[data-code-block]')).toBeNull()
    }
  })

  it('leaves the <pre> itself untouched: same text, same Shiki attributes, nothing of the button inside it', async () => {
    const code = `const a = 1\n\tconst b = "${HEADING_DAT_LOWER}"\n    return a`
    const { content } = await renderMarkdown('```typescript\n' + code + '\n```')
    const { container } = render(<>{content}</>)

    const pre = container.querySelector('pre')!
    // Exactly the source, minus the fence's trailing newline: this is the string the button copies.
    expect(pre.textContent).toBe(code)
    expect(pre).toHaveClass('shiki')
    expect(pre).toHaveAttribute('tabindex', '0')
    expect(pre.getAttribute('style')).toContain('--shiki-dark-bg')
    expect(pre.querySelector('button, [role="status"]')).toBeNull()
  })

  it('does not wrap inline code', async () => {
    const { content } = await renderMarkdown('Type `ls -la` then Enter.')
    const { container } = render(<>{content}</>)

    expect(container.querySelector('code')).toHaveTextContent('ls -la')
    expect(container.querySelector('[data-code-block]')).toBeNull()
    expect(screen.queryByRole('button', COPY)).toBeNull()
  })

  it('keeps the code out of the button: no prop carries it, so it is in the HTML once', async () => {
    // A client component's props are serialised into the RSC payload. The button reads the <pre>
    // at click time instead, so the code appears in the server HTML exactly once.
    // A `text` fence: one token per line, so the marker is never split across highlight spans.
    const marker = 'A_UNIQUE_MARKER'
    const { content } = await renderMarkdown('```text\n' + marker + '\n```')
    const html = renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)

    expect(html.split(marker)).toHaveLength(2)
  })

  it('hydrates a code block with no recoverable error', async () => {
    // The button is a client component rendered into server HTML; the client tree must match it.
    const { content } = await renderMarkdown('```java\nclass A {}\n```\n\nNext paragraph.')
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<IntlWrapper>{content}</IntlWrapper>)
    document.body.append(host)

    const errors: unknown[] = []
    const root = hydrateRoot(host, <IntlWrapper>{content}</IntlWrapper>, {
      onRecoverableError: (error) => errors.push(error),
    })
    await act(async () => {})

    expect(errors).toEqual([])
    expect(within(host).getByRole('button', COPY)).toBeInTheDocument()
    root.unmount()
    host.remove()
  })
})

/**
 * The copy button copies `pre.textContent`, so a `<pre>` must hold exactly what the reader sees: an element inside it that hides text
 * (a closed `details`) would put text on the clipboard that the page does not show. Shiki only rewrites a `<pre>` whose first child is a
 * `code` with a language, so the pipeline flattens every other one (`plainPre` in lib/markdown.tsx).
 */
describe('renderMarkdown, what a <pre> holds', () => {
  const HIDING = [
    ['a span with the sr-only class', '<pre><span class="sr-only">EVIL</span>echo hi</pre>'],
    ['a span with the hidden class before a code element', '<pre><span class="hidden">EVIL</span><code>echo hi</code></pre>'],
    ['a closed details', '<pre><details><summary></summary>EVIL</details>echo hi</pre>'],
  ] as const

  async function preOf(markdown: string) {
    const { content } = await renderMarkdown(markdown)
    const view = render(<>{content}</>)
    return { ...view, pre: view.container.querySelector('[data-code-block] > pre')! }
  }

  it.each(HIDING)(
    'holds only text when an author puts %s in it, so nothing is hidden from the reader',
    async (_name, markdown) => {
      const { pre } = await preOf(markdown)

      expect(pre.querySelector('*')).toBeNull()
      expect(pre.textContent).toBe('EVILecho hi')
    },
  )

  it('copies exactly the text it shows', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
    try {
      const { pre } = await preOf('<pre><details><summary></summary>EVIL</details>echo hi</pre>')
      await act(async () => {
        screen.getByRole('button', { name: msg('Site.code.copy') }).click()
      })

      expect(writeText).toHaveBeenCalledWith(pre.textContent)
      expect(writeText).toHaveBeenCalledWith('EVILecho hi')
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('flattens a code element that holds elements or has company, and keeps the element, its language and its title', async () => {
    const { container } = await preOf(
      '<pre><code class="language-text"><details>EVIL</details>one</code><details>TWO</details></pre>\n\n<pre><code><b>x</b>y</code></pre>',
    )

    const pres = [...container.querySelectorAll('pre')]
    expect(pres).toHaveLength(2)
    expect(pres.map((pre) => pre.textContent)).toEqual(['EVILoneTWO', 'xy'])
    for (const pre of pres) expect(pre.querySelector('details, b')).toBeNull()
  })

  it('shows a line break typed as <br> as a line break, so the flat text reads as it did', async () => {
    const { pre } = await preOf('<pre>first<br>second</pre>')

    expect(pre.textContent).toBe('first\nsecond')
  })

  it('leaves a fence alone: with a language, without one, and with a title', async () => {
    const { container } = await preOf(
      ['```java\nclass A {}\n```', '```\nno language\n```', '```js title="a.js"\nlet a = 1\n```', '<pre>plain</pre>'].join(
        '\n\n',
      ),
    )

    const pres = [...container.querySelectorAll('pre')]
    expect(pres.map((pre) => pre.textContent)).toEqual(['class A {}', 'no language\n', 'let a = 1', 'plain'])
    expect(pres[0]).toHaveClass('shiki')
    expect(pres[1]!.querySelector(':scope > code')?.childNodes).toHaveLength(1)
    expect(pres[2]).toHaveAttribute('data-title', 'a.js')
  })

  it('does the same in the feed, which has no highlighter', async () => {
    const html = await renderMarkdownToFeedHtml(
      '<pre><details><summary></summary>EVIL</details>echo hi</pre>\n\n```\nfence\n```',
      'https://blog.example/posts/p',
    )

    expect(html).toContain('<pre>EVILecho hi</pre>')
    expect(html).not.toContain('<details')
    expect(html).toContain('<pre><code>fence\n</code></pre>')
  })
})

describe('renderMarkdown dark mode', () => {
  it('emits the dark-theme custom properties the CSS swap depends on', async () => {
    // globals.css switches code colours in dark mode purely through --shiki-dark, and
    // nothing asserted Shiki emits it — the light and dark themes could be swapped, or
    // the second theme dropped, with the suite still green.
    const { content } = await renderMarkdown('```java\npublic class A {}\n```')
    const { container } = render(<>{content}</>)

    const style = container.querySelector('pre')?.getAttribute('style') ?? ''

    // Not merely "both properties exist". Swapping the two themes still emits both, so
    // presence alone let that mutant through. These are github-light's and
    // github-dark's own values, and both theme packages are pinned exactly.
    expect(style).toContain('background-color: rgb(255, 255, 255)')
    expect(style).toContain('--shiki-dark-bg: #24292e')
    expect(style).toContain('--shiki-dark: #e1e4e8')
  })
})
