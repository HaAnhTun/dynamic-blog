/** From this number of parts up, the block shows a window around the part being read instead of the whole list. */
export const SERIES_FULL_LIST_MAX = 7

/** One row of the block: a part (index among the published parts) or a "…" gap. */
export type SeriesRow = { kind: 'part'; index: number } | { kind: 'gap'; after: number }

/**
 * The rows to show for `count` parts when part `current` is being read (index from 0).
 *
 * Up to 7 parts: show all. From 8 parts: first, …, n−1, n, n+1, …, last — enough to know where you
 * are and where to go next, while the block is not as long as the whole table of contents of the series.
 *
 * A gap that hides only ONE part shows that part instead: the "…" takes exactly the place of one row, so
 * replacing a title with it only hides information without saving anything.
 */
export function seriesRows(count: number, current: number): SeriesRow[] {
  if (count <= SERIES_FULL_LIST_MAX) {
    return Array.from({ length: count }, (_, index) => ({ kind: 'part', index }))
  }

  const keep = [...new Set([0, current - 1, current, current + 1, count - 1])]
    .filter((index) => index >= 0 && index < count)
    .sort((a, b) => a - b)

  const rows: SeriesRow[] = []
  let previous = -1
  for (const index of keep) {
    const hidden = index - previous - 1
    if (hidden === 1) rows.push({ kind: 'part', index: previous + 1 })
    else if (hidden > 1) rows.push({ kind: 'gap', after: previous })
    rows.push({ kind: 'part', index })
    previous = index
  }
  return rows
}
