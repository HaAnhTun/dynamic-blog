import { describe, expect, it } from 'vitest'
import { WRITING_SECTIONS } from './writing-sections'

describe('WRITING_SECTIONS', () => {
  it('has the four sections in order, with hrefs and labelKeys relative to the Site.listing translator', () => {
    expect(WRITING_SECTIONS.map(({ key }) => key)).toEqual(['latest', 'series', 'topics', 'archive'])
    expect(WRITING_SECTIONS.map(({ href }) => href)).toEqual(['/writing', '/series', '/topics', '/archive'])
    expect(WRITING_SECTIONS.map(({ labelKey }) => labelKey)).toEqual([
      'sectionNav.latest',
      'sectionNav.series',
      'sectionNav.topics',
      'sectionNav.archive',
    ])
    for (const { Icon } of WRITING_SECTIONS) expect(typeof Icon).toBe('function')
  })
})
