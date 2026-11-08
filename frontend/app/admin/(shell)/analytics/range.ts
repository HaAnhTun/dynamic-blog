/*
 * Date range of the Analytics page, read from `?from=&to=` of the GET form. Only what is certainly wrong is blocked
 * here (date format, order, length) so the backend is not called with garbage; a missing end lets the backend use its default.
 */

export type RangeField = 'from' | 'to'

export type DateRange = {
  /** Trimmed; '' when left blank (the GET form sends `from=` for an empty field), i.e. let the backend choose. */
  from: string
  to: string
  /** null when it can be sent to the backend. `message` is a key of the `Admin.analytics` namespace (see RANGE_MESSAGES). */
  error: { message: string; fields: RangeField[] } | null
}

/** Counts both ends: exactly the maximum number of rows of the per-day table. */
export const MAX_RANGE_DAYS = 366

const DAY_MS = 86_400_000
const ISO_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/

/** Catalog keys (`Admin.analytics.<key>`); the `range.tooLong` message takes the argument `days` (MAX_RANGE_DAYS). */
export const RANGE_MESSAGES = {
  format: 'range.format',
  order: 'range.order',
  tooLong: 'range.tooLong',
}

/** Ordinal number (in UTC) of a real `YYYY-MM-DD` day, or null. */
function dayNumber(value: string): number | null {
  const match = ISO_DAY.exec(value)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  // Date.UTC shifts 2026-02-30 to 2/3 and years 0–99 to 19xx: the rebuilt date must equal the typed date.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.getTime() / DAY_MS
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

export function parseDateRange(fromParam: string | string[] | undefined, toParam: string | string[] | undefined): DateRange {
  const from = firstValue(fromParam)
  const to = firstValue(toParam)
  const fromDay = from === '' ? null : dayNumber(from)
  const toDay = to === '' ? null : dayNumber(to)

  const malformed: RangeField[] = []
  if (from !== '' && fromDay === null) malformed.push('from')
  if (to !== '' && toDay === null) malformed.push('to')
  if (malformed.length > 0) return { from, to, error: { message: RANGE_MESSAGES.format, fields: malformed } }

  if (fromDay !== null && toDay !== null) {
    if (fromDay > toDay) return { from, to, error: { message: RANGE_MESSAGES.order, fields: ['from', 'to'] } }
    if (toDay - fromDay + 1 > MAX_RANGE_DAYS) {
      return { from, to, error: { message: RANGE_MESSAGES.tooLong, fields: ['from', 'to'] } }
    }
  }
  return { from, to, error: null }
}
