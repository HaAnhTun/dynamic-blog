import { describe, expect, it } from 'vitest'
import { countBlocks } from './summary'

describe('countBlocks', () => {
  it('counts nothing for an article without blocks', () => {
    expect(countBlocks('## One\n\nText and `code`.\n')).toEqual([])
    expect(countBlocks('')).toEqual([])
  })

  it('counts each registered block by its type, most used first, then by name', () => {
    const markdown = [
      ':::callout{type=tip}',
      'One.',
      ':::',
      '',
      '::figure{src="assets/a.png" alt="A"}',
      '',
      ':::callout{type=note}',
      'Two.',
      ':::',
      '',
      '::figure{src="assets/b.png" alt="B"}',
      '',
      ':::details{title="More"}',
      'Text.',
      ':::',
      '',
      ':::callout{type=info}',
      'Three.',
      ':::',
    ].join('\n')
    expect(countBlocks(markdown)).toEqual([
      { type: 'callout', count: 3 },
      { type: 'figure', count: 2 },
      { type: 'details', count: 1 },
    ])
  })

  it('counts the blocks inside other blocks too', () => {
    const markdown = [
      '::::steps{title="Install"}',
      ':::step{title="One"}',
      'A.',
      ':::',
      ':::step{title="Two"}',
      'B.',
      ':::',
      '::::',
    ].join('\n')
    expect(countBlocks(markdown)).toEqual([
      { type: 'step', count: 2 },
      { type: 'steps', count: 1 },
    ])
  })

  it('does not count what is not a block: a code sample, an unknown name or a text directive', () => {
    const markdown = [
      '```markdown',
      ':::callout{type=tip}',
      'Only a sample.',
      ':::',
      '```',
      '',
      ':::sidebar',
      'Not a block of this site.',
      ':::',
      '',
      'A :note in a sentence.',
    ].join('\n')
    expect(countBlocks(markdown)).toEqual([])
  })
})

describe('countBlocks: an article nested too deeply to parse for blocks', () => {
  it('counts none, within a second, instead of parsing blocks that are never closed', () => {
    const started = performance.now()

    expect(countBlocks(':::callout\nx\n\n'.repeat(2000))).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_000)
  }, 20_000)
})
