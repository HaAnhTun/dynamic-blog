import { useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/config'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import type { Category, PostSummary, SeriesRef, Tag } from '@/lib/types'
import { Container, type ContainerWidth } from './Container'
import { ListRow } from './ListRow'

/** How many related posts the design shows. */
export const RELATED_COUNT = 3

/** The same category weighs as much as two shared tags: a category is one deliberate choice, tags are many small labels. */
const CATEGORY_WEIGHT = 2

/** Publish time in ms; when missing or unreadable it sorts after every post that has a date. */
function publishedTime(post: PostSummary): number {
  const time = post.publishedAt ? Date.parse(post.publishedAt) : Number.NaN
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/**
 * The posts to offer a reader at the end of an article: the ones that share the most
 * with it, never this one.
 *
 * A post's score = 2 × (same category) + number of shared tags, compared by slug (what links use; names may
 * collide between two categories), each tag counted once even if the post lists it twice. Only posts with a score
 * > 0, higher score first, on equal score the newer post first — sorted by date, not trusting the list
 * order — and at most three. Previously it only matched by category, and four of the twelve posts were in a
 * category with only one post so they had no related posts; shared tags pull posts for them.
 *
 * Three cases must still produce an empty list rather than an error or a lone heading:
 *  - a post with no category and no tags — nothing to compare, so the list is not read: no
 *    "every post" gets presented under a heading saying they are related;
 *  - no post shares anything — empty, not padded with the newest post;
 *  - fewer than three posts with a score — show fewer, never pad.
 *
 * Parts of the same series are excluded: the series block and PostNav right above already lead to
 * them, so "related" must be something else, even though they share the most categories and tags.
 *
 * The source is `fetchAllPublishedPosts()`, not a separate `getPosts({ category })`: the same request
 * (same URL, `posts` tag, 300 seconds) that "what to read next" (getDiscovery) and PostNav read on this page,
 * so Next merges them into one, and ranking runs over the whole archive instead of one page of one category.
 *
 * The listing failing must not take the article down with it. The reader already has
 * the post; a 503 from /api/v1/posts is a reason to show no "related" strip, not a
 * reason to replace a page that rendered fine with an error. `getPost` has already
 * succeeded by the time this runs, so this is not swallowing the error that matters.
 *
 * THE TRY WRAPS ONLY THE REQUEST, and that is deliberate rather than tidy. The first
 * version of this function held the whole body — the `post.category.slug` read
 * included — inside the try, and deleting the `if (!category) return []` guard then
 * produced a TypeError that the catch swallowed into an empty list. The behaviour was
 * accidentally correct, the guard was dead code, and the test written to protect it
 * passed either way: measured, with the guard replaced by `if (false)`, all 56 tests
 * stayed green. A catch that covers our own property accesses cannot tell a dependency
 * being down from a bug in this file.
 */
export async function getRelatedPosts(
  post: {
    slug: string
    category: Category | null
    tags: Tag[]
    series?: SeriesRef | null
  },
  language?: Locale,
): Promise<PostSummary[]> {
  // Read BEFORE the try: the catch below must cover the network call and nothing of ours.
  const categorySlug = post.category?.slug ?? null
  const tagSlugs = new Set(post.tags.map((tag) => tag.slug))
  if (categorySlug === null && tagSlugs.size === 0) return []
  const seriesSlug = post.series?.slug ?? null

  let all: PostSummary[]
  try {
    all = await fetchAllPublishedPosts(language)
  } catch {
    return []
  }

  const scored: Array<{ item: PostSummary; score: number; time: number }> = []
  for (const item of all) {
    if (item.slug === post.slug) continue
    if (seriesSlug !== null && item.series?.slug === seriesSlug) continue
    // `categorySlug !== null` first: two posts that both have NO category are not in the same category.
    const sameCategory = categorySlug !== null && item.category?.slug === categorySlug
    const sharedTags = new Set(item.tags.map((tag) => tag.slug).filter((slug) => tagSlugs.has(slug))).size
    const score = (sameCategory ? CATEGORY_WEIGHT : 0) + sharedTags
    if (score > 0) scored.push({ item, score, time: publishedTime(item) })
  }

  return scored
    .sort((a, b) => b.score - a.score || b.time - a.time)
    .slice(0, RELATED_COUNT)
    .map(({ item }) => item)
}

/**
 * Renders nothing — not a heading, not a bordered empty box — when there is nothing
 * to relate to. A section titled with the related-posts heading and with no list under it reads as
 * a bug to a sighted reader and announces as an empty region to a screen reader.
 */
export function RelatedPosts({
  posts,
  width = 'prose',
}: {
  posts: PostSummary[]
  /** The frame: `prose` by default, `bare` inside the post page's end slot, which is already a column. */
  width?: ContainerWidth
}) {
  const t = useTranslations('Site.related')
  if (posts.length === 0) return null

  // The block carries the shared rhythm of the end-of-article slot (border-t py-10, no top margin) on the <section> itself;
  // the Container (the margins of a column of its own) is outside it, so the divider is as long as the text and not 24px longer on each side.
  //
  // print:hidden: print is the post, not navigation to other posts.
  const block = (
    <section
      aria-labelledby="bai-lien-quan"
      className="border-t border-neutral-200 py-8 sm:py-10 print:hidden dark:border-neutral-800"
    >
      {/* The id exists for aria-labelledby, not for a fragment link: a <section> with no
            accessible name is not exposed as a region landmark at all, so a reader using
            landmark navigation on an article page would not find this strip. */}
      <h2 id="bai-lien-quan" className="text-xl font-semibold tracking-tight">
        {t('title')}
      </h2>

      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
        {posts.map((post) => (
          <li key={post.id} className="py-5 first:pt-0 last:pb-0">
            {/*
                `showCategory={false}`, kept even though now a related post may be in another category
                (matched by tag). Most are still in the same category as the post above — the same
                category weighs twice a tag — so printing it three more times says nothing new, and three
                category links are three keyboard stops that do not help choose a post; the compact row
                reserves room for the title. The row goes through ListRow, and so through ReadingMeta,
                rather than formatting the date here — the `timeZone: 'UTC'` guard exists in one
                place, and the last time this site had two copies of a date formatter one of
                them drifted.

                `compact`: a 6rem thumbnail at every width, a title smaller than the list row. No
                tags: the post page already has its own tag row, and each tag link should only appear
                once on the page (the post page test pins that).
              */}
            <ListRow post={post} headingLevel={3} compact showCategory={false} showTags={false} />
          </li>
        ))}
      </ul>
    </section>
  )

  return width === 'bare' ? (
    block
  ) : (
    <Container width={width} className="print:hidden">
      {block}
    </Container>
  )
}
