import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { dateFormat } from './format'

/**
 * Date formatting for the whole site. One definition, because there were five.
 *
 * `components/PostMeta.tsx` (since removed), `components/site/PostList.tsx`,
 * `components/site/ReadingMeta.tsx`, `components/site/NowSection.tsx` and the admin post
 * list each built their own UTC `Intl.DateTimeFormat`. They
 * agreed — but `timeZone: 'UTC'` is the kind of option that is quietly dropped during a
 * refactor, and five copies means five chances to drop it and five separate tests that
 * each have to be written to notice.
 *
 * ## Why timeZone is not optional
 *
 * Without it the date is formatted in the SERVER's zone, so a post published at
 * 2026-09-28T17:30:00Z renders as the 29th on any host east of UTC+7 and the 27th west of
 * UTC-6 — and the page a reader sees depends on which machine rendered it. The test suite
 * pins `TZ=Asia/Ho_Chi_Minh` precisely so that deleting this option is detectable: on a
 * UTC host it changes nothing, which is how a commit in this project once claimed a guard
 * worked when it could only have failed on a non-UTC machine.
 *
 * ## Why the formatters are cached
 *
 * `new Intl.DateTimeFormat(...)` is not cheap, and these run once per row of a listing.
 * lib/format.ts caches one per locale and options.
 */
function utcFormat(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return dateFormat(locale, { ...options, timeZone: 'UTC' })
}

/**
 * Formats an ISO timestamp, or returns null when it cannot.
 *
 * Null rather than a thrown error or a placeholder string, for a measured reason:
 * `Intl.DateTimeFormat.prototype.format` THROWS a RangeError on an invalid Date, so
 * `formatDate(post.publishedAt)` on a malformed value would take down the whole page
 * instead of dropping one line of metadata. The caller decides what an absent date looks
 * like — usually by rendering nothing.
 */
export function formatDate(
  iso: string | null | undefined,
  style: 'long' | 'medium' = 'long',
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  if (iso === null || iso === undefined || iso === '') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return utcFormat(locale, { dateStyle: style }).format(date)
}

/**
 * The update date of a post, for the "Updated …" line on the post page, or null when that line
 * says nothing more than the publish date.
 *
 * Null unless: both dates are readable, the edit date is AFTER the publish date, and the edit date comes out as a DIFFERENT DAY from the
 * publish date when both are formatted. A post created as a draft and published after the last save has an `updatedAt` earlier than
 * `publishedAt`; a typo fixed a few hours after publishing is the same day — an "Updated" line in both
 * cases is noise, or a wrong sentence.
 *
 * Compare by the very string `formatDate` prints (UTC, `LONG`), not by the server's day: the two dates side
 * by side on the page are written by one formatter, so "a different day" must mean different to what the
 * reader sees. At UTC+7 the two instants 16:30Z and 17:30Z on the 28th are two different local days, and
 * comparing in local time would print the "Updated 28 September" line right next to "28 September".
 */
export function formatUpdated(
  publishedAt: string | null | undefined,
  updatedAt: string | null | undefined,
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  const published = formatDate(publishedAt, 'long', locale)
  const updated = formatDate(updatedAt, 'long', locale)
  if (published === null || updated === null) return null
  // Both are readable (formatDate is not null), so Date.parse here is a number.
  if (Date.parse(updatedAt as string) <= Date.parse(publishedAt as string)) return null
  return updated === published ? null : updated
}

/**
 * One month of the archive: `formatMonth(2026, 10)` → the Vietnamese "month 10 year 2026". `month` is 1–12,
 * exactly like `MonthBucket` in lib/discovery.ts.
 *
 * Takes year and month, not an instant: the month was already grouped in UTC in lib/discovery.ts, and
 * the date rebuilt here must also be UTC (`Date.UTC`) — `new Date(2026, 9, 1)` is midnight local time,
 * which at UTC+7 is still 30/09 in UTC, so October would print as September.
 *
 * Lowercase as Intl returns it, so it can sit mid-sentence. Where it opens a line (the month heading,
 * a row in the Archive block) capitalize the first letter with CSS `first-letter:uppercase`.
 */
export function formatMonth(year: number, month: number, locale: Locale = DEFAULT_LOCALE): string {
  return utcFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 1)))
}

/**
 * Day and month, two digits, in UTC: "03/10". For the compact row of the archive page, where the heading
 * of the month already gives year and month so each row only needs the day.
 *
 * Assembled by hand from `getUTC*` rather than through Intl: Vietnamese ICU prints `{day:'2-digit', month:'2-digit'}`
 * as "03-10" (measured on Node 24), and that separator changes with the ICU version. Null for
 * an unreadable value, the same contract as `formatDate`.
 */
export function formatDayMonth(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso === '') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${day}/${month}`
}

/**
 * The same instant in the date format RSS 2.0 requires, or null when it cannot.
 *
 * RSS `<pubDate>` is RFC-822, not ISO-8601, and `Date.prototype.toUTCString` produces
 * exactly that spelling — `Sat, 03 Oct 2026 18:23:29 GMT` — with the four-digit year the
 * RSS specification explicitly permits. So this is a guard around one call rather than a
 * formatter: writing the parts out by hand would mean a month-name table and an off-by-one
 * on `getUTCMonth`, both of which `toUTCString` already gets right.
 *
 * The guard is the point. `new Date('garbage').toUTCString()` returns the literal string
 * `"Invalid Date"`, and nothing throws — so the naive version puts `<pubDate>Invalid
 * Date</pubDate>` in the feed, which every reader rejects and no test notices unless it
 * looks for that exact string. Returning null lets the caller omit the element, which is
 * what an undated post should produce.
 *
 * Same null contract as `formatDate` above, deliberately: one rule for absent dates across
 * the site rather than two.
 */
export function rfc822Date(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso === '') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toUTCString()
}
