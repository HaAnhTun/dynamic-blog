import { describe, expect, it } from 'vitest'
import { formatLocalDateTime, formatLocalTime, isSameLocalDay } from './local-time'

/*
 * The test suite pins TZ=Asia/Ho_Chi_Minh (vitest.config.mts): UTC+7 all year, no daylight saving. The instants below are
 * chosen so that the reader's hour and the UTC hour differ, or even the day differs: a version that mistakenly used `getUTC*` (like
 * lib/date.ts) goes red, while on a UTC machine no test could tell the two versions apart.
 */

describe('formatLocalDateTime', () => {
  it("the reader's hour, 24-hour, then day/month/year", () => {
    expect(formatLocalDateTime('2026-10-08T07:30:00Z')).toBe('14:30, 08/10/2026')
    expect(formatLocalDateTime('2026-12-31T15:45:00Z')).toBe('22:45, 31/12/2026')
  })

  it('hour, minute, day, month are always two digits', () => {
    expect(formatLocalDateTime('2026-01-02T01:05:00Z')).toBe('08:05, 02/01/2026')
  })

  it("past midnight in the reader's time is a new day, even though in UTC it is still the old day", () => {
    expect(formatLocalDateTime('2026-10-08T17:05:00Z')).toBe('00:05, 09/10/2026')
    expect(formatLocalDateTime('2026-12-31T17:00:00Z')).toBe('00:00, 01/01/2027')
  })

  it('seconds and milliseconds are dropped, not rounded up to the next minute', () => {
    expect(formatLocalDateTime('2026-10-08T07:30:59.999Z')).toBe('14:30, 08/10/2026')
  })

  it('instants with a time zone offset are read too, not only "Z"', () => {
    expect(formatLocalDateTime('2026-10-08T09:30:00+09:00')).toBe('07:30, 08/10/2026')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['not a date', 'yesterday'],
    ['malformed ISO', '2026-13-45T99:99:99Z'],
  ])('%s: null, no error thrown, no "Invalid Date"', (_label, value) => {
    expect(formatLocalDateTime(value)).toBeNull()
  })
})

describe('formatLocalTime', () => {
  it("only the reader's hour and minute, two digits", () => {
    expect(formatLocalTime('2026-10-08T07:30:00Z')).toBe('14:30')
    expect(formatLocalTime('2026-10-08T17:05:00Z')).toBe('00:05')
    expect(formatLocalTime('2026-10-08T02:09:59Z')).toBe('09:09')
  })

  it.each([null, undefined, '', 'not a time'])('%j: null', (value) => {
    expect(formatLocalTime(value)).toBeNull()
  })
})

describe('isSameLocalDay', () => {
  it("same day on the reader's calendar", () => {
    expect(isSameLocalDay('2026-10-08T01:00:00Z', '2026-10-08T15:00:00Z')).toBe(true)
  })

  it("by the reader's calendar, not UTC", () => {
    // 23:59 on the 8th and 00:00 on the 9th in UTC+7, even though both are the 8th in UTC.
    expect(isSameLocalDay('2026-10-08T16:59:00Z', '2026-10-08T17:00:00Z')).toBe(false)
    // 00:00 and 23:59 on the 8th in UTC+7, even though they are different days in UTC.
    expect(isSameLocalDay('2026-10-07T17:00:00Z', '2026-10-08T16:59:59Z')).toBe(true)
  })

  it('same day and month but a different year, or same day in a different month: not the same day', () => {
    expect(isSameLocalDay('2025-10-08T07:00:00Z', '2026-10-08T07:00:00Z')).toBe(false)
    expect(isSameLocalDay('2026-09-08T07:00:00Z', '2026-10-08T07:00:00Z')).toBe(false)
  })

  it('one of the two is unreadable: false', () => {
    expect(isSameLocalDay('2026-10-08T07:00:00Z', null)).toBe(false)
    expect(isSameLocalDay('today', '2026-10-08T07:00:00Z')).toBe(false)
    expect(isSameLocalDay(undefined, undefined)).toBe(false)
  })
})
