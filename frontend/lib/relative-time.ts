/**
 * "3 minutes ago" for comments, using `Intl.RelativeTimeFormat` (the text of "just now" comes from the `Site.time` messages).
 *
 * Client side only: comments are loaded after the page has hydrated, so there is no server HTML
 * to mismatch with, and "ago" is always computed from the reader's clock. The component puts the result in
 * `<time dateTime={iso} title={…}>` so the exact moment can still be read.
 *
 * `numeric: 'always'` ("1 day ago") rather than `'auto'`: Vietnamese ICU capitalizes "yesterday",
 * which in the middle of a line "Name · Yesterday" looks like a bug.
 */

import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translator'
import { relativeTimeFormat } from './format'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Null when `iso` is unreadable, the same contract as lib/date.ts. `t` is the translator of the `Site.time` namespace. */
export function relativeTime(iso: string, now: number, locale: Locale, t: Translator): string | null {
  const format = relativeTimeFormat(locale, { numeric: 'always' })
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const elapsed = now - at
  // Under a minute, including a "future" moment when the reader's clock runs slow.
  if (elapsed < MINUTE) return t('justNow')
  if (elapsed < HOUR) return format.format(-Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return format.format(-Math.floor(elapsed / HOUR), 'hour')
  const days = Math.floor(elapsed / DAY)
  if (days < 30) return format.format(-days, 'day')
  if (days < 365) return format.format(-Math.floor(days / 30), 'month')
  return format.format(-Math.floor(days / 365), 'year')
}
