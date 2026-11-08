// @vitest-environment node
import type { Root } from 'hast'
import { describe, expect, it, vi } from 'vitest'
import { HIGHLIGHT_LIMITS, boundHighlighter, type BoundableHighlighter } from './highlight-budget'

/**
 * The highlighter is bounded per article (docs/SECURITY.md, "Markdown in posts"): Shiki has no limit of its own, and a fence of long
 * lines in a language with a grammar took 118 s on the one event loop. These tests drive the wrapper with a fake highlighter and a fake
 * clock, so nothing here depends on how fast the machine is.
 */

type CallOptions = Record<string, unknown> & { lang: string }

interface Call {
  code: string
  options: CallOptions
}

const EMPTY: Root = { type: 'root', children: [] }

const THEMES = { light: 'github-light', dark: 'github-dark' }

/** What the first block of a test spends, so that 100 ms of the budget are left. */
const SPENT = HIGHLIGHT_LIMITS.budgetMs - 100

const CRLF = String.fromCharCode(13, 10)

/** A highlighter that records what it is asked for and spends `costMs` of the fake clock on each block that is not plain. */
function fake(
  costMs: (code: string) => number = () => 0,
  warmed: Set<string> = new Set(['typescript', 'sql']),
  warmup: Record<string, string> = {},
) {
  const calls: Call[] = []
  const clock = { now: 0 }
  const inner = {
    getLoadedLanguages: vi.fn(() => ['typescript', 'sql']),
    loadLanguage: vi.fn(async () => undefined),
    codeToHast(code: string, options: CallOptions) {
      calls.push({ code, options })
      if (options.lang !== 'text') clock.now += costMs(code)
      return EMPTY
    },
  }
  const bound = boundHighlighter(inner as unknown as BoundableHighlighter, () => clock.now, warmed, warmup)
  return { bound, calls, inner }
}

/** A block whose first call spends all but 100 ms of the budget. */
const spendsAlmostAll = (code: string) => (code === 'first' ? SPENT : 0)

function lines(count: number, width = 40): string {
  return Array.from({ length: count }, () => 'x'.repeat(width)).join('\n')
}

describe('boundHighlighter: one article', () => {
  it('passes an ordinary block through with the line length and the time limit of one line', () => {
    const { bound, calls } = fake()

    bound.codeToHast(lines(20), { lang: 'typescript', themes: THEMES, meta: { title: 'a.ts' } } as never)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({
      lang: 'typescript',
      themes: THEMES,
      meta: { title: 'a.ts' },
      tokenizeMaxLineLength: HIGHLIGHT_LIMITS.maxLineLength,
      tokenizeTimeLimit: HIGHLIGHT_LIMITS.lineLimitMs,
    })
  })

  it('hands the language lists of the real highlighter through', async () => {
    const { bound, inner } = fake()

    expect(bound.getLoadedLanguages()).toEqual(['typescript', 'sql'])
    await bound.loadLanguage('go' as never)
    expect(inner.loadLanguage).toHaveBeenCalledWith('go')
  })

  it('leaves a plain-text block alone: it has no grammar to be slow, and it uses none of the budget', () => {
    const { bound, calls } = fake()

    bound.codeToHast(lines(HIGHLIGHT_LIMITS.maxLines + 10), { lang: 'text', themes: THEMES } as never)
    bound.codeToHast(lines(20), { lang: 'typescript', themes: THEMES } as never)

    expect(calls.map((call) => call.options.lang)).toEqual(['text', 'typescript'])
    expect(calls[0]?.options.tokenizeTimeLimit).toBeUndefined()
  })

  it('stops highlighting when the fences of the article together pass the line limit', () => {
    const { bound, calls } = fake()
    const blocks = HIGHLIGHT_LIMITS.maxLines / 20

    for (let block = 0; block <= blocks; block += 1) {
      bound.codeToHast(lines(20, 10), { lang: 'typescript', themes: THEMES } as never)
    }

    // Every block that fits is highlighted, the one past the limit is not.
    expect(calls.filter((call) => call.options.lang === 'typescript')).toHaveLength(blocks)
    expect(calls.at(-1)?.options.lang).toBe('text')
  })

  it('stops highlighting when the fences of the article together pass the character limit', () => {
    const { bound, calls } = fake()
    const half = 'x'.repeat(HIGHLIGHT_LIMITS.maxChars / 2 - 10)

    bound.codeToHast(half, { lang: 'sql', themes: THEMES } as never)
    bound.codeToHast(half, { lang: 'sql', themes: THEMES } as never)
    bound.codeToHast(half, { lang: 'sql', themes: THEMES } as never)

    expect(calls.map((call) => call.options.lang)).toEqual(['sql', 'sql', 'text'])
  })

  it('does not count a block drawn without a grammar against the blocks after it', () => {
    const { bound, calls } = fake()

    bound.codeToHast('x'.repeat(HIGHLIGHT_LIMITS.maxChars + 1), { lang: 'sql', themes: THEMES } as never)
    bound.codeToHast(lines(20), { lang: 'sql', themes: THEMES } as never)

    expect(calls.map((call) => call.options.lang)).toEqual(['text', 'sql'])
  })

  it('shrinks the time limit of a line as the time of the article is spent, so that all its lines fit in what is left', () => {
    const { bound, calls } = fake(spendsAlmostAll)

    bound.codeToHast('first', { lang: 'typescript', themes: THEMES } as never)
    // 100 ms are left; two themes and ten lines: 5 ms for one line of one theme.
    bound.codeToHast(lines(10), { lang: 'typescript', themes: THEMES } as never)

    expect(calls[1]?.options.lang).toBe('typescript')
    expect(calls[1]?.options.tokenizeTimeLimit).toBe(5)
  })

  it('counts one theme when a block names a single theme', () => {
    const { bound, calls } = fake(spendsAlmostAll)

    bound.codeToHast('first', { lang: 'typescript', theme: 'github-light' } as never)
    bound.codeToHast(lines(10), { lang: 'typescript', theme: 'github-light' } as never)

    expect(calls[1]?.options.tokenizeTimeLimit).toBe(10)
  })

  it('draws a block without a grammar when what is left of the time cannot give each of its lines the minimum', () => {
    const { bound, calls } = fake(spendsAlmostAll)

    bound.codeToHast('first', { lang: 'typescript', themes: THEMES } as never)
    // 100 ms left, two themes: 100 lines would get 0.5 ms each, below the floor.
    bound.codeToHast(lines(100), { lang: 'typescript', themes: THEMES } as never)

    expect(calls[1]?.options.lang).toBe('text')
  })

  it('draws every block that follows without a grammar once the time is gone', () => {
    const { bound, calls } = fake((code) => (code === 'slow' ? HIGHLIGHT_LIMITS.budgetMs + 500 : 0))

    bound.codeToHast('slow', { lang: 'typescript', themes: THEMES } as never)
    bound.codeToHast('x', { lang: 'typescript', themes: THEMES } as never)
    bound.codeToHast('y', { lang: 'sql', themes: THEMES } as never)

    expect(calls.map((call) => call.options.lang)).toEqual(['typescript', 'text', 'text'])
  })

  it('counts a Windows line break and the line break at the end of a fence once', () => {
    const { bound, calls } = fake(spendsAlmostAll)

    // 3 lines: with 100 ms left and two themes, 16 ms each. Counting the final newline or the carriage return twice would give less.
    bound.codeToHast('first', { lang: 'typescript', themes: THEMES } as never)
    bound.codeToHast(['b', 'b', 'b', ''].join(CRLF), { lang: 'typescript', themes: THEMES } as never)

    expect(calls[1]?.options.tokenizeTimeLimit).toBe(16)
  })

  it('is a new budget for every article: two wrappers do not share what they spent', () => {
    const slow = fake((code) => (code === 'slow' ? HIGHLIGHT_LIMITS.budgetMs + 1 : 0))
    slow.bound.codeToHast('slow', { lang: 'sql', themes: THEMES } as never)
    const next = fake()
    next.bound.codeToHast('x', { lang: 'sql', themes: THEMES } as never)

    expect(next.calls[0]?.options.lang).toBe('sql')
  })
})

describe('boundHighlighter: the warm-up of a grammar', () => {
  const SAMPLE = 'sample of the language'

  it('tokenizes a sample of the language before its first block, without limits, and returns the block, not the sample', () => {
    const { bound, calls } = fake(() => 0, new Set(), { typescript: SAMPLE })

    bound.codeToHast(lines(10), {
      lang: 'typescript',
      themes: THEMES,
      transformers: [{ name: 'x' }],
      meta: { title: 'a' },
    } as never)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.code).toBe(SAMPLE)
    expect(calls[0]?.options).toMatchObject({ lang: 'typescript', themes: THEMES, transformers: [], meta: {} })
    // Nothing of the article's own options is applied to the sample, and it has no time or line limit of its own to be cut by.
    expect(calls[0]?.options.tokenizeTimeLimit).toBeUndefined()
    expect(calls[0]?.options.tokenizeMaxLineLength).toBeUndefined()
    expect(calls[1]?.code).toBe(lines(10))
    expect(calls[1]?.options.tokenizeTimeLimit).toBe(HIGHLIGHT_LIMITS.lineLimitMs)
  })

  it('warms a language once per process: the next block of it, in this article or another, goes straight through', () => {
    const warmed = new Set<string>()
    const first = fake(() => 0, warmed, { typescript: SAMPLE, sql: SAMPLE })
    first.bound.codeToHast(lines(5), { lang: 'typescript', themes: THEMES } as never)
    first.bound.codeToHast(lines(5), { lang: 'typescript', themes: THEMES } as never)
    const second = fake(() => 0, warmed, { typescript: SAMPLE, sql: SAMPLE })
    second.bound.codeToHast(lines(5), { lang: 'typescript', themes: THEMES } as never)
    second.bound.codeToHast(lines(5), { lang: 'sql', themes: THEMES } as never)

    expect(first.calls.map((call) => call.code === SAMPLE)).toEqual([true, false, false])
    expect(second.calls.map((call) => call.code === SAMPLE)).toEqual([false, true, false])
  })

  it('has no sample to run for a language without one, and still marks it', () => {
    const warmed = new Set<string>()
    const { bound, calls } = fake(() => 0, warmed, {})

    bound.codeToHast(lines(5), { lang: 'sql', themes: THEMES } as never)

    expect(calls).toHaveLength(1)
    expect(warmed.has('sql')).toBe(true)
  })

  it('does not warm a language up for a block it will not highlight', () => {
    const { bound, calls } = fake(() => 0, new Set(), { typescript: SAMPLE })

    bound.codeToHast('x'.repeat(HIGHLIGHT_LIMITS.maxChars + 1), { lang: 'typescript', themes: THEMES } as never)

    expect(calls.map((call) => call.options.lang)).toEqual(['text'])
  })

  it('does not charge the warm-up to the article: the block after it gets the time limit it would have had', () => {
    // The sample takes the whole budget twice over; the article's own block still gets its full line limit.
    const { bound, calls } = fake((code) => (code === SAMPLE ? HIGHLIGHT_LIMITS.budgetMs * 2 : 0), new Set(), {
      typescript: SAMPLE,
    })

    bound.codeToHast(lines(10), { lang: 'typescript', themes: THEMES } as never)

    expect(calls[1]?.options.lang).toBe('typescript')
    expect(calls[1]?.options.tokenizeTimeLimit).toBe(HIGHLIGHT_LIMITS.lineLimitMs)
  })
})

describe('HIGHLIGHT_LIMITS', () => {
  it('keeps the floor of a line below its ceiling, and the floor above zero (a limit of 0 means no limit to Shiki)', () => {
    expect(HIGHLIGHT_LIMITS.minLineLimitMs).toBeGreaterThanOrEqual(1)
    expect(HIGHLIGHT_LIMITS.lineLimitMs).toBeGreaterThan(HIGHLIGHT_LIMITS.minLineLimitMs)
  })
})
