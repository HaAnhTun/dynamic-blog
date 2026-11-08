import { describe, expect, it } from 'vitest'
import { collator, dateFormat, lowerCase, numberFormat, relativeTimeFormat, upperCase } from './format'
import { AGO_VI } from '@/test/fixtures/vi/relative-time'
import {
  LOWER_D_STROKE_A,
  LOWER_D_STROKE_GRAVE,
  UPPER_D_STROKE_A,
  UPPER_D_STROKE_GRAVE,
  WORDS_FIRST_TWO,
  WORDS_UNSORTED,
} from '@/test/fixtures/vi/collation'

describe('locale-aware formatters', () => {
  it('groups digits per locale', () => {
    expect(numberFormat('vi').format(1234567)).toBe('1.234.567')
    expect(numberFormat('en').format(1234567)).toBe('1,234,567')
  })

  it('names months per locale', () => {
    const date = new Date(Date.UTC(2026, 9, 1))
    const options = { month: 'long', timeZone: 'UTC' } as const
    expect(dateFormat('en', options).format(date)).toBe('October')
    expect(dateFormat('vi', options).format(date)).not.toBe('October')
  })

  it('phrases relative time per locale', () => {
    expect(relativeTimeFormat('en', { numeric: 'always' }).format(-3, 'minute')).toBe('3 minutes ago')
    expect(relativeTimeFormat('vi', { numeric: 'always' }).format(-3, 'minute')).toBe(AGO_VI.minutes3)
  })

  it('sorts Vietnamese words by the alphabet, not by code unit', () => {
    const words = WORDS_UNSORTED
    expect([...words].sort()).not.toEqual([...words].sort(collator('vi').compare))
    expect([...words].sort(collator('vi').compare).slice(0, 2)).toEqual(WORDS_FIRST_TWO)
  })

  it('maps case', () => {
    expect(upperCase(LOWER_D_STROKE_A, 'vi')).toBe(UPPER_D_STROKE_A)
    expect(lowerCase(UPPER_D_STROKE_GRAVE, 'en')).toBe(LOWER_D_STROKE_GRAVE)
  })

  it('returns the same object for the same locale and options, in any key order', () => {
    expect(numberFormat('vi')).toBe(numberFormat('vi'))
    expect(numberFormat('vi')).not.toBe(numberFormat('en'))
    expect(dateFormat('en', { month: 'long', year: 'numeric' })).toBe(dateFormat('en', { year: 'numeric', month: 'long' }))
    expect(collator('en')).toBe(collator('en'))
  })
})
