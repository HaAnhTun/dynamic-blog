import type { Root } from 'hast'
import { isPlainLang, type CodeToHastOptions, type HighlighterCore } from 'shiki/core'
import { CODE_WARMUP } from './code-warmup'

/**
 * How much syntax highlighting one article may ask of Shiki.
 *
 * Why. A fenced code block with a language is tokenized by a TextMate grammar, one regular expression match after another, on the one
 * event loop of the Next process, on every render of the page and of the preview. Shiki has no limit of its own: a line takes the time
 * it takes (a few hundred characters of `a<` in a TypeScript fence cost tens of milliseconds, the square of their number), the time
 * limit of a line is 500 ms by default and applies to each of the two themes, and nothing limits the lines. A 498 KB fence of long
 * lines took 118 s; 2,000 characters of `a<` repeated in 20 lines took 20 s. The size limit of a post does not bound it, and the parse
 * budget (`./parse-budget.ts`) prices the parser, which reads a fence in one piece.
 *
 * The bound. {@link boundHighlighter} wraps the highlighter of one render. Every block is checked before it is handed to Shiki:
 * - a line of {@link HIGHLIGHT_LIMITS.maxLineLength} characters or more is not tokenized (Shiki's `tokenizeMaxLineLength`): it is drawn
 *   in one colour, text intact;
 * - the fences of one article together are highlighted up to {@link HIGHLIGHT_LIMITS.maxChars} characters and
 *   {@link HIGHLIGHT_LIMITS.maxLines} lines;
 * - all the highlighting of one article may take {@link HIGHLIGHT_LIMITS.budgetMs} ms. What is left of it is shared out as the time
 *   limit of a line (Shiki's `tokenizeTimeLimit`, which it applies to each theme separately): a block of `n` lines and `t` themes gets
 *   `left / (n * t)` ms per line, at most {@link HIGHLIGHT_LIMITS.lineLimitMs}, so that even if every line used all of its time the block
 *   would end inside what was left. A line that hits its limit keeps the tokens found so far and the rest of it is plain. A block
 *   that cannot give each line {@link HIGHLIGHT_LIMITS.minLineLimitMs} is not highlighted.
 *
 * The warm-up. Shiki compiles a grammar's regular expressions when it first needs a rule (the first line of TypeScript takes 100 ms and
 * the next new constructs another 60, against 2 ms once hot), and that would cut the first lines of the first article after a restart
 * short and leave them uncoloured in a page that is then cached. So the first block of a language in a process is preceded by a sample of
 * that language ({@link CODE_WARMUP}, our own text, about a quarter of a second for all twenty languages in all), tokenized without a
 * limit and thrown away. It is not charged to the article.
 *
 * A block that is not highlighted is still drawn as a code block, with the text intact: it goes to Shiki as plain text (`text`), which
 * has no grammar and costs nothing worth counting. Nothing is lost, only colour. The legitimate article is far from every limit: its
 * fences are a few thousand characters and a line takes well under a millisecond once the grammar is hot (a realistic TypeScript line
 * of 100 characters takes 8 microseconds a character).
 *
 * The measured numbers, and the shapes that made Shiki slow, are in `docs/SECURITY.md`, "Markdown in posts".
 */
export const HIGHLIGHT_LIMITS = {
  /** A line this long or longer is not tokenized. Shiki's own default is no limit. */
  maxLineLength: 300,
  /** Characters of all the fences of one article that are highlighted. */
  maxChars: 120_000,
  /** Lines of all the fences of one article that are highlighted. */
  maxLines: 2_000,
  /** Milliseconds of highlighting one article may take. */
  budgetMs: 1_500,
  /** The most a line gets, per theme, however much time is left. */
  lineLimitMs: 25,
  /** The least a line must get for its block to be highlighted. Shiki reads 0 as no limit, so it is never below 1. */
  minLineLimitMs: 2,
} as const

/** What the wrapper needs of a highlighter, and what the Shiki plugin of rehype calls: nothing else. */
export type BoundableHighlighter = Pick<HighlighterCore, 'codeToHast' | 'getLoadedLanguages' | 'loadLanguage'>

/** The lines of a block of code: a final line break does not start another line, and a carriage return and a line feed are one break. */
function countLines(code: string): number {
  let lines = 1
  for (let i = 0; i < code.length; i += 1) {
    const char = code.charCodeAt(i)
    if (char === 10 || (char === 13 && code.charCodeAt(i + 1) !== 10)) lines += 1
  }
  const last = code.charCodeAt(code.length - 1)
  return lines > 1 && (last === 10 || last === 13) ? lines - 1 : lines
}

/** How many themes Shiki tokenizes the block for: it runs the grammar once for each. */
function themeCount(options: CodeToHastOptions): number {
  return 'themes' in options && options.themes ? Math.max(1, Object.keys(options.themes).length) : 1
}

/** The languages whose grammar this process has already warmed up. */
const warmedLanguages = new Set<string>()

/**
 * The highlighter of ONE render, with the limits above applied: it keeps what the article has already used, so make a new one for
 * every article and never share it. `now` is the clock in milliseconds, `warmed` the languages the process has already warmed up and
 * `warmup` the samples to warm them with; tests pass their own.
 */
export function boundHighlighter(
  highlighter: BoundableHighlighter,
  now: () => number = () => performance.now(),
  warmed: Set<string> = warmedLanguages,
  warmup: Readonly<Record<string, string>> = CODE_WARMUP,
): BoundableHighlighter {
  let chars = 0
  let lines = 0
  let spentMs = 0

  return {
    getLoadedLanguages: () => highlighter.getLoadedLanguages(),
    loadLanguage: (...languages) => highlighter.loadLanguage(...languages),
    codeToHast(code: string, options: CodeToHastOptions): Root {
      // A plain language has no grammar: nothing to bound, and it uses none of the budget.
      if (isPlainLang(options.lang)) return highlighter.codeToHast(code, options)

      const blockLines = countLines(code)
      const perLine = Math.min(
        HIGHLIGHT_LIMITS.lineLimitMs,
        Math.floor((HIGHLIGHT_LIMITS.budgetMs - spentMs) / (themeCount(options) * blockLines)),
      )
      const allowed =
        chars + code.length <= HIGHLIGHT_LIMITS.maxChars &&
        lines + blockLines <= HIGHLIGHT_LIMITS.maxLines &&
        perLine >= HIGHLIGHT_LIMITS.minLineLimitMs
      if (!allowed) return highlighter.codeToHast(code, { ...options, lang: 'text' })

      const sample = warmed.has(options.lang) ? undefined : warmup[options.lang]
      warmed.add(options.lang)
      if (sample !== undefined) highlighter.codeToHast(sample, { ...options, transformers: [], meta: {} })

      chars += code.length
      lines += blockLines
      const started = now()
      try {
        return highlighter.codeToHast(code, {
          ...options,
          tokenizeMaxLineLength: HIGHLIGHT_LIMITS.maxLineLength,
          tokenizeTimeLimit: perLine,
        })
      } finally {
        spentMs += now() - started
      }
    },
  }
}
