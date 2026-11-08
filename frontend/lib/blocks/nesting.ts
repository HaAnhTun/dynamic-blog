import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import type { Problem } from './types'

/**
 * How deep an article may nest its blocks, and how much work it may ask of the parser, before the block syntax is not read at all.
 *
 * Why a limit exists. `remark-directive` makes a container of every `:::name` line and keeps it open until a fence closes it. Each
 * line the Markdown parser reads is checked against every container still open, so a body that opens blocks and never closes them
 * costs time that grows much faster than the text: measured on this stack, 3.5 KB of `:::callout` takes 0.3 s, 14 KB takes 6 s and
 * 28 KB takes 38 s, all on the one event loop of the Next process, on every render of the page and the feeds. The same text with every
 * block closed is read in milliseconds (4000 blocks, 72 KB, 0.26 s), and a real article never nests more than the registry asks for
 * (three levels).
 *
 * Two limits follow. The first is how many blocks are open at once ({@link MAX_BLOCK_DEPTH}, {@link MAX_QUOTED_BLOCKS}). It is not
 * enough alone: the cost is (blocks open) x (lines), so a few open blocks followed by a very long run of short lines still holds the
 * event loop for seconds (8 open blocks and 200 KB of blank lines take 28 s). The second is that product itself,
 * {@link MAX_BLOCK_WORK}: the sum, over every line, of the blocks open at that line.
 *
 * What happens past a limit is what happens to any block that is not valid (`./remark-blocks.ts`): the article is rendered
 * without the directive syntax, its text stays, and the problem below is reported. The reader of the public page sees the lines
 * with the colons as text; the author sees the problem in the editor preview and on the import page.
 */
export const MAX_BLOCK_DEPTH = 8

/**
 * The limit for blocks that are opened behind anything in front of the colons: a quote marker, a list marker, a footnote definition
 * (`[^x]: :::note`), a tab or four spaces, as `> :::note` or `1. :::note`. Closing those cannot be told from text by a line scan (the
 * fence that closes them carries the same prefix, which an author's text can imitate), so they are counted and never taken off again.
 * A real article has a few of these at most (the reference of the blocks, the most syntax-heavy page of the repository, reaches 7). The
 * count is an upper bound, not the parser's own: any line with three colons followed by a name character counts, in the middle of a
 * sentence too. A block behind a quote or a list is not a valid block anyway (it renders as plain text with a problem).
 */
export const MAX_QUOTED_BLOCKS = 16

/**
 * The most work an article may ask of the parser while blocks are open: the sum, over every line, of the blocks open at that line
 * (those behind a prefix included, which are never taken off). The parser spends about the same time on each such step (4 to 6
 * microseconds measured here), so a text at the budget is parsed in 0.4 to 0.6 s whatever its shape: 8 open blocks and 12 400 blank
 * lines, 16 quotes and 6 000 lines of `>`, or one block and 99 000 lines (`docs/SECURITY.md`, "Markdown in posts"). The busiest legitimate document of the
 * repository, `docs/content-blocks.md`, sums to under 5 000. A line with nothing open adds nothing.
 */
export const MAX_BLOCK_WORK = 100_000

/**
 * A line that opens a block, or that the parser might read as one, with no prefix: up to three spaces, three or more colons, and then
 * either a character that can start a name or a tab followed by something. The name of `remark-directive` starts with ANY character
 * that is not white space, a line end or Unicode punctuation or a symbol: `:::1`, and a name that starts with an accented letter, a
 * Chinese character or an emoji, all open a block. A tab counts as a character too (`micromark` gives it a negative code, which its
 * white space test skips). Wider than the parser on purpose: a punctuation mark after the colons is counted although the parser would
 * not open a block there, and so is a name followed by text (`:::a b`), which the parser reads as a paragraph. A line the scan counts
 * and the parser does not only makes the count higher.
 */
const PLAIN_OPEN = /^ {0,3}(:{3,})(?:[^\s:]|\t.*\S)/

/**
 * A line of colons and a tab, and nothing else. The parser reads it as the closing fence of the outermost block it is long enough for
 * and, when it is not long enough for any, as the opening of a block whose name is the tab. The scan cannot tell which, so it takes the
 * fence off the blocks it would close and then counts it as an open block as well.
 */
const TAB_FENCE = /^ {0,3}(:{3,})\t[ \t]*$/

/**
 * Three or more colons followed by a name character or a tab, anywhere in the line: behind a quote marker, a list marker, a footnote
 * definition (`[^x]: :::note`), a tab or four spaces, or in the middle of a sentence. The parser can open a block behind any of those
 * and, for most of them, the fence that closes it carries the same prefix, which text can imitate, so these are only counted. The
 * lookbehind starts a match at the first colon of a run only: without it a line of n colons costs n squared steps.
 */
const PREFIXED_OPEN = /(?<!:):{3,}(?:\t|[^\s:])/

/** A closing fence: up to three spaces, three or more colons, nothing else. */
const CLOSE = /^ {0,3}(:{3,})[ \t]*$/

/** Takes off the blocks a fence of `colons` colons ends, counted from the innermost: each one that opened with that many colons or fewer. */
function closeFrom(open: number[], colons: number): void {
  while (open.length > 0 && open[open.length - 1]! <= colons) open.pop()
}

/**
 * Reads the lines of `source` and calls `visit` after each line, with its 1-based number, how many blocks are open, how many were
 * counted behind a prefix, and the work so far (the sum, over the lines read, of the blocks open at each, see {@link MAX_BLOCK_WORK}).
 * `visit` returns `true` to stop. Nothing is parsed, one pass.
 *
 * The count is built to be too high and never too low, so what it lets through is read by the parser in a time that is bounded. It is
 * not a copy of the parser, which has rules this scan cannot follow cheaply (what is a code fence depends on the blocks around it, and
 * which prefix a line belongs to depends on the containers above it):
 *  - every line that opens a block for the parser is counted as one, by one of the patterns above, and some lines that do not are too;
 *  - a block that is open is taken off only from the top of the stack by a fence that is long enough for it, so a line that was counted
 *    as an open and was not one can never take a block that is really open off with it. The parser closes the outermost block a fence is
 *    long enough for, with every block inside it, which is at least as many. This is what a differential test checks.
 *
 * The scan does not look at code fences, for the same reason: an author could make it skip the wrong lines. Counting the lines of a code
 * sample too only makes the count higher, and a sample that opens and closes its block adds nothing.
 */
function scan(source: string, visit: (line: number, open: number, quoted: number, work: number) => boolean): void {
  if (!source.includes(':::')) return
  const open: number[] = []
  let quoted = 0
  let line = 0
  let work = 0
  for (const text of source.split(/\r\n|\r|\n/)) {
    line += 1
    const opened = PLAIN_OPEN.exec(text)
    if (opened) {
      open.push(opened[1]!.length)
    } else {
      const tabbed = TAB_FENCE.exec(text)
      if (tabbed) {
        const colons = tabbed[1]!.length
        closeFrom(open, colons)
        open.push(colons)
      } else if (PREFIXED_OPEN.test(text)) {
        quoted += 1
      } else {
        const closed = CLOSE.exec(text)
        if (closed) closeFrom(open, closed[1]!.length)
      }
    }
    work += open.length + quoted
    if (visit(line, open.length, quoted, work)) return
  }
}

/**
 * The most blocks the scan counts open at once in `source`, those behind a prefix included, which are never taken off. It is never
 * lower than the number of container directives the parser nests (`lib/blocks/nesting.test.ts` checks that against the parser).
 */
export function blockDepthBound(source: string): number {
  let deepest = 0
  scan(source, (_line, open, quoted) => {
    deepest = Math.max(deepest, open + quoted)
    return false
  })
  return deepest
}

/** The work the scan counts for the whole of `source`: the sum, over every line, of the blocks open at that line. See {@link MAX_BLOCK_WORK}. */
export function blockWork(source: string): number {
  let total = 0
  scan(source, (_line, _open, _quoted, work) => {
    total = work
    return false
  })
  return total
}

const SYNTAX_NOT_READ = 'The block syntax of this article is not read, so its blocks show as plain text.'

/**
 * The problem for an article that opens more blocks at once than the parser can read in time, or keeps blocks open across more lines
 * than it can read in time, or `undefined` for one it can. A single pass over the lines, nothing parsed, so it costs next to nothing on
 * any article the backend accepts. It counts the blocks the parser could have open (see `scan`) and so it may report an article the
 * parser would read quickly, such as a long code sample that opens blocks and does not close them; it never lets through one the
 * parser would not.
 */
export function nestingProblem(source: string): Problem | undefined {
  let found: Problem | undefined
  scan(source, (line, open, quoted, work) => {
    if (open > MAX_BLOCK_DEPTH || quoted > MAX_QUOTED_BLOCKS) {
      found = {
        line,
        code: 'too-deep',
        message:
          `Blocks are nested too deeply: the limit is ${MAX_BLOCK_DEPTH} open at once, and ${MAX_QUOTED_BLOCKS} written behind a quote or list marker. ` +
          `${SYNTAX_NOT_READ} Close each block with its own fence line, or split the article.`,
      }
      return true
    }
    if (work > MAX_BLOCK_WORK) {
      found = {
        line,
        code: 'too-deep',
        message:
          'Blocks stay open across too many lines: every line is checked against each block still open, and this article keeps too many open for too long. ' +
          `${SYNTAX_NOT_READ} Close each block with its own fence line as soon as its content ends, or split the article.`,
      }
      return true
    }
    return false
  })
  return found
}

/** A plugin that does nothing: stands in for `remark-directive` when {@link nestingProblem} found the article too deep to parse with it. */
export const skipDirectives: Plugin<[], Root> = function skipDirectives() {
  return undefined
}
