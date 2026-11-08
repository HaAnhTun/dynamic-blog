// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import { relativeTime as relativeTimeFor } from './relative-time'
import { msg } from '@/test/render-intl'
import { AGO_VI } from '@/test/fixtures/vi/relative-time'

const t = translatorFor('vi', 'Site.time')
const relativeTime = (iso: string, now: number = Date.now()) => relativeTimeFor(iso, now, 'vi', t)

const NOW = Date.parse('2026-10-08T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('under a minute is "just now"', () => {
    expect(relativeTime(ago(0), NOW)).toBe(msg('Site.time.justNow'))
    expect(relativeTime(ago(59 * SECOND), NOW)).toBe(msg('Site.time.justNow'))
  })

  it('a time in the future (the reader\'s clock running slow) is also "just now", not "in 2 minutes"', () => {
    expect(relativeTime(ago(-2 * MINUTE), NOW)).toBe(msg('Site.time.justNow'))
  })

  it.each([
    [MINUTE, AGO_VI.minute1],
    [59 * MINUTE, AGO_VI.minutes59],
    [HOUR, AGO_VI.hour1],
    [23 * HOUR, AGO_VI.hours23],
    [DAY, AGO_VI.day1],
    [29 * DAY, AGO_VI.days29],
    [30 * DAY, AGO_VI.month1],
    [364 * DAY, AGO_VI.months12],
    [365 * DAY, AGO_VI.year1],
    [3 * 365 * DAY, AGO_VI.years3],
  ])('%i ms ago → %s', (ms, expected) => {
    expect(relativeTime(ago(ms), NOW)).toBe(expected)
  })

  it('an unreadable string gives null, does not throw RangeError', () => {
    expect(relativeTime('not a date', NOW)).toBeNull()
    expect(relativeTime('', NOW)).toBeNull()
  })

  it('defaults to comparing with Date.now()', () => {
    expect(relativeTime(new Date().toISOString())).toBe(msg('Site.time.justNow'))
  })
})
