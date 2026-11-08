import { describe, expect, it } from 'vitest'
import { plainLead } from './about-body'

describe('plainLead', () => {
  it('takes the first sentence of the first prose line, skipping headings, blocks and fences', () => {
    const body = [
      '## Heading',
      '',
      ':::callout{type=tip}',
      'Inside a block.',
      ':::',
      '```',
      'code line.',
      '```',
      '',
      'I build **small** tools. And write about them.',
    ].join('\n')

    expect(plainLead(body)).toBe('I build small tools.')
  })

  it('skips nested blocks and one-line blocks as a whole', () => {
    const body = [
      '::::steps',
      ':::step{title="One"}',
      'Do this.',
      ':::',
      '::::',
      '::metric{label="a" value="1"}',
      'After the blocks.',
    ].join('\n')

    expect(plainLead(body)).toBe('After the blocks.')
  })

  it('strips links, images and list markers', () => {
    expect(plainLead('- See [the notes](https://example.test/a) for more')).toBe('See the notes for more')
  })

  it('is empty for a body with no prose', () => {
    expect(plainLead('## Only a heading\n\n```\ncode\n```')).toBe('')
    expect(plainLead('')).toBe('')
  })

  it('cuts a long sentence with an ellipsis', () => {
    const lead = plainLead('word '.repeat(80).trim())

    expect(lead.length).toBeLessThanOrEqual(200)
    expect(lead.endsWith('…')).toBe(true)
  })
})
