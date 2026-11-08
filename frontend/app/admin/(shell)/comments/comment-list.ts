import type { CommentStatus } from '@/lib/types'
import { isUuid } from '@/lib/uuid'

/*
 * Reading and building the URL of the Comments page. Unlike the post list, filtering, search and
 * pagination here are all done by the backend (`GET /api/v1/admin/comments?status&q&postId&page&size`): the number of comments
 * has no ceiling like the number of posts of a personal blog, so they are not all read back to filter in place.
 *
 * The page reader and the search box are shared with the post list: the same bugs (`?page=2147483648` becoming a 500,
 * a paragraph pasted into the search box) are already blocked there.
 */
export { parsePage, parseQuery } from '../post-list'

/** The backend's default page size; the same number as the post list. */
export const COMMENT_PAGE_SIZE = 20

export type CommentFilter = 'all' | 'visible' | 'hidden' | 'deleted'

/** Order of the filter strip; `labelKey` is a key of the `Admin.comments` namespace ("all", "visible", "hidden", "deleted"). */
export const COMMENT_FILTERS: readonly { key: CommentFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'filters.all' },
  { key: 'visible', labelKey: 'filters.visible' },
  { key: 'hidden', labelKey: 'filters.hidden' },
  { key: 'deleted', labelKey: 'filters.deleted' },
]

const STATUS_OF: Record<Exclude<CommentFilter, 'all'>, CommentStatus> = {
  visible: 'VISIBLE',
  hidden: 'HIDDEN',
  deleted: 'DELETED',
}

/**
 * The entry that opens when the URL says nothing: "Visible" — exactly what readers currently see, i.e. what needs
 * moderating. It used to be "All", which includes deleted comments: work to do mixed into history. "All"
 * still exists, with its own URL `?status=all`.
 */
export const DEFAULT_COMMENT_FILTER: CommentFilter = 'visible'

/**
 * `?status=` is lowercase like the post list (`?status=draft`). An unknown or missing value is the default entry: an old link
 * never becomes a confusing empty list, and the backend never receives an unknown enum value (400).
 */
export function parseCommentFilter(raw: string | string[] | undefined): CommentFilter {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === 'all' || value === 'visible' || value === 'hidden' || value === 'deleted' ? value : DEFAULT_COMMENT_FILTER
}

/** Status sent to the backend; null means no filter. */
export function statusOfFilter(filter: CommentFilter): CommentStatus | null {
  return filter === 'all' ? null : STATUS_OF[filter]
}

/**
 * `?post=<post id>`: only the comments of one post. Not a UUID means no filtering: the backend returns 400
 * for a malformed `postId`, and a hand-edited URL must not become an error page. Lowercase: one post, one URL.
 */
export function parsePostFilter(raw: string | string[] | undefined): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  return isUuid(value) ? value.toLowerCase() : null
}

export type CommentListState = {
  status: CommentFilter
  query: string
  /** Id of the post being filtered by; null or missing means every post. */
  post?: string | null
  page?: number
}

/** URL of a list state, dropping every default parameter so the URL is as short as possible. */
export function commentListHref({ status, query, post = null, page }: CommentListState): string {
  const params = new URLSearchParams()
  if (status !== DEFAULT_COMMENT_FILTER) params.set('status', status)
  if (query !== '') params.set('q', query)
  if (post !== null) params.set('post', post)
  if (page !== undefined && page > 0) params.set('page', String(page))
  const search = params.toString()
  return search === '' ? '/admin/comments' : `/admin/comments?${search}`
}
