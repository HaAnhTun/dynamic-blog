import { describe, expect, it } from 'vitest'
import { formatDate, formatDayMonth, formatMonth, formatUpdated } from './date'
import { DATE_VI, DAY_MONTH_VI, MONTH_VI } from '@/test/fixtures/vi/relative-time'

/**
 * The whole point of this module is `timeZone: 'UTC'`, and the whole point of the suite
 * pinning `TZ=Asia/Ho_Chi_Minh` is that deleting the option is then detectable. On a UTC
 * host it changes nothing — which is how a commit in this project once claimed a guard
 * worked when it could only have failed on a non-UTC machine.
 */
describe('formatDate', () => {
  it('formats in UTC, not in the host timezone', () => {
    // 19:00Z is 02:00 the NEXT day in Asia/Ho_Chi_Minh (UTC+7), which the suite pins. So
    // this instant is 2 October with the option and 3 October without it — the only kind
    // of input that can tell the two apart. A 07:00Z fixture reads the same either way and
    // would prove nothing.
    expect(formatDate('2026-10-02T19:00:00Z')).toContain('2')
    expect(formatDate('2026-10-02T19:00:00Z')).not.toContain(DAY_MONTH_VI(3, 10))
  })

  it('formats the same instant identically in both styles, modulo the style', () => {
    const long = formatDate('2026-09-28T17:30:00Z', 'long')
    const medium = formatDate('2026-09-28T17:30:00Z', 'medium')

    // Both must land on the 28th. The two styles differ in how they spell the month, not
    // in which day they pick — if `medium` had lost the timeZone it would say the 29th.
    expect(long).toContain('28')
    expect(medium).toContain('28')
    expect(long).not.toBe(medium)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['not a date', 'yesterday'],
    ['a half-written ISO string', '2026-13-45T99:99:99Z'],
  ])('returns null for %s rather than throwing', (_label, value) => {
    // Not defensive padding. `Intl.DateTimeFormat.prototype.format` THROWS a RangeError on
    // an invalid Date, so without this guard one malformed `publishedAt` would take down
    // the whole page instead of dropping a line of metadata.
    expect(() => formatDate(value)).not.toThrow()
    expect(formatDate(value)).toBeNull()
  })

  it('is not fooled by a date-only string', () => {
    // '2026-10-02' is parsed as UTC midnight by the ISO rules, so it must stay the 2nd.
    // Parsed as LOCAL midnight — which is what a non-ISO format like '10/2/2026' gets —
    // it would shift.
    expect(formatDate('2026-10-02')).toContain('2')
  })
})

describe('formatMonth', () => {
  it('writes month and year in Vietnamese words, months numbered 1–12', () => {
    expect(formatMonth(2026, 10)).toBe(MONTH_VI(10, 2026))
    expect(formatMonth(2026, 1)).toBe(MONTH_VI(1, 2026))
    expect(formatMonth(2025, 12)).toBe(MONTH_VI(12, 2025))
  })

  it('does not shift the month by the server time zone', () => {
    // The test suite pins TZ=Asia/Ho_Chi_Minh. Building the date with local time (`new Date(2026, 9, 1)`) and then
    // formatting in UTC makes 00:00 on 01/10 Vietnam time 17:00 on 30/09 UTC: month 9.
    // The first and last day of a month are the two places where that shift shows.
    for (let month = 1; month <= 12; month += 1) {
      expect(formatMonth(2026, month), `month ${month}`).toBe(MONTH_VI(month, 2026))
    }
  })
})

describe('formatDayMonth', () => {
  it('two-digit day and month, in UTC', () => {
    expect(formatDayMonth('2026-10-03T00:00:00Z')).toBe('03/10')
    // 19:00Z on 02/10 is already 02:00 on 03/10 in UTC+7: the archive row must show the same day as
    // formatDate on the post page, i.e. the UTC day.
    expect(formatDayMonth('2026-10-02T19:00:00Z')).toBe('02/10')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['not a date', 'yesterday'],
  ])('returns null for %s instead of throwing', (_label, value) => {
    expect(formatDayMonth(value)).toBeNull()
  })
})

/**
 * The "Updated …" line on the post page. Only shown when it says something more than the publish date:
 * both dates are readable, the edit date is AFTER the publish date, and it comes out as a different day (UTC, like the publish date).
 */
describe('formatUpdated', () => {
  const PUBLISHED = '2026-09-28T17:30:00Z'

  it('edited on a day after the publish date: the edit date, in the same form as the publish date', () => {
    expect(formatUpdated(PUBLISHED, '2026-10-06T08:00:00Z')).toBe(DATE_VI(6, 10, 2026))
    // Same formatter as the publish date: two dates side by side must be written the same way.
    expect(formatUpdated(PUBLISHED, '2026-10-06T08:00:00Z')).toBe(formatDate('2026-10-06T08:00:00Z'))
  })

  it('edited on the same day as publishing: null — fixing a typo a few hours after publishing is not an "update"', () => {
    expect(formatUpdated('2026-09-28T08:00:00Z', '2026-09-28T20:00:00Z')).toBeNull()
  })

  it('edit date earlier than or equal to the publish date: null', () => {
    // It really happens: a post created as a draft on the 2nd, published on the 28th with the last save made while still a draft (the
    // post page fixture) — "Updated 2 September" under "28 September" is a meaningless sentence.
    expect(formatUpdated(PUBLISHED, '2026-09-02T00:00:00Z')).toBeNull()
    expect(formatUpdated(PUBLISHED, PUBLISHED)).toBeNull()
  })

  it.each([
    ['publish date null', null, '2026-10-06T08:00:00Z'],
    ['publish date broken', 'yesterday', '2026-10-06T08:00:00Z'],
    ['edit date null', PUBLISHED, null],
    ['edit date undefined', PUBLISHED, undefined],
    ['edit date empty', PUBLISHED, ''],
    ['edit date broken', PUBLISHED, '2026-13-45T99:99:99Z'],
  ])('%s: null, does not throw', (_label, publishedAt, updatedAt) => {
    // Same reason as formatDate: Intl throws RangeError for a broken Date, and a meta line must not
    // bring down the whole post page.
    expect(() => formatUpdated(publishedAt, updatedAt)).not.toThrow()
    expect(formatUpdated(publishedAt, updatedAt)).toBeNull()
  })

  it('compares DAYS in UTC, like the displayed publish date, not in local time (TZ=Asia/Ho_Chi_Minh)', () => {
    // 16:30Z is 23:30 on the 28th Vietnam time, 17:30Z is already 00:30 on the 29th: comparing in local time makes them "different
    // days" and the page prints the "Updated" line for 28 September right under "Published 28 September". In UTC it is the same day.
    expect(formatUpdated('2026-09-28T16:30:00Z', '2026-09-28T17:30:00Z')).toBeNull()
    // And conversely: 23:30Z on the 28th and 00:30Z on the 29th are both the 29th in Vietnam time, but are two different
    // UTC days — exactly the two days the page prints for those two instants.
    expect(formatUpdated('2026-09-28T23:30:00Z', '2026-09-29T00:30:00Z')).toBe(DATE_VI(29, 9, 2026))
  })
})
