/**
 * Date and time on the reader's clock, for comments: "14:30, 08/10/2026" and
 * "14:30".
 *
 * Client-side only. Comments are only rendered in the browser (loaded after hydration, like
 * lib/relative-time.ts), so there is no server HTML to mismatch, and "14:30" must be the reader's
 * 14:30. The opposite of lib/date.ts: a post's date is rendered on the server and sits in cached HTML, so it is pinned to UTC there.
 *
 * Assembled by hand from `getHours`/`getMinutes`/`getDate`/`getMonth`/`getFullYear` (24-hour, two digits),
 * not through Intl: the separator that Vietnamese ICU prints changes with the ICU version (precedent: `formatDayMonth`
 * in lib/date.ts). An unreadable value gives null, the same contract as lib/date.ts: the caller drops that
 * line, never printing "Invalid Date".
 */

function parse(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** "14:30": hour and minute, 24-hour. Seconds are dropped, not rounded up to the next minute. */
export function formatLocalTime(iso: string | null | undefined): string | null {
  const date = parse(iso)
  return date === null ? null : clock(date)
}

/** "14:30, 08/10/2026": the hour first and then day/month/year, like the spoken form "half past two on the 8th of October". */
export function formatLocalDateTime(iso: string | null | undefined): string | null {
  const date = parse(iso)
  if (date === null) return null
  return `${clock(date)}, ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

/** Two instants falling on the same day on the reader's calendar. One of the two unreadable: false. */
export function isSameLocalDay(a: string | null | undefined, b: string | null | undefined): boolean {
  const first = parse(a)
  const second = parse(b)
  return (
    first !== null &&
    second !== null &&
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  )
}
