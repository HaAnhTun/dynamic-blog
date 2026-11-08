import type { Root } from 'mdast'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_BLOCK_DEPTH, MAX_BLOCK_WORK, MAX_QUOTED_BLOCKS, blockDepthBound, blockWork, nestingProblem } from './nesting'

interface Tree {
  type: string
  children?: Tree[]
}

/** How many container directives the real parser (the plugin set of the page, the feed, `validateBlocks` and `countBlocks`) nests at the deepest point. */
function realDepth(markdown: string): number {
  const walk = (node: Tree): number =>
    Math.max(0, ...(node.children ?? []).map(walk)) + (node.type === 'containerDirective' ? 1 : 0)
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(markdown) as Root
  return walk(tree as Tree)
}

const nest = (depth: number, colons = (level: number) => 3 + (depth - level)) =>
  [
    ...Array.from({ length: depth }, (_, level) => `${':'.repeat(colons(level))}details{title="L${level}"}`),
    'x',
    ...Array.from({ length: depth }, (_, level) => ':'.repeat(colons(depth - 1 - level))),
  ].join('\n')

describe('nestingProblem: articles the block syntax may read', () => {
  it('has nothing to say about prose, an empty text, or text with colons that are not blocks', () => {
    expect(nestingProblem('')).toBeUndefined()
    expect(nestingProblem('## One\n\nAt 10:30 the ratio is 3:1 and :smile: is not a block.\n')).toBeUndefined()
    expect(nestingProblem('::figure{src="a.png" alt="A"}\n:::\n')).toBeUndefined()
  })

  it('accepts blocks nested as deep as the limit, each closed by a fence of its own', () => {
    expect(nestingProblem(nest(MAX_BLOCK_DEPTH))).toBeUndefined()
  })

  it('accepts a long article of closed blocks: only the nesting counts, not how many blocks there are', () => {
    expect(nestingProblem(':::callout\nx\n:::\n\n'.repeat(5000))).toBeUndefined()
  })

  it('accepts fences that sit one inside another with more colons on the outside, and a CRLF article', () => {
    const markdown = ['::::steps', ':::step', 'x', ':::', ':::step', 'y', ':::', '::::'].join('\r\n')
    expect(nestingProblem(markdown)).toBeUndefined()
  })

  it('accepts blocks indented by up to three spaces, as the parser does, and a block in a list item', () => {
    expect(nestingProblem('   :::callout\n   x\n   :::\n'.repeat(20))).toBeUndefined()
    expect(nestingProblem('1. Step\n\n   :::callout\n   x\n   :::\n'.repeat(20))).toBeUndefined()
  })

  it('accepts a few blocks written inside a quote or a list with a deeper indent', () => {
    expect(nestingProblem('> :::callout\n> x\n> :::\n'.repeat(10))).toBeUndefined()
    expect(nestingProblem('-   item\n\n    :::callout\n    x\n    :::\n'.repeat(10))).toBeUndefined()
  })
})

describe('nestingProblem: nesting the parser cannot read in time', () => {
  it('reports blocks that are never closed, on the line of the first one past the limit', () => {
    const problem = nestingProblem(':::callout\nx\n\n'.repeat(MAX_BLOCK_DEPTH + 1))

    expect(problem?.code).toBe('too-deep')
    expect(problem?.line).toBe(MAX_BLOCK_DEPTH * 3 + 1)
    expect(problem?.message).toContain(String(MAX_BLOCK_DEPTH))
  })

  it('reports one level more than the limit and not the limit itself', () => {
    expect(nestingProblem(nest(MAX_BLOCK_DEPTH + 1))?.code).toBe('too-deep')
    expect(nestingProblem(nest(MAX_BLOCK_DEPTH))).toBeUndefined()
  })

  it('reports blocks that have no name on the closing fence and the same colons all the way down', () => {
    expect(nestingProblem(':::a{x=1}\n'.repeat(MAX_BLOCK_DEPTH + 1))?.code).toBe('too-deep')
    expect(nestingProblem('::::::a\n'.repeat(MAX_BLOCK_DEPTH + 1))?.code).toBe('too-deep')
  })

  it('reports a text of CRLF and of bare CR line ends the same way', () => {
    const lines = Array.from({ length: MAX_BLOCK_DEPTH + 1 }, () => ':::callout\nx\n')
    expect(nestingProblem(lines.join('').replaceAll('\n', '\r\n'))?.code).toBe('too-deep')
    expect(nestingProblem(lines.join('').replaceAll('\n', '\r'))?.code).toBe('too-deep')
  })

  it('does not let a fence line that closes nothing hide the blocks that are still open', () => {
    // A closing fence with fewer colons than any block open is content, not a close (measured on the parser).
    const markdown = Array.from({ length: MAX_BLOCK_DEPTH + 1 }, () => '::::::a\n:::\n').join('')
    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('closes the outermost block a fence is long enough for, and everything inside it, as the parser does', () => {
    // Three colons all the way down: the first closing fence ends the outer block and the seven inside it, so eight more fit after it.
    const open = ':::a' + String.fromCharCode(10)
    const close = ':::' + String.fromCharCode(10)
    const markdown = open.repeat(MAX_BLOCK_DEPTH) + close + open.repeat(MAX_BLOCK_DEPTH)
    expect(nestingProblem(markdown)).toBeUndefined()
    expect(nestingProblem(markdown + open)?.code).toBe('too-deep')
  })

  it('reports blocks opened behind a quote marker, a list marker, a tab or a deep indent', () => {
    for (const prefix of ['> ', '>> ', '- ', '1. ', '    ', '\t', '> - ']) {
      const markdown = `${prefix}:::callout\nx\n\n`.repeat(MAX_QUOTED_BLOCKS + 1)
      expect(nestingProblem(markdown)?.code, JSON.stringify(prefix)).toBe('too-deep')
    }
  })

  it('does not put the author text into the message', () => {
    const problem = nestingProblem(':::secret-name{title="hunter2"}\nx\n\n'.repeat(MAX_BLOCK_DEPTH + 1))

    expect(problem?.message).not.toContain('secret-name')
    expect(problem?.message).not.toContain('hunter2')
  })

  it('answers in a few milliseconds for the largest article the backend takes', () => {
    const started = performance.now()
    const problem = nestingProblem(':::callout\nx\n\n'.repeat(15_000))

    expect(problem?.code).toBe('too-deep')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('nestingProblem: blocks held open across many short lines', () => {
  // The parser checks every line against every block still open, so what it costs is (blocks open) x (lines), not the number of
  // blocks. Each text below stays under the depth limits and costs the parser seconds (measured: 4.8 s for 8 plain blocks and 100K
  // blank lines, 25 s for 64 quotes and 128K lines of `>`); the depth limits alone let them through.
  const BLANK = '\n'
  const REFERENCE_DOC = join(process.cwd(), '..', 'docs', 'content-blocks.md')

  it('reports plain blocks that stay open across a long run of blank lines, on the line that passes the budget', () => {
    const markdown = ':::a\n'.repeat(8) + BLANK.repeat(200_000)
    const problem = nestingProblem(markdown)

    expect(problem?.code).toBe('too-deep')
    expect(problem?.line).toBeGreaterThan(8)
    expect(problem?.line).toBeLessThanOrEqual(Math.ceil(MAX_BLOCK_WORK / 8) + 8)
    expect(blockWork(markdown)).toBeGreaterThan(MAX_BLOCK_WORK)
  })

  it('reports quoted blocks that stay open across a long run of quote markers', () => {
    expect(nestingProblem('> :::a\n'.repeat(MAX_QUOTED_BLOCKS) + '>\n'.repeat(100_000))?.code).toBe('too-deep')
    expect(nestingProblem('> :::a\n'.repeat(MAX_QUOTED_BLOCKS - 1) + '>\n'.repeat(100_000))?.code).toBe('too-deep')
  })

  it('reports one block held open across an enormous number of lines, and not a smaller number', () => {
    expect(nestingProblem(':::a\n' + 'x\n'.repeat(MAX_BLOCK_WORK + 10))?.code).toBe('too-deep')
    expect(nestingProblem(':::a\n' + 'x\n'.repeat(MAX_BLOCK_WORK / 2) + ':::\n')).toBeUndefined()
  })

  it('counts a quoted block against every line after it, since a quoted block is never taken off', () => {
    const markdown = '> :::a\n'.repeat(4) + 'x\n'.repeat(MAX_BLOCK_WORK / 4)

    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('does not report a long article whose blocks are closed: lines with nothing open cost nothing extra', () => {
    expect(nestingProblem('Some text.\n\n'.repeat(MAX_BLOCK_WORK) + ':::a\nx\n:::\n')).toBeUndefined()
  })

  it.skipIf(!existsSync(REFERENCE_DOC))(
    'does not report the busiest document of the repository, the reference of the blocks',
    () => {
      const reference = readFileSync(REFERENCE_DOC, 'utf8')

      expect(nestingProblem(reference)).toBeUndefined()
      expect(blockWork(reference)).toBeLessThan(MAX_BLOCK_WORK / 10)
    },
  )

  it('answers in linear time for the shapes above', () => {
    const started = performance.now()
    nestingProblem(':::a\n'.repeat(8) + BLANK.repeat(400_000))
    nestingProblem('> :::a\n'.repeat(MAX_QUOTED_BLOCKS) + '>\n'.repeat(200_000))

    expect(performance.now() - started).toBeLessThan(500)
  })
})

// Letters written by code: the English guard allows accented letters of Vietnamese only in the places the repository lists.
const ACUTE_E = String.fromCodePoint(0xe9)
const D_STROKE = String.fromCodePoint(0x111)
const CJK = String.fromCodePoint(0x65e5)
const EMOJI = String.fromCodePoint(0x1f600)

describe('nestingProblem: the scan never counts fewer open blocks than the parser opens', () => {
  // Each text below was measured on the parser (micromark-extension-directive 4): it nests far more blocks than the limit in a few
  // KB, and the cost of reading it grows much faster than its size (a thousand levels take seconds). The scan must see through all of them.
  const PAST_THE_LIMIT = MAX_BLOCK_DEPTH + 2

  it.each(['1', '9x', ACUTE_E, D_STROKE, CJK, EMOJI])(
    'counts a block whose name starts with %j: a name may start with anything but whitespace and punctuation',
    (name) => {
      const markdown = `:::${name}\nx\n\n`.repeat(PAST_THE_LIMIT)

      expect(realDepth(markdown)).toBeGreaterThan(MAX_BLOCK_DEPTH)
      expect(nestingProblem(markdown)?.code, JSON.stringify(name)).toBe('too-deep')
    },
  )

  it('counts a block whose name is a tab: a fence with a tab after it closes a block when it can and opens one when it cannot', () => {
    // Fewer colons on every line, so no fence is long enough to close the block above it and each one opens a block named by the tab.
    const markdown = Array.from({ length: PAST_THE_LIMIT }, (_, index) => `${':'.repeat(40 - index)}\t`).join('\n')

    expect(realDepth(markdown)).toBeGreaterThan(MAX_BLOCK_DEPTH)
    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('counts a tab fence with blanks after the tab and up to three spaces of indent in front of it', () => {
    const markdown = Array.from({ length: PAST_THE_LIMIT }, (_, index) => `   ${':'.repeat(40 - index)}\t \t`).join('\n')

    expect(realDepth(markdown)).toBeGreaterThan(MAX_BLOCK_DEPTH)
    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('does not let a line that only looks like an open (text after the name) take the real blocks above it off the count', () => {
    // `:::a b` opens nothing, and the `:::` after seven real blocks of four colons closes none of them (it is shorter than all of them).
    const markdown = (':::a b\n' + '::::x\n'.repeat(7) + ':::\n').repeat(4)

    expect(realDepth(markdown)).toBeGreaterThan(MAX_BLOCK_DEPTH)
    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('does not let a line in a code fence, which opens nothing, take real blocks off the count', () => {
    const markdown = ('```\n:::a\n```\n' + '::::x\n'.repeat(7) + ':::\n').repeat(4)

    expect(realDepth(markdown)).toBeGreaterThan(MAX_BLOCK_DEPTH)
    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('counts a block that a footnote definition opens on its own line, however deep the definitions are indented', () => {
    const levels = MAX_QUOTED_BLOCKS + 6
    const markdown = Array.from({ length: levels }, (_, level) => `${' '.repeat(4 * level)}[^x]: :::callout`).join('\n')

    expect(realDepth(markdown)).toBeGreaterThan(MAX_QUOTED_BLOCKS)
    expect(nestingProblem(markdown)?.code).toBe('too-deep')
  })

  it('counts a block opened behind any prefix or in the middle of a line, as the parser can open it behind a quote, a list or a footnote', () => {
    for (const prefix of ['> ', '- ', '1. ', '[^x]: ', '[^x]: > - ', '\t', '    ', 'text ']) {
      const markdown = `${prefix}:::callout\n`.repeat(MAX_QUOTED_BLOCKS + 1)

      expect(nestingProblem(markdown)?.code, JSON.stringify(prefix)).toBe('too-deep')
    }
  })

  it('answers in linear time for one huge line, whatever it is made of', () => {
    // A pattern that is tried at every colon of a run of colons, and backtracks over the rest of the run, costs n squared steps.
    const lines = [
      ':'.repeat(400_000),
      `${':'.repeat(400_000)} x`,
      ':::\t'.repeat(100_000),
      `a ${':'.repeat(400_000)}`,
      `:::\t${' '.repeat(400_000)}`,
    ]
    const started = performance.now()
    for (const line of lines) nestingProblem(line)

    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('nestingProblem: differential test against the parser', () => {
  // The property that makes the limit worth anything: for any text, the number of blocks the scan counts is not lower than the number
  // of container directives the parser nests. Texts are built from lines chosen to be hard for a line scan: every way of writing an open
  // fence (names that start with a digit, a letter outside ASCII, an emoji, a tab, text after the name, an attribute list, a label),
  // closing fences of every length, fences behind a quote, list or footnote prefix, code fences and indented code, and the three line ends.
  // Characters written by code, not typed: a no-break space and the Unicode line separator are invisible in the source.
  const NBSP = String.fromCharCode(0xa0)
  const LINE_SEPARATOR = String.fromCharCode(0x2028)
  const PREFIXES = [
    '',
    '',
    '',
    '',
    '',
    ' ',
    '  ',
    '   ',
    '    ',
    '\t',
    '> ',
    '>> ',
    '- ',
    '* ',
    '1. ',
    '[^x]: ',
    '[^x]: > ',
    '    - ',
    '  ',
  ]
  const OPENS = [
    ':::a',
    '::::a',
    ':::::a',
    '::::::a',
    ':::1',
    '::::9x',
    `:::${ACUTE_E}`,
    `:::${D_STROKE}`,
    `:::${CJK}`,
    `:::${EMOJI}`,
    ':::a b',
    ':::a{x=1}',
    ':::a[l]',
    ':::a{',
    ':::a]',
    ':::!',
    ':::-',
    ':::\t',
    '::::\t',
    ':::::\t',
    ':::\tx',
    ':::\t ',
    `:::${NBSP}`,
    `:::${NBSP}a`,
    '::: a',
    '::a',
    `:::${LINE_SEPARATOR}`,
  ]
  const CLOSES = [':::', ':::', '::::', ':::::', '::::::', ':::  ', ':::\t', '::::\t ', ':::x:::']
  const OTHERS = [
    '',
    '',
    'x',
    'text',
    '```',
    '```md',
    '~~~',
    '<div>',
    '</div>',
    '    code',
    '# h',
    '---',
    '|a|b|',
    '|-|-|',
    '[^x]: y',
    '[x]: /u',
    '> q',
    '- item',
  ]
  const LINE_ENDS = ['\n', '\n', '\n', '\n', '\r\n', '\r']

  /** A small deterministic generator (mulberry32), so a failure is the same on every run and every machine. */
  function random(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let mixed = Math.imul(state ^ (state >>> 15), state | 1)
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
  }

  function document(next: () => number): string {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
    const lines = Array.from({ length: 1 + Math.floor(next() * 16) }, () => {
      const kind = next()
      const core = kind < 0.45 ? pick(OPENS) : kind < 0.7 ? pick(CLOSES) : pick(OTHERS)
      return (next() < 0.4 ? pick(PREFIXES) : '') + core
    })
    return lines.map((text, index) => (index === lines.length - 1 ? text : text + pick(LINE_ENDS))).join('')
  }

  it('never counts fewer open blocks than the parser nests, for 4000 generated texts', () => {
    const next = random(20261019)
    let deepest = 0
    for (let count = 0; count < 4000; count += 1) {
      const markdown = document(next)
      const real = realDepth(markdown)
      deepest = Math.max(deepest, real)

      expect(blockDepthBound(markdown), JSON.stringify(markdown)).toBeGreaterThanOrEqual(real)
    }
    // The generator is worth something only if it makes the parser nest blocks.
    expect(deepest).toBeGreaterThanOrEqual(4)
  })

  it('does so for the shapes this file names, tried one after the other and in every pairing', () => {
    const shapes = [
      ':::a',
      '::::x',
      ':::1',
      `:::${ACUTE_E}`,
      `:::${EMOJI}`,
      ':::a b',
      ':::\t',
      '::::\t',
      ':::',
      '::::',
      '[^x]: :::a',
      '> :::a',
      '- :::a',
      '```',
      '    :::a',
    ]
    for (const first of shapes) {
      for (const second of shapes) {
        for (const third of shapes) {
          const markdown = [first, second, third, first, second, third].join('\n')

          expect(blockDepthBound(markdown), JSON.stringify(markdown)).toBeGreaterThanOrEqual(realDepth(markdown))
        }
      }
    }
  })
})
