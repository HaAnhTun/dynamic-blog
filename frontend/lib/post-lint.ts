/*
 * Pre-publish checks: the TypeScript version of `lint()` in seed/push.py, for the post editor.
 *
 * KEEP THE TWO VERSIONS IN SYNC. seed/push.py checks the seed posts when pushing them, this file checks the post being
 * written in admin: change a rule on one side and change the other too, and vice versa. Each side has a comment
 * pointing to the other.
 *
 * Same as push.py:
 *  - one pass by line, aware of code fences: a line that STARTS with ``` opens or closes a block. Only at column 0 and only
 *    backticks, like push.py, not full CommonMark (~~~ fences or indented fences are not counted);
 *  - an opening fence with no language; a language not in HIGHLIGHTED_LANGS. Like push.py, only the FIRST word after ```
 *    (compared in lower case) is the language name: a title or tab label after it ("```ts title=x") is not part of it;
 *  - an h1 (`# …`) outside a fence, reported only the first time: in a bash or python block, `# …` is a comment;
 *  - a fence that never closes;
 *  - a short description outside 100–400 characters, counting code points of the trimmed string (like Python's `len()`).
 *
 * Different from push.py, on purpose:
 *  - every problem of `validateBlocks` (the article block syntax, lib/blocks) is also a warning, with its line: push.py is Python
 *    and cannot run the TypeScript validator, and the seed articles use no blocks;
 *  - no check for a missing /images/ file: the browser cannot read the server's disk. The test
 *    test/article-images.test.ts remains the guard for seed posts;
 *  - an empty description has its own message: in push.py the description is a required field, in admin it is not;
 *  - lines are split on \r\n, \r, \n. Python's `splitlines()` also splits at \v, \f, U+2028…: that difference only
 *    changes the line number of posts containing those characters.
 *
 * Blocks nothing: the editor lists the warnings, publishing stays the writer's call.
 */
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translator'
import { validateBlocks } from './blocks/validate'
import { numberFormat } from './format'

/**
 * The languages lib/markdown.tsx loads into Shiki (canonical names and aliases Shiki recognizes), plus `text`. A block in
 * another language still shows, but as plain text (`fallbackLanguage: 'text'`), with no error.
 *
 * COPIED, not imported: lib/markdown.tsx is server-only, and writes each `import('@shikijs/langs/…')` out one by one so
 * the bundler can see it, so there is no list to export. post-lint.test.ts really builds every name
 * below through renderMarkdown, so if markdown.tsx DROPS a language the test goes red; if it ADDS a language it must be copied
 * by hand here and into HIGHLIGHTED_LANGS of seed/push.py.
 */
export const HIGHLIGHTED_LANGS: ReadonlySet<string> = new Set([
  'java',
  'typescript',
  'ts',
  'tsx',
  'javascript',
  'js',
  'python',
  'py',
  'bash',
  'sh',
  'sql',
  'json',
  'yaml',
  'yml',
  'xml',
  'text',
])

/** Bounds of the short description length, like `100 <= n <= 400` in push.py. */
export const EXCERPT_MIN = 100
export const EXCERPT_MAX = 400

export type LintRule =
  'fence-language-missing' | 'fence-language-unknown' | 'body-h1' | 'block-problem' | 'fence-unclosed' | 'excerpt-length'

/** One warning. `line` (counted from 1) is only present on a warning about a line of the content. */
export type LintWarning = { rule: LintRule; line: number | null; message: string }

const FENCE = '```'
/** The same expression as push.py (`re.match(r'^#\s+\S', line)`). */
const H1 = /^#\s+\S/

/**
 * The warnings for the post being edited, in the order push.py prints them: content warnings by line (block syntax problems
 * among them), then the unclosed fence, then the short description. A pure function: calling it again on every keystroke is
 * one pass over the string plus one parse for the block syntax.
 * `t` is the `Admin.lint` translator: the messages come out already translated.
 */
export function lintPost(
  { excerpt, content }: { excerpt: string; content: string },
  t: Translator,
  locale: Locale = DEFAULT_LOCALE,
): LintWarning[] {
  const warnings: LintWarning[] = []
  let h1Reported = false
  // The line of the open fence, or null when outside a code block.
  let openFence: number | null = null

  content.split(/\r\n|\r|\n/).forEach((text, index) => {
    const line = index + 1
    if (text.startsWith(FENCE)) {
      // Inside a block, every line starting with ``` is a CLOSING fence, even with text after it (like push.py).
      if (openFence !== null) {
        openFence = null
        return
      }
      openFence = line
      // Only the first word is the language; a `title="..."` or other meta may follow it.
      const language = text.slice(FENCE.length).trim().split(/\s+/)[0] ?? ''
      if (language === '') {
        warnings.push({
          rule: 'fence-language-missing',
          line,
          message: t('fenceLanguageMissing', { line: String(line) }),
        })
      } else if (!HIGHLIGHTED_LANGS.has(language.toLowerCase())) {
        warnings.push({
          rule: 'fence-language-unknown',
          line,
          message: t('fenceLanguageUnknown', { line: String(line), language }),
        })
      }
      return
    }
    // The post page already uses the title as <h1>: an h1 in the body means two top-level headings, and a wrong
    // entry at the top of the table of contents.
    if (openFence === null && !h1Reported && H1.test(text)) {
      warnings.push({
        rule: 'body-h1',
        line,
        message: t('bodyH1', { line: String(line) }),
      })
      h1Reported = true
    }
  })

  // Block syntax mistakes (`:::callout`, `:::diagram`, ...) join the content warnings, ordered by line (a stable sort keeps the
  // fence and h1 warnings of one line before the block problem of that line).
  for (const problem of validateBlocks(content)) {
    warnings.push({
      rule: 'block-problem',
      line: problem.line,
      message: t('blockProblem', { line: String(problem.line), message: problem.message }),
    })
  }
  warnings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))

  if (openFence !== null) {
    warnings.push({
      rule: 'fence-unclosed',
      line: openFence,
      message: t('fenceUnclosed', { line: String(openFence) }),
    })
  }

  // Code points, not the UTF-16 units of `.length`: an emoji is one character, like Python's len().
  const length = [...excerpt.trim()].length
  if (length === 0) {
    warnings.push({
      rule: 'excerpt-length',
      line: null,
      message: t('excerptEmpty', { min: String(EXCERPT_MIN), max: String(EXCERPT_MAX) }),
    })
  } else if (length < EXCERPT_MIN || length > EXCERPT_MAX) {
    warnings.push({
      rule: 'excerpt-length',
      line: null,
      message: t('excerptLength', {
        count: length,
        formatted: numberFormat(locale).format(length),
        min: String(EXCERPT_MIN),
        max: String(EXCERPT_MAX),
      }),
    })
  }

  return warnings
}
