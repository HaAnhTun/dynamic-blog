import type { Root } from 'mdast'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { skipDirectives } from './nesting'
import { plainTextReader } from './parse-budget'
import { readingOf } from './reading'
import { processBlocks } from './remark-blocks'
import type { Problem } from './types'

/**
 * Everything wrong with the block syntax of an article body, with a 1-based line and an actionable message, in line order. Pure: it
 * parses and looks, nothing else, so it also runs on the import page and in the pre-publish lint without the renderer. An article
 * with no directives has no problems; an article with only headings and prose is as valid as one that uses every block.
 *
 * It runs the very first pass the renderer runs (`processBlocks` without the rewrite), so what is listed here is exactly what the
 * public page turns into plain content. An article that nests more blocks than the parser can read in time (`./nesting.ts`) is not
 * parsed for blocks at all: its one problem says so, and the others that can still be found (a raw `<ai-block>`) come with it. An article
 * that would cost the parser more than its budget (`./parse-budget.ts`) is not parsed as Markdown either: it has the one `too-heavy` problem.
 */
export function validateBlocks(markdown: string): Problem[] {
  const reading = readingOf(markdown)
  const processor = unified()
    .use((reading.plain ? plainTextReader : remarkParse) as typeof remarkParse)
    .use(remarkGfm)
    .use(reading.directives ? remarkDirective : skipDirectives)
  const tree = processor.runSync(processor.parse(markdown)) as Root
  const problems = processBlocks(tree, markdown, { transform: false, directives: reading.directives })
  return reading.problems.length > 0 ? [...problems, ...reading.problems].sort((a, b) => a.line - b.line) : problems
}
