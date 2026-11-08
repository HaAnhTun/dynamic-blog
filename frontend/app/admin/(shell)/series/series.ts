import type { SeriesPart } from '@/components/admin/SeriesPartsManager'
import type { PostSummary, SeriesAdmin, SeriesAdminPost } from '@/lib/types'
import { isUuid } from '@/lib/uuid'

/*
 * The shared part of the series screen: the edit page (server) and the action file ('use
 * server') both build `SeriesPart`. A plain module, no directive: a function exported from a 'use
 * server' file is a public endpoint.
 */

/** A part already in this series: it has no "currently in another series" label. */
export function toPart(post: SeriesAdminPost): SeriesPart {
  return { id: post.id, title: post.title, status: post.status, otherSeries: null }
}

/**
 * What "Add post" lists: every post that is not yet a part of this series, keeping arrival order (newest
 * created first). Any status, unlike "Best posts": a series is outlined before its parts are
 * finished, and the public page only counts published parts ("Part n/m" from partNumber/partCount).
 * A post in another series carries that series name, since saving will move it here.
 */
export function candidatesFor(series: SeriesAdmin, posts: PostSummary[]): SeriesPart[] {
  const members = new Set(series.posts.map((post) => post.id))
  return posts
    .filter((post) => !members.has(post.id))
    .map((post) => ({
      id: post.id,
      title: post.title,
      status: post.status,
      otherSeries: post.series != null && post.series.id !== series.id ? post.series.title : null,
    }))
}

/**
 * A series id is a UUID. Checked before calling the API: the backend returns 400 (not 404) for a path
 * segment that cannot be read as a UUID, and the page would become an error page instead of a 404.
 */
export function isSeriesId(id: string): boolean {
  return isUuid(id)
}
