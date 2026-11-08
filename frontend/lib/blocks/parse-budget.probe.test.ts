// @vitest-environment node
import { appendFileSync, writeFileSync } from 'node:fs'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, it } from 'vitest'
import { renderMarkdown, renderMarkdownToFeedHtml } from '../markdown'
import { PARSE_BUDGET, parseCost } from './parse-budget'

/** One row of a table: `cells` cells of the text `cell`. */
function tableRow(cells: number, cell: string): string {
  return '|' + (cell + '|').repeat(cells) + '\n'
}

/** `unit` repeated `perParagraph` times in a paragraph, and as many paragraphs as `units` needs: the shape of a long article that is mostly markup. */
function spread(unit: string, perParagraph: number): (units: number) => string {
  return (units) => (unit.repeat(perParagraph) + '\n\n').repeat(Math.ceil(units / perParagraph))
}

const BACKSLASH = String.fromCharCode(92)

/**
 * A measurement, not a test: it runs only with `PARSE_PROBE=1` (and writes its table to the file in `PARSE_PROBE_OUT`, or to stderr).
 * For each shape that makes the Markdown parser, or the stages after it, slower than linear, it builds the biggest text whose estimate
 * is still inside {@link PARSE_BUDGET}, and times the real parser, the whole feed pipeline and the whole page pipeline (`renderMarkdown`:
 * the heaviest of the three, since it also highlights and wraps) on it, the fastest of two runs each. The estimate is an upper bound when the measured time stays under
 * the budget for every shape; after an upgrade of `remark`, `micromark`, `remark-directive` or `rehype`, run it again and, if a line goes over, raise the
 * price of its counter in `parse-budget.ts`:
 *
 *     PARSE_PROBE=1 PARSE_PROBE_OUT=probe.txt npx vitest run lib/blocks/parse-budget.probe.test.ts
 *
 * `PARSE_PROBE_SHAPE` is a regular expression on the name of a shape and runs only those (`PARSE_PROBE_SHAPE='links|emphasis'`): a long
 * sweep in one process slows down with the state of the heap, so a shape that looks slow is timed again alone, in a fresh process.
 *
 * Wall-clock numbers depend on the machine; compare them with the budget, not with each other. docs/DEVELOPMENT.md, "Measuring the
 * Markdown parse budget".
 */
const SHAPES: Record<string, (units: number) => string> = {
  'star-bracket (*]) run': (n) => '*]'.repeat(n),
  'star-a (*a) run': (n) => '*a'.repeat(n),
  'underscore-a (_a) run': (n) => '_a'.repeat(n),
  'mixed strong (**a_) run': (n) => '**a_'.repeat(n),
  'bracket pairs ([a])': (n) => '[a]'.repeat(n),
  'footnote calls ([^a])': (n) => '[^a]'.repeat(n),
  'tilde (~a) run': (n) => '~a'.repeat(n),
  'quotes (> and a blank line)': (n) => '>\n\n'.repeat(n),
  'quotes with text': (n) => '> a\n\n'.repeat(n),
  'setext (a, ---, blank)': (n) => 'a\n---\n\n'.repeat(n),
  'setext (a, ===)': (n) => 'a\n===\n'.repeat(n),
  'equals lines': (n) => '=\n'.repeat(n),
  'one nested line (* * * a)': (n) => '* '.repeat(n) + 'a',
  'one nested quote line (> > > a)': (n) => '> '.repeat(n) + 'a',
  'deep lines (32 quotes each)': (n) => ('> '.repeat(32) + 'a\n').repeat(n),
  'deep list lines (32 bullets each)': (n) => ('* '.repeat(32) + 'a\n').repeat(n),
  'indented lines (62 spaces)': (n) => (' '.repeat(62) + '- a\n').repeat(n),
  'backticks and backslashes': (n) => '```\\'.repeat(n),
  'one unbroken word (a-)': (n) => 'a-'.repeat(n),
  'one unbroken word (a---)': (n) => 'a---'.repeat(n),
  'unclosed comments (# <!--)': (n) => '# <!--'.repeat(n),
  'markers after a comment (-->*)': (n) => '-->*'.repeat(n),
  'footnote definition and backslash': (n) => '[^a]: \\'.repeat(n),
  'html p tags (<p>x)': (n) => '<p>x'.repeat(n),
  'html b+p tags': (n) => '<b><p>'.repeat(n),
  'html li tags': (n) => '<li>'.repeat(n),
  'html a tags': (n) => '<a href="x">'.repeat(n),
  'paragraphs (a)': (n) => 'a\n\n'.repeat(n),
  'list items (- a)': (n) => '- a\n'.repeat(n),
  'ordered items (1. a)': (n) => '1. a\n'.repeat(n),
  'headings (# a)': (n) => '# a\n\n'.repeat(n),
  'table rows': (n) => '| h | h |\n|---|---|\n' + '| a | b |\n'.repeat(n),
  'definitions ([a]: b)': (n) => '[a]: b\n'.repeat(n),
  'footnote definitions': (n) => '[^1]: a\n\n'.repeat(n),
  'text lines': (n) => 'word word\n'.repeat(n),
  'links ([a](b) )': (n) => '[a](b) '.repeat(n),
  'emphasis (*a* )': (n) => '*a* '.repeat(n),
  'code spans (`a` )': (n) => '`a` '.repeat(n),
  'fences': (n) => '```\na\n```\n\n'.repeat(n),
  // Nodes the parser makes in a blink and the stages after it do not (RA-9 review): every link literal and every table cell is a node.
  'www addresses (www.a.co )': (n) => 'www.a.co '.repeat(n),
  'http addresses (http://a.co )': (n) => 'http://a.co '.repeat(n),
  'e-mail addresses (a@b.co )': (n) => 'a@b.co '.repeat(n),
  'mailto addresses (mailto:a@b.co )': (n) => 'mailto:a@b.co '.repeat(n),
  'www addresses, 100 to a paragraph': (n) => ('www.a.co '.repeat(100) + '\n\n').repeat(Math.ceil(n / 100)),
  'www addresses, 10 to a paragraph': (n) => ('www.a.co '.repeat(10) + '\n\n').repeat(Math.ceil(n / 10)),
  // remark-directive reads a text directive at every colon; an unclosed opener is tried against the whole rest of the paragraph.
  'directive starts (:a b )': (n) => ':a b '.repeat(n),
  'directives with attributes (:a{b} )': (n) => ':a{b} '.repeat(n),
  'colons between letters (a:b )': (n) => 'a:b '.repeat(n),
  'colons before a list lookalike (:1. )': (n) => ':1. '.repeat(n),
  'unclosed comments after text (x <!--a)': (n) => 'x ' + '<!--a '.repeat(n),
  'unclosed comments, one per 540 chars': (n) => 'x ' + ('<!--a ' + 'lorem ipsum dolor sit amet '.repeat(20)).repeat(n),
  'unclosed CDATA sections': (n) => 'x ' + '<![CDATA[a '.repeat(n),
  'unclosed processing instructions': (n) => 'x ' + '<?a '.repeat(n),
  'unclosed declarations': (n) => 'x ' + '<!A a '.repeat(n),
  'entities before a bracket (&amp;])': (n) => '&amp;]'.repeat(n),
  'table of n columns, 5 rows': (n) => tableRow(n, ' h ') + tableRow(n, '---') + tableRow(n, ' a ').repeat(3),
  'table of 5 columns': (n) => tableRow(5, ' h ') + tableRow(5, '---') + tableRow(5, ' a ').repeat(n),
  'table of 50 columns': (n) => tableRow(50, ' h ') + tableRow(50, '---') + tableRow(50, ' a ').repeat(n),
  // Constructs that are priced by their marker characters, spread over many short paragraphs so that no run is long: the squared price
  // of a run does not see them, and each one is a node plus work in the stages after the parser (issue 119, the second review).
  'emphasis *a*, 10 to a paragraph': spread('*a* ', 10),
  'emphasis *a*, 25 to a paragraph': spread('*a* ', 25),
  'emphasis *a*, 50 to a paragraph': spread('*a* ', 50),
  'strong and emphasis ***a***, 10 to a paragraph': spread('***a*** ', 10),
  'links [a](b), 10 to a paragraph': spread('[a](b) ', 10),
  'links [a](b), 25 to a paragraph': spread('[a](b) ', 25),
  'links [a](b), 50 to a paragraph': spread('[a](b) ', 50),
  'links with an address, 25 to a paragraph': spread('[a](https://x.co/p) ', 25),
  'images ![a](b), 25 to a paragraph': spread('![a](b) ', 25),
  'code spans `a`, 25 to a paragraph': spread('`a` ', 25),
  'strike ~a~, 25 to a paragraph': spread('~a~ ', 25),
  'reference links [a] and a definition, 25 to a paragraph': (n) => '[a]: b\n\n' + spread('[a] ', 25)(n),
  'footnote references [^a] and a definition, 25 to a paragraph': (n) => '[^a]: b\n\n' + spread('[^a] ', 25)(n),
  'autolinks <a@b.co>, 25 to a paragraph': spread('<a@b.co> ', 25),
  'inline HTML <b>a</b>, 25 to a paragraph': spread('<b>a</b> ', 25),
  'hard breaks (a and a backslash)': (n) => ('a' + BACKSLASH + '\n').repeat(n),
  'list items with 25 emphasis': (n) => ('- ' + '*a* '.repeat(25) + '\n').repeat(n),
}

/** What a post may hold (PostCreateRequest): the probe never builds a text longer than this. */
const POST_LIMIT = 500_000

/** The most units of a shape whose estimate is not over the budget, and whose text fits in a post (the estimate only grows with the units). */
function largestInsideBudget(make: (units: number) => string): number {
  let low = 1
  let high = 2
  while (parseCost(make(high)).overBudgetAt === 0 && make(high).length < POST_LIMIT) high *= 2
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2)
    if (parseCost(make(middle)).overBudgetAt === 0 && make(middle).length <= POST_LIMIT) low = middle
    else high = middle
  }
  return low
}

/** The fastest of two runs, in ms, or -1 when the run throws: the first one pays for the warm-up of the engine, and a busy machine only ever adds. */
async function best(run: () => unknown): Promise<number> {
  let fastest = Infinity
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = performance.now()
    try {
      await run()
    } catch {
      return -1
    }
    fastest = Math.min(fastest, performance.now() - started)
  }
  return fastest
}

describe.skipIf(process.env.PARSE_PROBE !== '1')('the parse budget against the real parser', () => {
  it('measures every shape at the biggest text the budget admits', { timeout: 3_600_000 }, async () => {
    const out = process.env.PARSE_PROBE_OUT
    const say = (line: string) => (out ? appendFileSync(out, `${line}\n`) : process.stderr.write(`${line}\n`))
    if (out) writeFileSync(out, '')
    say(`budget ${PARSE_BUDGET} ms; shape | units | characters | estimate | parse ms | feed pipeline ms | page pipeline ms`)
    const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective)
    const only = process.env.PARSE_PROBE_SHAPE ? new RegExp(process.env.PARSE_PROBE_SHAPE, 'i') : undefined
    for (const [name, make] of Object.entries(SHAPES)) {
      if (only && !only.test(name)) continue
      const units = largestInsideBudget(make)
      const text = make(units)
      const cost = parseCost(text)
      const parseMs = await best(() => parser.parse(text))
      const pipeline = await best(() => renderMarkdownToFeedHtml(text, 'https://example.test/p'))
      const page = await best(() => renderMarkdown(text))
      say(
        `${name.padEnd(38)} | ${String(units).padStart(7)} | ${String(text.length).padStart(7)} | ${cost.weight.toFixed(0).padStart(5)} | ` +
          `${parseMs < 0 ? 'throws' : parseMs.toFixed(0).padStart(6)} | ${pipeline < 0 ? 'throws' : pipeline.toFixed(0).padStart(6)} | ` +
          `${page < 0 ? 'throws' : page.toFixed(0).padStart(6)}`,
      )
    }
  })
})
