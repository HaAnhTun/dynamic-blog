import type { Root } from 'mdast'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { skipDirectives } from './nesting'
import { plainTextReader } from './parse-budget'
import { readingOf } from './reading'
import { getBlockSpec } from './registry'

/**
 * How many blocks of each type an article body uses, for the summary line of the import page: most used first, then by name.
 * Pure, like `validateBlocks` (the same parse), and it counts only directives whose name is in the registry: a code sample that
 * shows the syntax is not a block, and neither is an unknown name or a text directive. A block that has problems still counts, so
 * the summary says what the author wrote; the problems are listed beside it. An article nested too deeply to parse for blocks
 * (`./nesting.ts`), or too heavy to parse as Markdown at all (`./parse-budget.ts`), counts none.
 */
export function countBlocks(markdown: string): { type: string; count: number }[] {
  const reading = readingOf(markdown)
  const processor = unified()
    .use((reading.plain ? plainTextReader : remarkParse) as typeof remarkParse)
    .use(remarkGfm)
    .use(reading.directives ? remarkDirective : skipDirectives)
  const tree = processor.parse(markdown) as Root
  const counts = new Map<string, number>()
  visit(tree, (node) => {
    if (node.type !== 'containerDirective' && node.type !== 'leafDirective') return
    if (getBlockSpec(node.name) === undefined) return
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1)
  })
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}
