import { nestingProblem } from './nesting'
import { parseBudgetProblem } from './parse-budget'
import type { Problem } from './types'

/**
 * How an article is read, decided before anything is parsed. Every parser of the article (the page, the feed, `validateBlocks`,
 * `countBlocks`) asks it first and builds itself from the answer, so no parser can run a text that another refuses:
 * - `plain`: the article would cost the parser more than its budget (`./parse-budget.ts`), or the parser gave up on it. It is read
 *   as plain text, no Markdown and no blocks, and `problems` holds the one `too-heavy` problem.
 * - otherwise `directives`: false when the article opens more blocks than the directive parser can read in time (`./nesting.ts`); the
 *   Markdown is read, the block syntax is not, and `problems` holds the `too-deep` problem.
 * - otherwise everything is read and `problems` is empty.
 */
export interface Reading {
  readonly plain: boolean
  readonly directives: boolean
  readonly problems: Problem[]
}

/** The problem for an article that the parser could not walk to the end (a stack overflow on nesting the budget did not measure). */
export function gaveUp(): Problem {
  return {
    line: 1,
    code: 'too-heavy',
    message:
      'This article nests Markdown or HTML so deeply that the Markdown reader gave up on it. It is shown as plain text, without ' +
      'headings, links, emphasis, code or blocks. Close the tags and quotes you do not need, or split the article.',
  }
}

/** `giveUp`: the problem to read the article with when a first attempt failed; it forces the plain reading. */
export function readingOf(source: string, giveUp?: Problem): Reading {
  const heavy = giveUp ?? parseBudgetProblem(source)
  if (heavy) return { plain: true, directives: false, problems: [heavy] }
  const tooDeep = nestingProblem(source)
  return { plain: false, directives: tooDeep === undefined, problems: tooDeep ? [tooDeep] : [] }
}
