import type { Paragraph, Root } from 'mdast'
import type { Processor } from 'unified'
import type { Problem } from './types'

/**
 * How much work an article may ask of the Markdown parser before it is shown as plain text.
 *
 * Why a budget exists. Everything an author writes is parsed on the one event loop of the Next process, on every render of the page,
 * of the feeds and of the editor preview, and the parser (`micromark`, with `remark-gfm`) is slower than linear for ordinary shapes:
 * a run of emphasis markers or of `]` costs the square of its length, so does a document of thousands of quotes or of headings
 * underlined with `---`, and a line that nests quotes and list items costs the square of its depth. Measured on this stack (the
 * numbers are in `docs/SECURITY.md`, "Markdown in posts"): 24 KB of `*]` took 25 s, 100 KB of `a`, a line and `---` took 46 s, 100 KB
 * of `> a` quotes took 42 s, and the 500,000 characters a post may have take minutes. The size limit of a post does not bound any of
 * it, and the block-nesting guard of `./nesting.ts` looks only at `:::` blocks. Not everything slow is in the parser: every link
 * literal (`www.a.co`), every table cell and every text directive is a node, and the stages after the parser are not linear in the
 * nodes of one paragraph or one table row (450 KB of `www.a.co ` parsed in 3.5 s and took 24 s through the page pipeline).
 *
 * The cost cannot be cut short once the parser has started (it is synchronous), so it is estimated first, in one pass over the lines
 * and without parsing anything: {@link parseCost} adds up a handful of counters, each priced from a measurement, into a number of
 * milliseconds that an article would take at its worst on the machine the prices were measured on. {@link PARSE_BUDGET} is the most a
 * page may spend. Past it the article is read WITHOUT Markdown ({@link plainTextReader}: its paragraphs, at most 400, every
 * character as text) and one `too-heavy` problem is reported, the way `too-deep` is for blocks. The text is never lost.
 *
 * The count is an upper bound by construction, not a copy of the parser. It does not look at code fences (an author could make it
 * skip the wrong lines, and a code sample counts like text, which only raises the number), a line it takes for a quote or a list item
 * may be neither, and every character of a family counts wherever it stands. An article that the parser reads quickly can therefore be
 * reported (a code sample of hundreds of lines with brackets and underscores and no blank line: micromark reads a well-formed fence
 * without parsing inline, but the scan does not tell a fence from text); the author sees the problem and splits the text, a long code
 * sample into several code blocks. `./parse-budget.test.ts` holds
 * the guard, and its probe (`PARSE_PROBE=1`) measures the real parser again after an upgrade of `remark` or `micromark`.
 */

/**
 * The most an article may cost, in milliseconds at the prices below. A page that spends all of it is read in 0.9 s or less through the
 * whole page pipeline at the worst of the 75 shapes of the probe, measured on a workstation with other jobs running; the machines of the
 * earlier sweeps (a loaded laptop) read up to twice as slow, so plan for two seconds. The busiest legitimate documents of the repository
 * cost 56 percent of it at most (`backend/README.md`, 146 KB, 838; `docs/SECURITY.md`, 508; `docs/content-blocks.md`, 357).
 */
export const PARSE_BUDGET = 1500

/**
 * What one unit of each counter costs, in milliseconds. Each price is the worst measured on the real parser, rounded up:
 * - `line`: a line that is not blank. Plain paragraphs, headings, table rows and list items cost 0.1 to 0.3 ms each through the whole
 *   pipeline at 15,000 lines (the busiest document of the repository has 1,142).
 * - `marker`: a marker character, `*` `_` `~` `[` `]` or the backtick, wherever it stands. Every emphasis, link, image, code span and
 *   footnote reference is a node, and the stages after the parser (`rehype-raw`, the sanitizer, the plugins that walk the tree, the JSX
 *   conversion) do work for each: 0.01 to 0.03 ms per marker character through the page pipeline on 40,000 to 60,000 emphasis spans, links, images or code spans spread
 *   over short paragraphs (25 links in a paragraph: 4 s for 62,400 of them, and 5.6 s on the machine of the second review), 0.04 rounded up.
 *   The squared price below does not see these, since the markers of a short paragraph are few; the first sweep priced only the squared one.
 * - `footnote`: a `[^`, the start of a footnote reference (or definition). Every reference is a node and, in the definition it points at,
 *   a back-reference link, and the stages after the parser are not linear in what one definition holds: 14,400 references to one
 *   footnote took 2.1 s through the page pipeline (0.13 to 0.15 ms each, whatever the paragraph holds), and the references to a footnote
 *   that is not defined cost only their markers (it is a bound, so they count too). 0.16 rounded up.
 * - `marker` squared: the markers of one run of non-blank lines, against each other. The inline parser resolves them inside a
 *   paragraph; the worst shapes (`*]`, `-->~`, a run of backticks and backslashes) cost 4e-5 to 1.2e-4 ms per marker squared.
 * - `quote` squared: a block quote that starts after a line that is not a quote line. 2e-4 ms per quote squared (`>` and a blank line).
 * - `underline` squared: a line of `=` or `-` right after a line of text, which makes a heading of it (setext), 2.4e-4 ms squared.
 * - `step`: the sum, over the lines, of the containers (quote markers, list markers, two columns of indent) a line sits in. The parser
 *   checks a line against each one: 5 microseconds each, the price `MAX_BLOCK_WORK` of `./nesting.ts` uses for blocks.
 * - `tag` squared: an HTML tag or comment start. `rehype-raw`, the sanitizer and the parser's own HTML constructs cost 1e-5 ms per tag
 *   squared for `<p>x`; 8e-5 covers the generic case (the unclosed openers have a price of their own, below).
 * - `word` squared: a run of characters with no space or line break in it. The GFM autolink scan looks back over the whole run at every
 *   `-`, `.`, `_` or `@`, so one unbroken word of 40,000 characters costs 1.2 s and one of 500,000 costs minutes; 1e-6 ms per character squared.
 * - `link`: a place where the GFM autolink literal can start (`www.`, `://`, an `@`). Every one that is a link becomes a node, and the
 *   stages after the parser (`rehype-raw`, the sanitizer, the plugins that walk siblings, the JSX conversion) cost 0.05 to 0.07 ms for each
 *   node of an article spread over paragraphs, 0.06 for 20,000 of them. Plain text with no Markdown in it, so the parser is quick (450 KB of
 *   `www.a.co ` parsed in 3.5 s) but the page is not: 24 s.
 * - `link` squared: the same candidates in one run of non-blank lines. Those stages are not linear in the children of ONE node: 32,000
 *   links in one paragraph took 11 s through the page pipeline, 1.1e-5 ms per link squared (8,000 took 0.9 s).
 * - `opener` times the characters of its run of non-blank lines: a `<!--`, a `<?`, a `<![CDATA[` or a `<!` and a letter that is not at
 *   the start of a line (there it opens an HTML block, which is read in one piece). The inline parser tries each one against the whole
 *   rest of the paragraph before it gives up, so a text with no `-->` costs (openers) x (characters), not the square of the openers: 1,600
 *   `<!--a` in 225 KB took 9.8 s, and 4,000 `<![CDATA[a` 15 s; 1e-4 ms per opener and character.
 * - `colon`: a `:`. `remark-directive` (the block syntax of the articles) tries to read a text directive at every one, and the directives it
 *   finds are nodes: 14 to 20 microseconds each in the parser and about as much after it, measured on `:a `, `:a{b} `, `a:b ` and `:1. `
 *   (the sweep that priced the markers ran the parser without `remark-directive` and never saw it).
 * - `colon` squared: the colons in one run of non-blank lines. The tokenizer is not linear in the colons of one paragraph: 40,000 of them in
 *   one run took 1.5 s, 6 s for `a:b `, and the same 20,000 in 200 paragraphs 0.2 to 0.4 s; 3e-6 ms per colon squared.
 * - `cell`: a `|` of a line, the separator of the cells of a table row. Every cell is a node with its own text; 0.06 to 0.1 ms through the page
 *   pipeline whatever the shape of the table (50 columns by 3,200 rows, 2 by 3,000, 10 by 1,600).
 * - `cell` squared: the sum, over the lines, of the squares of their `|`. One row with thousands of cells is not linear either: 4,000
 *   columns by 5 rows took 1.5 s, 8,000 took 3.8 s, about 5e-6 ms per cell squared of a row.
 */
export const PARSE_PRICE = {
  line: 0.3,
  marker: 0.04,
  footnote: 0.16,
  marker2: 1.2e-4,
  quote2: 2e-4,
  underline2: 2.4e-4,
  step: 0.005,
  tag2: 8e-5,
  word2: 1e-6,
  link: 0.07,
  link2: 1.2e-5,
  colon: 0.04,
  colon2: 3e-6,
  opener: 1e-4,
  cell: 0.1,
  cell2: 3e-6,
} as const

/**
 * Containers a single line may sit in. A line that opens quotes and list items one after another (`* * * ... a`, `> > > ... a`) costs the
 * square of its depth to the parser, and a real article nests three levels. Two columns of indent count as one level, since a nested
 * list item needs at least that.
 */
export const MAX_CONTAINER_DEPTH = 32

export type ParseDriver =
  | 'lines'
  | 'markers'
  | 'footnotes'
  | 'quotes'
  | 'underlines'
  | 'nesting'
  | 'tags'
  | 'openers'
  | 'words'
  | 'links'
  | 'colons'
  | 'cells'

export interface ParseCost {
  /** The estimate, in milliseconds. */
  readonly weight: number
  /** What the biggest share of it comes from. */
  readonly driver: ParseDriver
  /** The first line (1-based) at which the estimate passed {@link PARSE_BUDGET}, or 0 when it did not. */
  readonly overBudgetAt: number
}

const SPACE = 32
const TAB = 9
const GT = 62
const STAR = 42
const PLUS = 43
const DASH = 45
const EQUALS = 61
const LT = 60
const SLASH = 47
const BANG = 33
const QUESTION = 63
const DOT = 46
const PAREN = 41
const COLON = 58
const AT = 64
const PIPE = 124
const CARET = 94

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/** True for a line that holds only spaces and tabs: the parser's blank line. */
function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code !== SPACE && code !== TAB) return false
  }
  return true
}

/** `=` or `-` only, up to three spaces in front and spaces after: the line under a text line that makes it a heading. */
function isUnderline(line: string): boolean {
  let i = 0
  while (i < 3 && line.charCodeAt(i) === SPACE) i += 1
  const first = line.charCodeAt(i)
  if (first !== EQUALS && first !== DASH) return false
  while (line.charCodeAt(i) === first) i += 1
  for (; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code !== SPACE && code !== TAB) return false
  }
  return true
}

/** True when the character at `at` ends a list marker: a space, a tab, or the end of the line. */
function endsMarker(line: string, at: number): boolean {
  if (at >= line.length) return true
  const code = line.charCodeAt(at)
  return code === SPACE || code === TAB
}

/**
 * The containers the line sits in, as the scan reads them: every quote marker and list marker in front of the text (a bullet, or digits
 * and a dot or a parenthesis, then white space or the end), plus one level for every two columns of indent that are not the space
 * after a marker. Spaces, tabs and the markers may follow one another in any order, so `> > - 1) x` is four. Returns the depth and whether a quote marker was among them.
 */
function containersOf(line: string): { depth: number; quoted: boolean } {
  let i = 0
  let columns = 0
  let markers = 0
  let quoted = false
  // One space or tab right after a marker is part of the marker (`> a`, `- a`), not indent.
  const skipMarkerSpace = () => {
    const code = line.charCodeAt(i)
    if (code === SPACE || code === TAB) i += 1
  }
  for (;;) {
    const code = line.charCodeAt(i)
    if (code === SPACE) {
      columns += 1
      i += 1
    } else if (code === TAB) {
      columns += 4
      i += 1
    } else if (code === GT) {
      markers += 1
      quoted = true
      i += 1
      skipMarkerSpace()
    } else if ((code === STAR || code === PLUS || code === DASH) && endsMarker(line, i + 1)) {
      markers += 1
      i += 1
      skipMarkerSpace()
    } else if (isDigit(code)) {
      let end = i
      while (isDigit(line.charCodeAt(end))) end += 1
      const after = line.charCodeAt(end)
      if (end - i <= 9 && (after === DOT || after === PAREN) && endsMarker(line, end + 1)) {
        markers += 1
        i = end + 1
        skipMarkerSpace()
      } else {
        break
      }
    } else {
      break
    }
  }
  return { depth: markers + (columns >> 1), quoted }
}

const BACKTICK = 96

/**
 * True when the line has `www.` at `at`, in any case. The scan counts every such place, whatever stands in front of it, so it is a
 * bound on the places where a link literal can start and not a copy of the rules for them.
 */
function startsWww(line: string, at: number): boolean {
  return (
    (line.charCodeAt(at) | 32) === 119 &&
    (line.charCodeAt(at + 1) | 32) === 119 &&
    (line.charCodeAt(at + 2) | 32) === 119 &&
    line.charCodeAt(at + 3) === DOT
  )
}

/** True when `<!` at the character before `at` opens a comment (`--`), a CDATA section (`[`) or a declaration (a letter). */
function endlessOpener(line: string, at: number): boolean {
  const code = line.charCodeAt(at)
  return (code === DASH && line.charCodeAt(at + 1) === DASH) || code === 91 || isLetter(code)
}

/**
 * Counts, in a line, the characters that the inline parser has to resolve against each other (`markers`), its HTML tags, the places
 * where an autolink literal can start (`links`: `www.`, `://` and `@`, which also covers `mailto:` and `xmpp:`), its `:` (`colons`: where a
 * text directive can start), its `|` (`pipes`: the cells of a table row), and the sum of the squares of the lengths of its words (runs of characters with no space or tab).
 */
function inlineOf(line: string): {
  markers: number
  footnotes: number
  tags: number
  links: number
  colons: number
  pipes: number
  openers: number
  wordSquares: number
} {
  let markers = 0
  let footnotes = 0
  let tags = 0
  let links = 0
  let colons = 0
  let pipes = 0
  let openers = 0
  let wordSquares = 0
  let word = 0
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code === SPACE || code === TAB) {
      wordSquares += word * word
      word = 0
      continue
    }
    word += 1
    // * _ ~ [ ] `
    if (code === STAR || code === 95 || code === 126 || code === 91 || code === 93 || code === BACKTICK) {
      markers += 1
      if (code === 91 && line.charCodeAt(i + 1) === CARET) footnotes += 1
    } else if (code === LT) {
      const next = line.charCodeAt(i + 1)
      if (isLetter(next) || next === SLASH || next === BANG || next === QUESTION) tags += 1
      if (i > 0 && (next === QUESTION || (next === BANG && endlessOpener(line, i + 2)))) openers += 1
    } else if (code === AT) links += 1
    else if (code === PIPE) pipes += 1
    else if (code === COLON) {
      colons += 1
      if (line.charCodeAt(i + 1) === SLASH && line.charCodeAt(i + 2) === SLASH) links += 1
    } else if ((code | 32) === 119 && startsWww(line, i)) links += 1
  }
  return { markers, footnotes, tags, links, colons, pipes, openers, wordSquares: wordSquares + word * word }
}

/**
 * What an article would cost the parser, in one pass and without parsing. See the comment at the top of the file for the model; the
 * estimate grows with every line, so the first line at which it passes the budget is known too.
 */
export function parseCost(source: string): ParseCost {
  let lines = 0
  let chunkMarkers = 0
  let markerSquares = 0
  let markers = 0
  let footnotes = 0
  let quotes = 0
  let underlines = 0
  let steps = 0
  let tags = 0
  let wordSquares = 0
  let chunkLinks = 0
  let linkSquares = 0
  let links = 0
  let chunkColons = 0
  let colonSquares = 0
  let colons = 0
  let chunkOpeners = 0
  let chunkLength = 0
  let openerWork = 0
  let pipes = 0
  let pipeSquares = 0
  let weight = 0
  let driver: ParseDriver = 'lines'
  let overBudgetAt = 0
  let previousText = false
  let previousQuoted = false
  let number = 0

  const price = (): { weight: number; driver: ParseDriver } => {
    const parts: [ParseDriver, number][] = [
      ['lines', PARSE_PRICE.line * lines],
      ['markers', PARSE_PRICE.marker * markers + PARSE_PRICE.marker2 * (markerSquares + chunkMarkers * chunkMarkers)],
      ['footnotes', PARSE_PRICE.footnote * footnotes],
      ['quotes', PARSE_PRICE.quote2 * quotes * quotes],
      ['underlines', PARSE_PRICE.underline2 * underlines * underlines],
      ['nesting', PARSE_PRICE.step * steps],
      ['tags', PARSE_PRICE.tag2 * tags * tags],
      ['words', PARSE_PRICE.word2 * wordSquares],
      ['links', PARSE_PRICE.link * links + PARSE_PRICE.link2 * (linkSquares + chunkLinks * chunkLinks)],
      ['openers', PARSE_PRICE.opener * (openerWork + chunkOpeners * chunkLength)],
      ['colons', PARSE_PRICE.colon * colons + PARSE_PRICE.colon2 * (colonSquares + chunkColons * chunkColons)],
      ['cells', PARSE_PRICE.cell * pipes + PARSE_PRICE.cell2 * pipeSquares],
    ]
    let total = 0
    let top = parts[0]!
    for (const part of parts) {
      total += part[1]
      if (part[1] > top[1]) top = part
    }
    return { weight: total, driver: top[0] }
  }

  for (const line of source.split(/\r\n|\r|\n/)) {
    number += 1
    if (isBlank(line)) {
      markerSquares += chunkMarkers * chunkMarkers
      chunkMarkers = 0
      linkSquares += chunkLinks * chunkLinks
      chunkLinks = 0
      colonSquares += chunkColons * chunkColons
      chunkColons = 0
      openerWork += chunkOpeners * chunkLength
      chunkOpeners = 0
      chunkLength = 0
      previousText = false
      previousQuoted = false
      continue
    }
    lines += 1
    const { depth, quoted } = containersOf(line)
    steps += depth
    if (quoted && !previousQuoted) quotes += 1
    if (previousText && isUnderline(line)) underlines += 1
    const inline = inlineOf(line)
    chunkMarkers += inline.markers
    markers += inline.markers
    footnotes += inline.footnotes
    tags += inline.tags
    wordSquares += inline.wordSquares
    chunkLinks += inline.links
    links += inline.links
    chunkColons += inline.colons
    colons += inline.colons
    chunkOpeners += inline.openers
    chunkLength += line.length + 1
    pipes += inline.pipes
    pipeSquares += inline.pipes * inline.pipes
    previousText = true
    previousQuoted = quoted

    if (overBudgetAt === 0) {
      const now = price()
      if (now.weight > PARSE_BUDGET || depth > MAX_CONTAINER_DEPTH) {
        overBudgetAt = number
        driver = depth > MAX_CONTAINER_DEPTH ? 'nesting' : now.driver
        weight = Math.max(now.weight, PARSE_BUDGET + 1)
        // Past the budget the rest does not matter: the article is read as plain text.
        break
      }
    }
  }
  if (overBudgetAt === 0) {
    const last = price()
    weight = last.weight
    driver = last.driver
  }
  return { weight, driver, overBudgetAt }
}

const REASONS: Record<ParseDriver, string> = {
  lines: 'it has too many lines',
  markers:
    'it has too many emphasis, underscore, tilde, bracket and code characters (*, _, ~, [, ], `), together or in one stretch of text',
  footnotes: 'it has too many footnote references ([^note])',
  quotes: 'it has too many separate quotes',
  underlines: 'it has too many headings underlined with = or -',
  nesting: 'quotes and list items are nested too deeply',
  tags: 'it has too many HTML tags',
  words: 'it has a word, a link or a code string that is far too long',
  links: 'it has too many web addresses (www., http://, https://) or e-mail addresses written out as plain text',
  openers: 'it has too many HTML comments, processing instructions or declarations (<!--, <?, <![CDATA[) in one stretch of text',
  colons: 'it has too many colons in one stretch of text (the block syntax reads each one as the possible start of a directive)',
  cells: 'its tables have too many cells',
}

/**
 * The problem for an article that would cost the parser more than {@link PARSE_BUDGET}, or `undefined` for one that would not. Costs
 * next to nothing on any article the backend accepts (a single pass, nothing parsed).
 */
export function parseBudgetProblem(source: string): Problem | undefined {
  const cost = parseCost(source)
  if (cost.overBudgetAt === 0) return undefined
  return {
    line: cost.overBudgetAt,
    code: 'too-heavy',
    message:
      `This article is too heavy for the Markdown reader to process in time: ${REASONS[cost.driver]}. ` +
      'It is shown as plain text, without headings, links, emphasis, code or blocks. Split very long paragraphs, close or remove the ' +
      'markers you do not need, split a very long code sample into several code blocks, and split a very long article into parts.',
  }
}

/**
 * The most paragraphs the plain reading has. The stages after the parser (`rehype-raw`, the sanitizer, the plugins that walk and replace
 * siblings, the JSX conversion) are not linear in the number of children of ONE node, nor in the number of nodes of a big tree: 300,000
 * lines of `>` as one paragraph took minutes, as paragraphs of forty lines 11 s, and 100,000 one-line paragraphs 75 s. An article this
 * reading is meant for has thousands of lines, so its paragraphs are grouped: past this many, neighbours are merged (blank line
 * between them kept in the text), and every paragraph is ONE text node. A line break inside is what Markdown itself makes of it, a space.
 */
export const PLAIN_MAX_PARAGRAPHS = 400

/** The tree of an article read without Markdown: paragraphs of text, no other node, every character of the article in the text. */
export function plainTextTree(source: string): Root {
  const paragraphs: { line: number; text: string }[] = []
  let current: { line: number; lines: string[] } | undefined
  let number = 0
  const close = () => {
    if (current) paragraphs.push({ line: current.line, text: current.lines.join('\n') })
    current = undefined
  }
  for (const line of source.split(/\r\n|\r|\n/)) {
    number += 1
    if (isBlank(line)) {
      close()
    } else if (current) {
      current.lines.push(line)
    } else {
      current = { line: number, lines: [line] }
    }
  }
  close()

  const perGroup = Math.max(1, Math.ceil(paragraphs.length / PLAIN_MAX_PARAGRAPHS))
  const children: Paragraph[] = []
  for (let start = 0; start < paragraphs.length; start += perGroup) {
    const group = paragraphs.slice(start, start + perGroup)
    const first = group[0]!
    children.push({
      type: 'paragraph',
      children: [
        {
          type: 'text',
          value: group.map((paragraph) => paragraph.text).join('\n\n'),
          position: { start: { line: first.line, column: 1 }, end: { line: first.line, column: 1 } },
        },
      ],
    })
  }
  return { type: 'root', children }
}

/**
 * A parser for `unified()` that reads the article as plain text (see {@link plainTextTree}). It stands in for `remark-parse` when
 * {@link parseBudgetProblem} found the article too heavy; the transformers and the sanitizer after it run as for any article.
 */
export function plainTextReader(this: Processor): undefined {
  this.parser = (document) => plainTextTree(String(document))
  return undefined
}
