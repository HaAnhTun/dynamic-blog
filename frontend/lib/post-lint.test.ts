import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IntlWrapper, translatorFor } from '@/test/intl'
import { validateBlocks } from './blocks/validate'
import { renderMarkdown } from './markdown'
import { msg } from '@/test/render-intl'
import { EXCERPT_MAX, EXCERPT_MIN, HIGHLIGHTED_LANGS, lintPost, type LintRule } from './post-lint'

/*
 * The TypeScript version of `lint()` in seed/push.py. One block per rule, with a "does not warn"
 * counterpart so a rule that warns indiscriminately (e.g. treating a CLOSING fence as a fence missing a language) also goes red.
 */

const t = translatorFor('vi', 'Admin.lint')

/** A description long enough that the description rule does not interfere with tests that are only about content. */
const GOOD_EXCERPT =
  'A description long enough for a post, saying what the post is about and what the reader gets after reading it all.'

function rulesOf(content: string, excerpt = GOOD_EXCERPT): LintRule[] {
  return lintPost({ excerpt, content }, t).map((warning) => warning.rule)
}

describe('lintPost: code fences', () => {
  it('an opening fence with no language warns, with the line number; a CLOSING fence never does', () => {
    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content: 'Intro\n\n```\nls -la\n```\n' }, t)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ rule: 'fence-language-missing', line: 3 })
    expect(warnings[0].message).toBe(msg('Admin.lint.fenceLanguageMissing', { line: 3 }))
  })

  it('a correct block (loaded language) produces no warning at all, even at the closing fence', () => {
    expect(rulesOf('```java\nclass A {}\n```\n\n```ts\nconst a = 1\n```')).toEqual([])
  })

  it('language not loaded in Shiki: warns with the language name; compared case-insensitively', () => {
    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content: '```html\n<p>x</p>\n```\n\n```JAVA\nclass A {}\n```' }, t)

    expect(warnings.map((w) => w.rule)).toEqual(['fence-language-unknown'])
    expect(warnings[0].line).toBe(1)
    expect(warnings[0].message).toContain('“html”')
  })

  it('like push.py: only the first word after ``` is the language; a title after it is not part of the name', () => {
    // push.py takes the first whitespace-delimited word of line[3:]. Pinned so the two lint versions say the same thing
    // about the same file.
    expect(rulesOf('```  ts  \nconst a = 1\n```')).toEqual([])
    expect(rulesOf('```ts title=x\nconst a = 1\n```')).toEqual([])
    expect(rulesOf('```python title="a b.py"\nx = 1\n```')).toEqual([])
    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content: '```ruby title="a.rb"\nputs 1\n```' }, t)
    expect(warnings.map((w) => w.rule)).toEqual(['fence-language-unknown'])
    expect(warnings[0].message).toBe(msg('Admin.lint.fenceLanguageUnknown', { line: 1, language: 'ruby' }))
  })

  it('fences inside code tabs are checked by their language word, not by their tab label', () => {
    const tabs = ':::code-tabs\n```bash title="npm"\nnpm i\n```\n```js title="a b"\nx()\n```\n:::\n'
    expect(rulesOf(tabs)).toEqual([])
    const unknown = ':::code-tabs\n```bash title="npm"\nnpm i\n```\n```ruby title="gem"\nx\n```\n:::\n'
    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content: unknown }, t)
    expect(warnings.map((w) => [w.rule, w.line])).toEqual([['fence-language-unknown', 5]])
  })

  it('a fence that never closes: warns, with the opening line', () => {
    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content: 'a\n```python\nprint(1)\n' }, t)

    expect(warnings.map((w) => w.rule)).toEqual(['fence-unclosed'])
    expect(warnings[0].line).toBe(2)
  })

  it('only a line that STARTS with ``` is a fence (like push.py): ``` mid-line or indented is not', () => {
    expect(rulesOf('Write `code` or ```inline``` mid-sentence.\n\n    ```\n')).toEqual([])
  })

  it('CRLF and CR are also line breaks', () => {
    expect(rulesOf('```java\r\nclass A {}\r\n```\r\n# Title\r\n')).toEqual(['body-h1'])
    expect(rulesOf('```\rx\r```')).toEqual(['fence-language-missing'])
  })
})

describe('lintPost: h1 in the post body', () => {
  it('warns about an h1 outside a fence, with the line number; only once even if there are several', () => {
    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content: 'Open\n# One\n\n# Two\n' }, t)

    expect(warnings.map((w) => w.rule)).toEqual(['body-h1'])
    expect(warnings[0].line).toBe(2)
  })

  it('`# comment` inside a bash or python block is not an h1', () => {
    // The very bug push.py once had: the first two posts warned about an h1 because of a Python comment and a diff line.
    expect(rulesOf('```bash\n# install\napt install x\n```\n\n```python\n# sum up\n```')).toEqual([])
  })

  it('## and #hashtag (no space) are not an h1', () => {
    expect(rulesOf('## Section\n\n#hashtag\n\n#\n')).toEqual([])
  })
})

describe('lintPost: block syntax (validateBlocks)', () => {
  it('surfaces every block problem as a warning with its line, the same ones validateBlocks reports', () => {
    const content = ['Intro.', '', ':::callot', 'x', ':::', '', ':::callout{type=bad}', 'y', ':::'].join('\n')
    const problems = validateBlocks(content)
    expect(problems).toHaveLength(2)

    const warnings = lintPost({ excerpt: GOOD_EXCERPT, content }, t)

    expect(warnings.map((w) => [w.rule, w.line])).toEqual([
      ['block-problem', 3],
      ['block-problem', 7],
    ])
    expect(warnings[0].message).toBe(msg('Admin.lint.blockProblem', { line: 3, message: problems[0]!.message }))
  })

  it('does not warn about an article that uses valid blocks', () => {
    expect(rulesOf(':::callout{type=tip title="Hint"}\nUse the cache.\n:::\n')).toEqual([])
  })

  it('puts a block problem among the content warnings by line, before the unclosed fence and the description', () => {
    const rules = rulesOf('# H1\n\n:::callot\nx\n:::\n\n```\nnever closed', '')

    expect(rules).toEqual(['body-h1', 'block-problem', 'fence-language-missing', 'fence-unclosed', 'excerpt-length'])
  })
})

describe('lintPost: short description', () => {
  it(`within ${EXCERPT_MIN}–${EXCERPT_MAX} characters does not warn, at both boundaries`, () => {
    expect(rulesOf('x', 'a'.repeat(EXCERPT_MIN))).toEqual([])
    expect(rulesOf('x', 'a'.repeat(EXCERPT_MAX))).toEqual([])
  })

  it('shorter or longer warns, stating the character count', () => {
    const short = lintPost({ excerpt: 'a'.repeat(EXCERPT_MIN - 1), content: 'x' }, t)
    const long = lintPost({ excerpt: 'a'.repeat(EXCERPT_MAX + 1), content: 'x' }, t)

    expect(short.map((w) => w.rule)).toEqual(['excerpt-length'])
    expect(short[0].message).toBe(
      msg('Admin.lint.excerptLength', { count: 99, formatted: '99', min: String(EXCERPT_MIN), max: String(EXCERPT_MAX) }),
    )
    expect(short[0].line).toBeNull()
    expect(long[0].message).toBe(
      msg('Admin.lint.excerptLength', { count: 401, formatted: '401', min: String(EXCERPT_MIN), max: String(EXCERPT_MAX) }),
    )
  })

  it('empty: its own message (in admin the description is optional, unlike push.py)', () => {
    const [warning] = lintPost({ excerpt: '   ', content: 'x' }, t)

    expect(warning.rule).toBe('excerpt-length')
    expect(warning.message).toBe(msg('Admin.lint.excerptEmpty', { min: String(EXCERPT_MIN), max: String(EXCERPT_MAX) }))
  })

  it('counts the code points of the trimmed string, like Python len(): an emoji is one character, surrounding whitespace does not count', () => {
    // Each line tells the right way of counting from a wrong one. 98 letters + 1 emoji = 99 code points (too short),
    // but 100 UTF-16 units: counting by .length would not warn.
    expect(rulesOf('x', `${'a'.repeat(98)}😀`)).toEqual(['excerpt-length'])
    // 400 emoji = 400 code points (just enough), but .length is 800.
    expect(rulesOf('x', '😀'.repeat(EXCERPT_MAX))).toEqual([])
    expect(rulesOf('x', '😀'.repeat(EXCERPT_MAX + 1))).toEqual(['excerpt-length'])
    // 98 letters between whitespace: too short after trim, 100 if the whitespace were counted.
    expect(rulesOf('x', `     ${'a'.repeat(98)}  `)).toEqual(['excerpt-length'])
  })
})

describe('lintPost: order like push.py', () => {
  it('content warnings by line, then the unclosed fence, then the description', () => {
    const rules = rulesOf('```\na\n```\n# H1\n```rust\nfn main() {}', '')

    expect(rules).toEqual(['fence-language-missing', 'body-h1', 'fence-language-unknown', 'fence-unclosed', 'excerpt-length'])
  })
})

/*
 * HIGHLIGHTED_LANGS is a copy of the languages lib/markdown.tsx loads into Shiki (that file is
 * server-only and writes each import out one by one for the bundler, so it cannot export a list). This test joins
 * the two copies: every name in the list must really be coloured by the post page's own renderMarkdown.
 * If markdown.tsx drops a language the test goes red; if it ADDS a language nothing goes red — copy it
 * by hand here (and into HIGHLIGHTED_LANGS of seed/push.py).
 */
describe('HIGHLIGHTED_LANGS matches what renderMarkdown colours', () => {
  const samples: Record<string, string> = {
    java: 'public class A { int x = 1; }',
    typescript: 'const a: number = 1; export function f() { return a }',
    tsx: 'const A = () => <div className="x">hi</div>',
    javascript: 'const a = 1; function f() { return "x" }',
    python: 'def handler(event, context):\n    return {"ok": True}',
    bash: 'for f in *.md; do echo "$f"; done',
    sql: "SELECT id, title FROM posts WHERE status = 'PUBLISHED';",
    json: '{"a": 1, "b": [true, null]}',
    yaml: 'server:\n  port: 8080\n  name: "blog"',
    xml: '<dependency>\n  <groupId>org.x</groupId>\n</dependency>',
  }
  const aliases: Record<string, string> = { ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', yml: 'yaml' }

  it('the list is exactly the canonical names, aliases and "text"', () => {
    expect([...HIGHLIGHTED_LANGS].sort()).toEqual([...Object.keys(samples), ...Object.keys(aliases), 'text'].sort())
  })

  it.each([...Object.keys(samples), ...Object.keys(aliases)])('```%s is coloured', async (lang) => {
    const code = samples[lang] ?? samples[aliases[lang]]
    const { content } = await renderMarkdown('```' + lang + '\n' + code + '\n```\n')
    const coloured = (renderToStaticMarkup(createElement(IntlWrapper, null, content)).match(/style="color:/g) ?? []).length

    // Same threshold as lib/shiki-langs.test.tsx: a block that falls back to `text` has at most two coloured spans.
    expect(coloured, `${lang}: ${coloured} coloured tokens`).toBeGreaterThan(2)
  })
})
