// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_CONTAINER_DEPTH,
  PARSE_BUDGET,
  PARSE_PRICE,
  PLAIN_MAX_PARAGRAPHS,
  parseBudgetProblem,
  parseCost,
  plainTextTree,
  type ParseDriver,
} from './parse-budget'

/**
 * The guard is a count, not a clock: nothing here measures time. The prices come from measurements of the real parser
 * (`parse-budget.probe.test.ts` repeats them with `PARSE_PROBE=1`), and these tests pin what the count says about the shapes that
 * made the parser slow, and about the documents it must leave alone.
 */

/** The most units of `make` that are still inside the budget. */
function largestInside(make: (units: number) => string): number {
  let low = 1
  let high = 2
  while (parseCost(make(high)).overBudgetAt === 0) high *= 2
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2)
    if (parseCost(make(middle)).overBudgetAt === 0) low = middle
    else high = middle
  }
  return low
}

/** One row of a table: `cells` cells of the text `cell`. */
function tableRow(cells: number, cell: string): string {
  return '|' + (cell + '|').repeat(cells) + '\n'
}

/** A table of `columns` columns, a header, the delimiter row and `rows` rows. */
function table(columns: number, rows: number): string {
  return tableRow(columns, ' h ') + tableRow(columns, '---') + tableRow(columns, ' a ').repeat(rows)
}

/** Every shape the parser reads slower than linear, with what the count must name as the reason. */
const SHAPES: [name: string, make: (units: number) => string, driver: ParseDriver | undefined][] = [
  ['a run of emphasis and bracket markers', (n) => '*]'.repeat(n), 'markers'],
  ['a run of emphasis markers and letters', (n) => '*a'.repeat(n), 'markers'],
  ['a run of underscores and letters', (n) => '_a'.repeat(n), 'markers'],
  ['a run of bracket pairs', (n) => '[a]'.repeat(n), 'markers'],
  ['thousands of quotes', (n) => '>\n\n'.repeat(n), 'quotes'],
  ['thousands of quotes with text', (n) => '> a\n\n'.repeat(n), 'quotes'],
  ['thousands of underlined headings', (n) => 'a\n---\n\n'.repeat(n), undefined],
  ['thousands of headings underlined with equals signs', (n) => 'a\n===\n'.repeat(n), undefined],
  ['a run of backticks and backslashes', (n) => '```\\'.repeat(n), 'markers'],
  ['one unbroken word with hyphens', (n) => 'a-'.repeat(n), 'words'],
  ['thousands of HTML tags', (n) => '<p>x'.repeat(n), 'tags'],
  ['thousands of unclosed HTML comments', (n) => '# <!--'.repeat(n), 'openers'],
  ['thousands of nested HTML tags', (n) => '<b><p>'.repeat(n), 'tags'],
  ['thousands of paragraphs', (n) => 'a\n\n'.repeat(n), 'lines'],
  ['thousands of list items', (n) => '- a\n'.repeat(n), 'lines'],
  // Shapes the parser reads in a blink and the stages after it do not: every link literal and every table cell is a node.
  ['a run of www. addresses', (n) => 'www.a.co '.repeat(n), 'links'],
  ['a run of http:// addresses', (n) => 'http://a.co '.repeat(n), 'links'],
  ['a run of e-mail addresses', (n) => 'a@b.co '.repeat(n), 'links'],
  ['a run of mailto: addresses', (n) => 'mailto:a@b.co '.repeat(n), 'links'],
  // An unclosed comment, processing instruction or CDATA section is tried against the whole rest of the paragraph: (openers) x (characters).
  // The first line keeps the others from being read as one HTML block.
  [
    'a few hundred unclosed comments in a long paragraph',
    (n) => 'x ' + ('<!--a ' + 'lorem ipsum dolor sit amet '.repeat(20)).repeat(n),
    'openers',
  ],
  ['unclosed processing instructions', (n) => 'x ' + '<?a '.repeat(n), 'openers'],
  ['unclosed CDATA sections', (n) => 'x ' + '<![CDATA[a '.repeat(n), 'openers'],
  ['unclosed declarations', (n) => 'x ' + '<!A a '.repeat(n), 'openers'],
  // Text directives (remark-directive) are read at every colon, and the parser is not linear in the colons of one paragraph.
  ['a run of directive starts (:a b)', (n) => ':a b '.repeat(n), 'colons'],
  ['a run of directives with attributes', (n) => ':a{b} '.repeat(n), 'colons'],
  ['colons between letters', (n) => 'a:b '.repeat(n), 'colons'],
  ['colons before a list marker lookalike', (n) => ':1. '.repeat(n), 'colons'],
  ['a table of thousands of columns and five rows', (n) => table(n, 3), 'cells'],
  ['a table of five columns and thousands of rows', (n) => table(5, n), 'cells'],
  ['a table of fifty columns and thousands of rows', (n) => table(50, n), 'cells'],
]

describe('parseCost: what it admits and what it refuses', () => {
  it.each(SHAPES)(
    '%s: the biggest text inside the budget is read, one unit more is not, and the reason is named',
    (_name, make, driver) => {
      const units = largestInside(make)
      expect(units).toBeGreaterThan(100)

      expect(parseBudgetProblem(make(units))).toBeUndefined()

      const over = parseCost(make(units + 1))
      expect(over.overBudgetAt).toBeGreaterThan(0)
      if (driver) expect(over.driver).toBe(driver)
      expect(parseBudgetProblem(make(units + 1))?.code).toBe('too-heavy')
    },
  )

  it.each(SHAPES)('%s: at the 500,000 characters a post may have it is refused', (_name, make) => {
    let units = 1
    while (make(units).length < 500_000) units *= 2
    expect(parseCost(make(units)).overBudgetAt).toBeGreaterThan(0)
  })

  it('is cheap and quiet for prose, an empty text and text with Markdown it can read in a blink', () => {
    expect(parseCost('').overBudgetAt).toBe(0)
    expect(parseCost('').weight).toBe(0)
    expect(
      parseBudgetProblem('## Title\n\nA paragraph with *emphasis*, **strong** text and a [link](https://example.test).\n'),
    ).toBeUndefined()
    expect(parseBudgetProblem('word '.repeat(100_000))).toBeUndefined()
  })

  it('counts a stretch of text, not the whole article: the same markers in separate paragraphs are cheap', () => {
    const markers = 3000
    const oneParagraph = '*]'.repeat(markers / 2)
    const manyParagraphs = Array.from({ length: markers / 30 }, () => '*]'.repeat(15)).join('\n\n')

    expect(parseCost(manyParagraphs).weight).toBeLessThan(parseCost(oneParagraph).weight / 5)
    expect(parseBudgetProblem(manyParagraphs)).toBeUndefined()
  })

  it('reads the line breaks of Windows and old Mac files like those of Unix', () => {
    const unix = '> a\n\n'.repeat(3100)
    expect(parseCost(unix.replace(/\n/g, '\r\n')).overBudgetAt).toBeGreaterThan(0)
    expect(parseCost(unix.replace(/\n/g, '\r')).overBudgetAt).toBeGreaterThan(0)
    expect(parseCost(unix.replace(/\n/g, '\r\n')).weight).toBeCloseTo(parseCost(unix).weight, 5)
  })

  it('reports the line on which the budget ran out, and stops looking there', () => {
    const quotes = largestInside((n) => '>\n\n'.repeat(n))
    const text = '>\n\n'.repeat(quotes + 50)
    const cost = parseCost(text)
    // Every quote is a line and a blank line; the first line past the budget is one of the quotes added after those inside it.
    expect(cost.overBudgetAt).toBeGreaterThan(quotes * 2 - 2)
    expect(cost.overBudgetAt).toBeLessThanOrEqual((quotes + 50) * 2)
  })
})

describe('parseCost: colons, link literals and table cells', () => {
  it('prices the colons of a stretch squared and the total linearly, whatever stands next to them', () => {
    const run = ':a b '.repeat(20_000)
    const spread = (':a b '.repeat(100) + '\n\n').repeat(200)

    // 20,000 colons in one paragraph took 0.6 s to parse and 100 ms without remark-directive; in 200 paragraphs a third of that.
    expect(parseCost(run).driver).toBe('colons')
    expect(parseCost(run).overBudgetAt).toBeGreaterThan(0)
    expect(parseCost(spread).weight).toBeLessThan(parseCost(run).weight / 2)
    expect(parseCost(spread).weight).toBeGreaterThan(20_000 * PARSE_PRICE.colon)
    // Prose with the colons of prose is nothing: a sentence, a time, a URL scheme, a block fence.
    const prose = 'Note: it starts at 12:30, see https://example.test/a or :::callout and std::string. '.repeat(200)
    expect(parseBudgetProblem(prose)).toBeUndefined()
  })

  it.each([
    ['www.', 'www.a.co'],
    ['www. in capitals', 'WWW.a.co'],
    ['http://', 'http://a.co'],
    ['https://', 'https://a.co'],
    ['an e-mail address', 'a@b.co'],
    ['mailto:', 'mailto:a@b.co'],
    ['xmpp:', 'xmpp:a@b.co'],
  ])('counts a place where %s can start', (_name, word) => {
    const text = `${word} `.repeat(20_000)
    const cost = parseCost(text)
    expect(cost.driver).toBe('links')
    expect(cost.overBudgetAt).toBeGreaterThan(0)
    // One place for each word, whatever else stands in it (`mailto:a@b.co` is one address, not two).
    const colons = (word.match(/:/g) ?? []).length * 1000
    const links = 1000 * PARSE_PRICE.link + PARSE_PRICE.link2 * 1000 * 1000
    const colonCost = PARSE_PRICE.colon * colons + PARSE_PRICE.colon2 * colons * colons
    const weight = parseCost(`${word} `.repeat(1000)).weight
    expect(weight).toBeGreaterThan(links)
    expect(weight).toBeLessThan(links + colonCost + 1)
  })

  it('does not take prose with colons, dots and the word www for a link', () => {
    const prose = 'Note: the www of 1990, a.b.c, 12:30 and a site (example dot com) are not links. '.repeat(1000)
    const plain = prose.replace(/www/g, 'wxw')
    expect(parseCost(prose).weight).toBeCloseTo(parseCost(plain).weight, 3)
    expect(parseBudgetProblem(prose)).toBeUndefined()
  })

  it('prices a stretch squared and the total linearly: spread out links cost far less than one run, but they add up', () => {
    const run = 'www.a.co '.repeat(10_000)
    const spread = ('www.a.co '.repeat(100) + '\n\n').repeat(100)

    expect(parseCost(spread).weight).toBeLessThan(parseCost(run).weight / 2)
    // The same 10,000 links, 100 to a paragraph, still cost what each node costs.
    expect(parseCost(spread).weight).toBeGreaterThan(10_000 * PARSE_PRICE.link)
    // 50,000 links in 500 paragraphs took 3 s through the page pipeline: refused, though no paragraph is long.
    expect(parseCost(('www.a.co '.repeat(100) + '\n\n').repeat(500)).overBudgetAt).toBeGreaterThan(0)
    expect(parseCost(('www.a.co '.repeat(100) + '\n\n').repeat(500)).driver).toBe('links')
  })

  it('counts the colons of block fences too, so 300 fences of 302 colons down to 3 are refused by the budget before the nesting guard', () => {
    // An upper bound, not a copy of the parser: a fence is not a text directive, but 45,000 colons in one stretch cost the tokenizer.
    const fences = Array.from({ length: 300 }, (_, index) => `${':'.repeat(302 - index)}\t`).join('\n')

    expect(parseCost(fences).driver).toBe('colons')
    expect(parseBudgetProblem(fences)?.code).toBe('too-heavy')
    const fewer = Array.from({ length: 100 }, (_, index) => `${':'.repeat(102 - index)}\t`).join('\n')
    expect(parseBudgetProblem(fewer)).toBeUndefined()
  })

  it('prices a table by its cells, in one row and over all rows', () => {
    // 20,000 columns by five rows took 11 s; 50 columns by 2,000 rows took 5 s: both refused, neither is a long line or a long word.
    expect(parseCost(table(20_000, 3)).overBudgetAt).toBeGreaterThan(0)
    expect(parseCost(table(20_000, 3)).driver).toBe('cells')
    expect(parseCost(table(50, 2000)).overBudgetAt).toBeGreaterThan(0)
    expect(parseCost(table(50, 2000)).driver).toBe('cells')
    // A row with the same cells in two rows costs less than in one.
    expect(parseCost(tableRow(6000, ' a ')).weight).toBeGreaterThan(parseCost(tableRow(3000, ' a ').repeat(2)).weight)
  })

  it('reads the tables and the links of a real article', () => {
    expect(parseBudgetProblem(table(10, 200))).toBeUndefined()
    expect(parseBudgetProblem(table(30, 40))).toBeUndefined()
    expect(parseBudgetProblem('See www.example.test, https://example.test/a and a@example.test.\n\n'.repeat(300))).toBeUndefined()
  })
})

/** `unit` repeated `perParagraph` times in a paragraph, and as many paragraphs as `units` needs. */
function spread(unit: string, perParagraph: number): (units: number) => string {
  return (units) => (unit.repeat(perParagraph) + '\n\n').repeat(Math.ceil(units / perParagraph))
}

describe('parseCost: markers cost something each, however they are spread', () => {
  // Measured through the whole page pipeline (`parse-budget.probe.test.ts`, issue 119, second review): every emphasis, link, code span,
  // image or footnote reference is a node and work in the stages after the parser, a few hundredths of a millisecond per marker character.
  // The square of a paragraph's markers does not see them when the paragraphs are short, so 62,400 links, 25 to a paragraph, cost 1,500
  // by the old estimate and took 4 s (5.6 s on the machine of the review).
  it.each([
    ['emphasis, 10 to a paragraph', '*a* ', 10],
    ['emphasis, 25 to a paragraph', '*a* ', 25],
    ['emphasis, 50 to a paragraph', '*a* ', 50],
    ['strong emphasis, 10 to a paragraph', '***a*** ', 10],
    ['links, 10 to a paragraph', '[a](b) ', 10],
    ['links, 25 to a paragraph', '[a](b) ', 25],
    ['images, 25 to a paragraph', '![a](b) ', 25],
    ['code spans, 25 to a paragraph', '`a` ', 25],
    ['strikethrough, 25 to a paragraph', '~a~ ', 25],
    ['footnote references, 25 to a paragraph', '[^a] ', 25],
  ])('%s: refused long before it takes seconds, and a real article is far from it', (name, unit, perParagraph) => {
    const inside = largestInside(spread(unit, perParagraph))

    // Before the linear price the biggest text inside the budget held 43,000 to 62,000 units and took 2 to 4 s; now it holds a third.
    expect(inside).toBeLessThan(20_000)
    // 2,000 units of markup (a long, link-heavy article has a few hundred) must stay inside.
    expect(inside).toBeGreaterThan(2_000)
    // A footnote reference is also a back-reference link in the definition, 0.13 to 0.15 ms each through the page pipeline: its own counter.
    const driver = name.startsWith('footnote') ? 'footnotes' : 'markers'
    expect(parseCost(spread(unit, perParagraph)(inside + perParagraph * 10)).driver).toBe(driver)
  })

  it('prices every marker character, in separate paragraphs and in one', () => {
    const separate = parseCost(spread('*a* ', 1)(1000))
    const together = parseCost(spread('*a* ', 1000)(1000))

    // 2,000 markers: the linear part alone is what the separate paragraphs cost beyond their lines.
    expect(separate.weight).toBeGreaterThan(2000 * PARSE_PRICE.marker + 1000 * PARSE_PRICE.line - 1)
    expect(together.weight).toBeGreaterThan(separate.weight)
  })

  it('leaves prose with the occasional emphasis, link and code span far inside the budget', () => {
    const article =
      'Some *emphasis*, a [link](https://example.test/a), `code` and **strong** text in a sentence that goes on a while.\n\n'
    expect(parseCost(article.repeat(500)).weight).toBeLessThan(PARSE_BUDGET / 2)
    expect(parseBudgetProblem(article.repeat(500))).toBeUndefined()
  })
})

describe('parseCost: containers a line sits in', () => {
  it('allows a line as deep as the limit and refuses one level more, whatever mix of quotes and list items makes it', () => {
    expect(parseBudgetProblem('> '.repeat(MAX_CONTAINER_DEPTH) + 'a')).toBeUndefined()
    expect(parseBudgetProblem('* '.repeat(MAX_CONTAINER_DEPTH) + 'a')).toBeUndefined()
    expect(parseBudgetProblem('> '.repeat(MAX_CONTAINER_DEPTH + 1) + 'a')?.code).toBe('too-heavy')
    expect(parseBudgetProblem('* '.repeat(MAX_CONTAINER_DEPTH + 1) + 'a')?.code).toBe('too-heavy')
    expect(parseBudgetProblem('1. > - '.repeat(11) + 'a')?.code).toBe('too-heavy')
    expect(parseCost('> '.repeat(MAX_CONTAINER_DEPTH + 1) + 'a').driver).toBe('nesting')
  })

  it('counts two columns of indent as a level, because that is the least a nested list item needs', () => {
    // The bullet is one level, every two columns in front of it another.
    expect(parseBudgetProblem(' '.repeat(2 * (MAX_CONTAINER_DEPTH - 1)) + '- a')).toBeUndefined()
    expect(parseBudgetProblem(' '.repeat(2 * MAX_CONTAINER_DEPTH) + '- a')?.code).toBe('too-heavy')
    expect(parseBudgetProblem('\t'.repeat(17) + '- a')?.code).toBe('too-heavy')
  })

  it('adds up the depth of every line, so a few levels over thousands of lines are priced too', () => {
    const shallow = parseCost('> a\n'.repeat(1000))
    const deep = parseCost(('> '.repeat(30) + 'a\n').repeat(1000))
    expect(deep.weight).toBeGreaterThan(shallow.weight)
    // 30 levels over 1000 lines is 30,000 steps; the lines themselves are the same.
    expect(deep.weight - shallow.weight).toBeGreaterThan(29 * 1000 * 0.004)
  })

  it('does not take a thematic break, an emphasis marker or a number in a sentence for a container', () => {
    const noise = ['---', '***', '*emphasis* at the start', '2026 was a year', '1.5 liters', '-5 degrees', 'a > b'].join('\n')
    expect(parseCost(noise).weight).toBeCloseTo(parseCost(['x', 'x', 'x', 'x', 'x', 'x', 'x'].join('\n')).weight, 0)
  })
})

describe('parseCost: the documents of this repository stay far from the budget', () => {
  const docs = join(process.cwd(), '..', 'docs')
  const files = existsSync(docs)
    ? [
        'content-blocks.md',
        'ai-article-authoring.md',
        'SECURITY.md',
        'CONFIGURATION.md',
        'ADMIN-GUIDE.md',
        'CONVENTIONS.md',
        'post-file-format.md',
      ]
    : []

  // Half, not a third, since the markers of a document are priced one by one too (issue 119): the 111 KB SECURITY.md has 2,700 of them.
  it.each(files)('%s costs less than half of the budget', (file) => {
    const text = readFileSync(join(docs, file), 'utf8')
    const cost = parseCost(text)
    expect(cost.overBudgetAt).toBe(0)
    expect(cost.weight).toBeLessThan(PARSE_BUDGET / 2)
  })
})

describe('plainTextTree: an article read without Markdown', () => {
  /** The texts of the paragraphs of a tree; fails if a paragraph holds anything but one text node. */
  const texts = (tree: ReturnType<typeof plainTextTree>) =>
    tree.children.map((paragraph) => {
      expect(paragraph.type).toBe('paragraph')
      const kids = (paragraph as { children: { type: string; value?: string }[] }).children
      expect(kids.map((kid) => kid.type)).toEqual(['text'])
      return kids[0]!.value
    })

  it('keeps every character as text, in one paragraph for each run of lines', () => {
    const tree = plainTextTree('# not a heading\n*not emphasis*\n\n\n<script>alert(1)</script>\r\n[not](a-link)\n')

    expect(texts(tree)).toEqual(['# not a heading\n*not emphasis*', '<script>alert(1)</script>\n[not](a-link)'])
  })

  it('is empty for an empty or blank article, and never reads a blank line as text', () => {
    expect(plainTextTree('').children).toEqual([])
    expect(plainTextTree('  \n\t\n\n').children).toEqual([])
  })

  it('records the line on which each paragraph starts', () => {
    const tree = plainTextTree('a\n\nb\nc')
    const lines = JSON.stringify(tree).match(/"line":\d+/g)
    expect(lines).toEqual(['"line":1', '"line":1', '"line":3', '"line":3'])
  })

  it('has at most PLAIN_MAX_PARAGRAPHS paragraphs, however many the article has, and loses no text', () => {
    // Many paragraphs of one line, and one paragraph of many lines: the stages after the parser are not linear in either.
    const many = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n\n')
    const tree = plainTextTree(many)

    expect(tree.children.length).toBeLessThanOrEqual(PLAIN_MAX_PARAGRAPHS)
    expect(tree.children.length).toBeGreaterThan(PLAIN_MAX_PARAGRAPHS / 2)
    expect(texts(tree).join('\n\n')).toBe(many)

    const longRun = '>\n'.repeat(250_000)
    expect(texts(plainTextTree(longRun))).toEqual([longRun.trimEnd()])
  })
})
