import { describe, expect, it } from 'vitest'
import { RANGE_MESSAGES, parseDateRange } from './range'

describe('parseDateRange', () => {
  it('no parameter, or an empty field (the GET form sends `from=`): no error, the backend picks the default', () => {
    expect(parseDateRange(undefined, undefined)).toEqual({ from: '', to: '', error: null })
    expect(parseDateRange('', '  ')).toEqual({ from: '', to: '', error: null })
  })

  it('trims, and takes the first value when a parameter repeats', () => {
    expect(parseDateRange([' 2026-10-01 ', '2026-01-01'], '2026-10-10')).toEqual({
      from: '2026-10-01',
      to: '2026-10-10',
      error: null,
    })
  })

  it('a missing end is still valid: the backend takes the other end itself', () => {
    expect(parseDateRange('2026-10-01', undefined).error).toBeNull()
    expect(parseDateRange(undefined, '2026-10-10').error).toBeNull()
  })

  it.each(['2026-1-01', '10/10/2026', '2026-13-01', '2026-02-29', '2026-04-31', '0099-01-01', '2026-10-10T00:00', 'yesterday'])(
    '%j is malformed or not a real date: error on exactly that field',
    (value) => {
      expect(parseDateRange(value, '2026-10-10').error).toEqual({ message: RANGE_MESSAGES.format, fields: ['from'] })
      expect(parseDateRange('2026-10-01', value).error).toEqual({ message: RANGE_MESSAGES.format, fields: ['to'] })
      expect(parseDateRange(value, value).error?.fields).toEqual(['from', 'to'])
    },
  )

  it('a real leap day is accepted', () => {
    expect(parseDateRange('2028-02-29', '2028-03-01').error).toBeNull()
  })

  it('start after end: error on both fields; the same day is a one-day range, valid', () => {
    expect(parseDateRange('2026-10-10', '2026-10-09').error).toEqual({ message: RANGE_MESSAGES.order, fields: ['from', 'to'] })
    expect(parseDateRange('2026-10-10', '2026-10-10').error).toBeNull()
  })

  it('at most 366 days counting both ends', () => {
    expect(parseDateRange('2025-10-10', '2026-10-10').error).toBeNull()
    expect(parseDateRange('2025-10-09', '2026-10-10').error).toEqual({ message: RANGE_MESSAGES.tooLong, fields: ['from', 'to'] })
    // Across 29/2: 2024-02-29 lies inside the range, so 366 days end one calendar day earlier.
    expect(parseDateRange('2023-03-01', '2024-02-29').error).toBeNull()
    expect(parseDateRange('2023-03-01', '2024-03-01').error?.message).toBe(RANGE_MESSAGES.tooLong)
  })
})
