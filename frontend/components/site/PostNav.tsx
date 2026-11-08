import { useLocale, useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/config'
import { Link } from '@/i18n/navigation'
import { asLocale } from '@/lib/format'
import { postLinkLocale } from '@/lib/post-language'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import type { PostSummary } from '@/lib/types'
import { Container, type ContainerWidth } from './Container'

export type Adjacent = {
  /** Published BEFORE this one — older. Absent for the first post ever published. */
  previous: PostSummary | null
  /** Published AFTER this one — newer. Absent for the most recent post. */
  next: PostSummary | null
}

const NONE: Adjacent = { previous: null, next: null }

/**
 * The neighbours of `slug` in publication order.
 *
 * Looks in the FULL list of published posts. It used to be one page of the 50 newest posts
 * (`ADJACENCY_WINDOW`), and a post older than the 50th lost both buttons — a cliff that would arrive as the blog
 * grew. `fetchAllPublishedPosts()` reads the whole archive (100 posts per page) but costs no extra
 * request: the post page already calls exactly it, same URL and `posts` tag, for "what to read next"
 * (getDiscovery) and related posts, and Next merges identical fetches within one render.
 *
 * The listing comes back newest-first (verified against the running backend: item 0's
 * publishedAt is later than item 1's; fetchAllPublishedPosts keeps the API's order), so the
 * array index runs backwards relative to publication order. That inversion is the one thing
 * to get right here: `items[i + 1]` is the OLDER post and therefore the "previous" one,
 * `items[i - 1]` is the newer "next" one. Reading them off in array order instead gives a pair
 * of links that march the reader backwards through time under a label that says forwards.
 *
 * With `language` only the posts of that language are neighbours: a reader of the English article never gets a Vietnamese one.
 *
 * Returns both null when the post is not in the list (a draft, or a cache that has not caught
 * up), and when the listing fails — same reasoning as RelatedPosts: the article has already
 * loaded.
 */
export async function getAdjacentPosts(slug: string, language?: Locale): Promise<Adjacent> {
  let items: PostSummary[]
  try {
    items = await fetchAllPublishedPosts(language)
  } catch {
    return NONE
  }

  const index = items.findIndex((item) => item.slug === slug)
  if (index === -1) return NONE

  return {
    previous: items[index + 1] ?? null,
    next: items[index - 1] ?? null,
  }
}

const LINK =
  'group block rounded-md border border-neutral-200 p-4 transition-colors duration-[120ms] hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none dark:border-neutral-800'

/** `break-words`: the series label carries the whole series name, which can be longer than half a column at 320px. */
const LABEL =
  'block max-sm:line-clamp-1 break-words text-[0.8125rem] leading-snug text-neutral-600 sm:text-xs dark:text-neutral-400'

const TITLE =
  'mt-1 block text-[1.0625rem] leading-snug font-medium break-words [overflow-wrap:anywhere] text-neutral-900 transition-colors duration-[120ms] group-hover:text-brand sm:text-base sm:leading-normal motion-reduce:transition-none dark:text-neutral-100'

/**
 * A post's neighbors within its own series: the part right before and right after in reading order, among the
 * published parts. The post page builds it from `getSeries()`; when absent PostNav goes chronologically.
 */
export type SeriesNeighbours = {
  /** The series name, joined into the label: "Previous part · {title}". */
  title: string
  previous: PostSummary | null
  next: PostSummary | null
}

/**
 * Previous / next, rendering only the link that exists.
 *
 * Nothing at all when neither does — the first and only post on a new blog would
 * otherwise get an empty bordered strip. An empty placeholder card for the missing
 * side was considered and rejected: a reader cannot tell an empty card from a broken
 * one, and `sm:grid-cols-2` with a single child already leaves the one link in its
 * own column, which is the layout the placeholder was for.
 *
 * A post in a series: follows the parts, labels "Previous part · {series}" / "Next part ·
 * {series}" — a reader of part 2 needs part 3, not whichever post happened to be published after it. The two ways of going
 * are not mixed: the first part of a series only has "next part", with no older post by date filling in on the
 * left, because a nav with one side by series and the other by date is a wrong answer to "what to read
 * next". A series with no adjacent part (only one part published so far) falls back to chronological:
 * an empty nav helps nobody move on.
 */
export function PostNav({
  previous,
  next,
  series = null,
  width = 'prose',
}: Adjacent & {
  series?: SeriesNeighbours | null
  /** The frame: `prose` by default, `bare` when the caller already sits in a column of its own (the post page's end slot). */
  width?: ContainerWidth
}) {
  const t = useTranslations('Site.postNav')
  const current = asLocale(useLocale())
  // A neighbour is in the language of the article: under the other prefix its link still has to open in its own language.
  const own = (item: PostSummary) => ({ locale: postLinkLocale(item, current) })
  const bySeries = series && (series.previous || series.next) ? series : null
  const before = bySeries ? bySeries.previous : previous
  const after = bySeries ? bySeries.next : next
  if (!before && !after) return null

  const beforeLabel = bySeries ? t('previousPart', { title: bySeries.title }) : t('previous')
  const afterLabel = bySeries ? t('nextPart', { title: bySeries.title }) : t('next')

  // The divider and the vertical rhythm are the shared block style of the end-of-article slot (border-t py-10, no top margin),
  // on the outer wrapper: the <nav> sits inside the Container, so the divider is as long as the column it belongs to and not as long
  // as the window (measured at 1440: a divider on a full-width <nav> ran 0-1425, while the blocks around it are one column long).
  // The <nav> keeps its own name: Container takes no aria-label, and an unnamed nav landmark is unusable in a landmark list
  // next to the header's nav and the article's table of contents.
  //
  // print:hidden: on paper the previous/next post cards lead nowhere.
  const nav = (
    <nav aria-label={t('navLabel')} className="border-t border-neutral-200 py-8 sm:py-10 print:hidden dark:border-neutral-800">
      <div className="grid gap-4 sm:grid-cols-2">
        {before && (
          <Link href={`/posts/${encodeURIComponent(before.slug)}`} {...own(before)} className={LINK}>
            <span className={LABEL}>{beforeLabel}</span>
            {/*
                An explicit space text node, and it is load-bearing rather than
                formatting. The link's accessible name is the concatenation of its
                descendants' text, and the accname algorithm only inserts a separator
                around a BLOCK-level element — a judgement that depends on CSS. jsdom
                loads no CSS at all, so without this the name computes as
                "PreviousNext", one run of text with no word boundary, which is what
                a screen reader would announce anywhere the stylesheet had not applied
                yet. Measured, not assumed: dom-accessibility-api returns exactly that
                string when this is removed.
              */}{' '}
            <span className={TITLE}>{before.title}</span>
          </Link>
        )}

        {after && (
          // `sm:col-start-2` so that a post with no previous still puts its single
          // "next" card on the right, where the reader's eye expects forward motion.
          // Without it the lone card sits in column 1 and reads as "previous".
          <Link
            href={`/posts/${encodeURIComponent(after.slug)}`}
            {...own(after)}
            className={`${LINK} sm:col-start-2 sm:text-right`}
          >
            <span className={LABEL}>{afterLabel}</span> <span className={TITLE}>{after.title}</span>
          </Link>
        )}
      </div>
    </nav>
  )

  return width === 'bare' ? (
    nav
  ) : (
    <Container width={width} className="print:hidden">
      {nav}
    </Container>
  )
}
