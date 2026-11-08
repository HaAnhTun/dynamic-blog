import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CODE_LANGUAGES } from './blocks/code-languages'
import { CODE_WARMUP } from './blocks/code-warmup'
import { renderMarkdown } from './markdown'

/**
 * The warm-up sample of a language (lib/blocks/code-warmup.ts) is tokenized by the process before the first fence in that language, to
 * compile the grammar. It only helps if the grammar really reads it, so each sample is drawn through the real renderer here.
 */
describe('the warm-up samples of the highlighter', () => {
  it('are one for every language the highlighter loads, and nothing else', () => {
    expect(Object.keys(CODE_WARMUP).sort()).toEqual([...CODE_LANGUAGES].sort())
  })

  it.each(CODE_LANGUAGES)('%s: its sample is read by the grammar, in more than one colour', async (language) => {
    const { content } = await renderMarkdown('```' + language + '\n' + CODE_WARMUP[language] + '\n```\n')
    const { container } = render(<>{content}</>)

    const colours = new Set(
      [...container.querySelectorAll('pre code span[style*="--shiki"]')].map((span) => span.getAttribute('style')),
    )
    expect(colours.size).toBeGreaterThan(1)
  })
})
