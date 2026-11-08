import { describe, expect, it } from 'vitest'
import { SERIES_FULL_LIST_MAX, seriesRows } from './series-rows'
import * as SeriesBlockModule from '@/components/site/SeriesBlock'

describe('seriesRows', () => {
  it('first part being read: no gap before it', () => {
    expect(seriesRows(10, 0)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'part', index: 1 },
      { kind: 'gap', after: 1 },
      { kind: 'part', index: 9 },
    ])
  })

  it('last part being read: no gap after it', () => {
    expect(seriesRows(10, 9)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'gap', after: 0 },
      { kind: 'part', index: 8 },
      { kind: 'part', index: 9 },
    ])
  })

  it('shows every part up to ' + SERIES_FULL_LIST_MAX + ' parts', () => {
    expect(SERIES_FULL_LIST_MAX).toBe(7)
    expect(seriesRows(7, 3)).toEqual(Array.from({ length: 7 }, (_, index) => ({ kind: 'part', index })))
    expect(seriesRows(0, 0)).toEqual([])
  })

  it('from 8 parts: first, gap, n-1, n, n+1, gap, last', () => {
    expect(seriesRows(12, 5)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'gap', after: 0 },
      { kind: 'part', index: 4 },
      { kind: 'part', index: 5 },
      { kind: 'part', index: 6 },
      { kind: 'gap', after: 6 },
      { kind: 'part', index: 11 },
    ])
  })

  it('a gap that would hide a single part shows that part instead', () => {
    // 8 parts, reading index 3: keep 0, 2, 3, 4, 7. Index 1 is the only hidden part before 2; index 5 and 6 stay a gap.
    expect(seriesRows(8, 3)).toEqual([
      { kind: 'part', index: 0 },
      { kind: 'part', index: 1 },
      { kind: 'part', index: 2 },
      { kind: 'part', index: 3 },
      { kind: 'part', index: 4 },
      { kind: 'gap', after: 4 },
      { kind: 'part', index: 7 },
    ])
  })
})

describe('SeriesBlock re-export', () => {
  it('still exports the same seriesRows and SERIES_FULL_LIST_MAX', () => {
    expect(SeriesBlockModule.seriesRows).toBe(seriesRows)
    expect(SeriesBlockModule.SERIES_FULL_LIST_MAX).toBe(SERIES_FULL_LIST_MAX)
  })
})
