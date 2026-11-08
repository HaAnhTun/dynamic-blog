import 'server-only'
import type { Locale } from '@/i18n/config'
import { getJson } from './fetch-json'
import type { SeriesDetail, SeriesSummary } from './types'

/*
 * Public series: only a series with at least one published part.
 *
 * Both functions cache 300 seconds under two tags, because two different things change the result: editing a series
 * or the order of its parts (`series`) and publishing/unpublishing a post (`posts`) — whether a series shows, and how many
 * parts it has, both depend on which posts are published. The series admin calls updateTag on both.
 */

function langQuery(language?: Locale): string {
  return language ? `?lang=${language}` : ''
}

/**
 * All series, most recently updated first. Not paginated: the backend returns the whole list, each series with
 * the names of its parts (`parts`) so the /series page does not make one more call per series.
 *
 * Throws when the backend fails, does not return []: a page that treats series as a secondary block catches it itself and hides the block;
 * returning [] here would turn "API broken" into "no series yet" everywhere.
 */
export async function getSeriesList(language?: Locale): Promise<SeriesSummary[]> {
  const body = await getJson<SeriesSummary[] | null>(`/api/v1/series${langQuery(language)}`, {
    next: { revalidate: 300, tags: ['series', 'posts'] },
  })
  // `?? []`: a 200 without `data` must not become undefined and then break at `.map()` far from here.
  return body.data ?? []
}

/**
 * A series and its published parts in reading order. An unknown slug, or a series with no
 * published part, is a 404 → `NotFoundError` so the page calls notFound().
 *
 * The slug comes from the URL so it is encoded: `../../admin/users` must not escape /series.
 */
export async function getSeries(slug: string, language?: Locale): Promise<SeriesDetail> {
  const body = await getJson<SeriesDetail>(`/api/v1/series/${encodeURIComponent(slug)}${langQuery(language)}`, {
    next: { revalidate: 300, tags: ['series', 'posts'] },
  })
  return body.data
}
