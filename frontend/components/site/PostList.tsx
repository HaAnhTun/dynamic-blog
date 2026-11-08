import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import type { HighlightSegment } from '@/lib/highlight'
import type { PostSummary } from '@/lib/types'
import { ListRow } from './ListRow'

export type RowHighlight = { title?: readonly HighlightSegment[]; excerpt?: readonly HighlightSegment[] }

/**
 * One list renderer for every listing route: /writing, /categories/[slug], /tags/[slug]
 * and /search.
 *
 * Extracted because those routes differ only in which posts they ask for. Three copies of
 * a row would be three places for a tag href to be built from `tag.name` instead of
 * `tag.slug`, and this project has already shipped that exact bug once.
 *
 * Each row is a ListRow: a 3:2 thumbnail on the right, meta with icons, a kicker for posts
 * in a series. The row is always an h2: these pages have no heading between the h1 and the list
 * (see the note on each page), so an h3 would skip a level.
 *
 * `readingMinutes` used to be re-declared here as an optional intersection type, because
 * lib/types.ts did not have it. It does now (`readingMinutes: number`), so the rows take
 * `PostSummary` as is; ListRow still reads the field through `readingMinutesOf`, which
 * survives a payload that disagrees with the type.
 */
export function PostList({
  posts,
  emptyMessage,
  emptyFallback,
  showCategory = true,
  query,
  highlights,
}: {
  posts: PostSummary[]
  emptyMessage?: string
  /** Replaces the empty message when set (the "other language has posts" hint). */
  emptyFallback?: ReactNode
  /** `false` on the category page: the h1 is already the category name, a link on each row would only point back to itself. */
  showCategory?: boolean
  /** Search query, passed down to each row to highlight the keyword (ListRow). Only /search passes it. */
  query?: string
  /** The server's matches by `post.id`; a row without one is highlighted by `query`. */
  highlights?: ReadonlyMap<string, RowHighlight>
}) {
  const t = useTranslations('Site.listing')
  if (posts.length === 0) {
    if (emptyFallback) return <>{emptyFallback}</>
    return <p className="py-6 text-neutral-600 dark:text-neutral-400">{emptyMessage ?? t('empty')}</p>
  }

  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id} className="border-b border-neutral-200 py-5 last:border-0 sm:py-6 dark:border-neutral-800">
          <ListRow
            post={post}
            headingLevel={2}
            showCategory={showCategory}
            query={query}
            titleSegments={highlights?.get(post.id)?.title}
            excerptSegments={highlights?.get(post.id)?.excerpt}
          />
        </li>
      ))}
    </ul>
  )
}
