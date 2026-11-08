import { useLocale, useTranslations } from 'next-intl'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { Link } from '@/i18n/navigation'
import type { ComponentType, ReactNode } from 'react'
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  EyeIcon,
  LayersIcon,
  LinkIcon,
  PenLineIcon,
  RssIcon,
  ShuffleIcon,
  StarIcon,
  TagsIcon,
  TrendingUpIcon,
  type IconProps,
} from '@/components/icons'
import { formatDate, formatMonth } from '@/lib/date'
import { DISCOVERY_LIMITS, shouldShowViews, type Discovery, type TagCount } from '@/lib/discovery'
import { postLinkLocale } from '@/lib/post-language'
import { asLocale, numberFormat } from '@/lib/format'
import { FEED_PATH } from '@/lib/site'
import { archiveMonthHref } from '@/lib/reader-rail'
import { Container, type ContainerWidth } from './Container'
import { META_ICON } from './ReadingMeta'
import { FOCUS, INLINE_LINK, SectionHeading, TITLE_LINK, TRANSITION } from './SectionHeading'

/**
 * A count in the number format of the locale: 12345 → "12.345" in vi, "12,345" in en. Exported for the stats line of /writing and the post count
 * on /topics, so every count on these pages is written the same way.
 */
export function formatCount(value: number, locale: Locale = DEFAULT_LOCALE): string {
  return numberFormat(locale).format(value)
}

/** The "All …" exit under a block: the same style as the action link of SectionHeading. */
const MORE_LINK = `mt-2 inline-block text-sm font-medium text-brand max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:gap-1 sm:mt-4 ${FOCUS} ${TRANSITION} hover:underline hover:underline-offset-4`

/** Footer row: a text link with a leading icon, like the footer. */
const FOOT_LINK = `inline-flex items-center gap-2 ${INLINE_LINK} text-neutral-700 max-sm:min-h-11 dark:text-neutral-300`

/**
 * The lists of the /writing band. Below `sm` each row is a 44px link row separated by a hairline (a text link of 20px with 8px between
 * was a 28px pitch); from `sm` the plain list of before. The row is a flex box there, and the text of a flex box is an anonymous item
 * whose minimum width is its longest word: `break-words` does not lower that, `overflow-wrap: anywhere` does, so a long unbroken title
 * wraps in the row instead of widening the page.
 */
const LIST =
  'mt-2 space-y-2 sm:mt-3 max-sm:space-y-0 max-sm:divide-y max-sm:divide-neutral-200 max-sm:[&>li>a]:flex max-sm:[&>li>a]:min-h-11 max-sm:[&>li>a]:items-center max-sm:[&>li>a]:[overflow-wrap:anywhere] dark:max-sm:divide-neutral-800'

/** Rows of a one-line link: 4px above and below the 44px row. */
const LIST_TIGHT = `${LIST} max-sm:[&>li]:py-1`

/** Rows of a title with a meta line under it (the series): 12px above and below, so the meta line does not touch the hairline. */
const LIST_TWO_LINES = `${LIST} max-sm:[&>li]:py-3`

/** Below `sm` the band is folded to the first entries of the long blocks (the band was 1,400px of a 4,800px page); from `sm` all stay. */
const PHONE_SERIES = 3
const PHONE_TAGS = 8
const PHONE_MONTHS = 6
const foldedFrom = (index: number, limit: number) => (index >= limit ? ' max-sm:hidden' : '')

/**
 * The lists of the "What to read next" band of a post. Below `sm` each row is a 44px link row separated by a hairline (a title that wraps
 * to two lines is one row, not two), like the related posts above; from `sm` the plain list of before.
 */
const ARTICLE_LIST =
  'mt-2 divide-y divide-neutral-200 sm:mt-3 sm:space-y-2 sm:divide-y-0 max-sm:[&>li]:py-3 max-sm:[&>li>a]:flex max-sm:[&>li>a]:min-h-11 max-sm:[&>li>a]:items-center max-sm:[&>li>a]:[overflow-wrap:anywhere] dark:divide-neutral-800'

/**
 * A count next to an entry: the eye sees the number, a screen reader hears "7 posts".
 *
 * The space sits OUTSIDE the sr-only span: the accessible name computation takes the name of each child element and then trims
 * whitespace at both ends, so `<span class="sr-only"> posts</span>` yields "7posts" (measured with
 * dom-accessibility-api). Outside, it is trailing whitespace of the block and does not show.
 *
 * Exported for the category strip of /writing and the /topics page: the same "number for the eye, unit
 * for the ear" convention everywhere there is a post count.
 */
export function Count({
  value,
  className = 'text-neutral-500 dark:text-neutral-400',
}: {
  value: number
  /** Text color. Defaults to neutral-500, which reaches 4.74:1 on a white background; on the gray background of a tag chip it does
   *  not (4.35:1), so chips pass neutral-600. */
  className?: string
}) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.discovery')
  return (
    <span className={`shrink-0 tabular-nums ${className}`}>
      {formatCount(value, locale)} <span className="sr-only">{t('postsUnit', { count: value })}</span>
    </span>
  )
}

/**
 * A block: an h3 with a 16px icon, then the content. The icon is inside the h3 but aria-hidden, so
 * the heading's name is still only the text — a screen reader browsing by headings hears "Tags", nothing
 * more.
 */
function Widget({ title, Icon, children }: { title: string; Icon: ComponentType<IconProps>; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="flex items-center gap-2 text-lg font-medium">
        <Icon className={META_ICON} />
        {title}
      </h3>
      {children}
    </div>
  )
}

/**
 * A tag chip with a post count: the "Tags" block here and the "Tags" section of /topics. The order is that of `tags` (lib/
 * discovery.ts already sorted it: more posts first, equal counts by Vietnamese alphabetical order).
 *
 * The post count is a digit, not a font size: a 10–22pt tag cloud is the only text noise on the
 * site. The link name is "Java 7 posts" (see Count).
 */
export function TagCountChips({
  tags,
  className = '',
  phoneLimit,
}: {
  tags: readonly TagCount[]
  className?: string
  /** Below `sm` only the first this-many chips are drawn (a CSS fold, every chip stays in the markup for `sm` and up). */
  phoneLimit?: number
}) {
  return (
    <ul className={`flex flex-wrap gap-2 ${className}`.trim()}>
      {tags.map(({ tag, count }, index) => (
        <li key={tag.id} className={phoneLimit === undefined ? undefined : foldedFrom(index, phoneLimit).trim() || undefined}>
          {/* `tag.slug`, never `tag.name` — see TagList in ReadingMeta.tsx. */}
          <Link
            href={`/tags/${encodeURIComponent(tag.slug)}`}
            className={`relative inline-flex min-h-9 items-center gap-1.5 rounded-full bg-neutral-100 px-3 text-[0.8125rem] text-neutral-700 after:absolute after:inset-x-0 after:-inset-y-1 hover:text-brand sm:min-h-0 sm:py-1 sm:text-xs sm:after:hidden dark:bg-neutral-800 dark:text-neutral-300 ${FOCUS} ${TRANSITION}`}
          >
            {/* neutral-600 and not the default color of Count: neutral-500 on the chip background
                neutral-100 is only 4.35:1 at 12px, below the AA 4.5:1 — the only contrast error
                the sitewide text scan found. neutral-600 is about 7:1. */}
            {tag.name} <Count value={count} className="text-neutral-600 dark:text-neutral-400" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

function MoreLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={MORE_LINK}>
      {/* The arrow is aria-hidden: the link name is the label, not "label right arrow". */}
      {label} <span aria-hidden="true">→</span>
    </Link>
  )
}

/** An array with entries, or null. A null block is a block that does not render. */
function shown<T>(items: readonly T[] | null | undefined, limit: number): T[] | null {
  return items && items.length > 0 ? items.slice(0, limit) : null
}

/**
 * The "Discover" block at the end of /writing and "What to read next" at the end of a post: an in-flow section, no
 * sidebar — a sidebar needs a third width and the `lg:` breakpoint, and on a phone it becomes a long
 * column of widgets below the list.
 *
 * The layout of SkillGroups: SectionHeading h2, then a two-column grid from 640px, one h3 per block.
 *
 * `variant` decides which blocks are present, even when `data` has data for other blocks:
 * - `writing`: Most read (or Read first), Series, Tags, Archive, Worth reading blogs. No "Recent":
 *   the list right above is already the newest posts.
 * - `article`: Most read (or Read first) and Recent. No tags: the post page test pins that
 *   each tag has only one link on the page. No series: SeriesBlock is already inside the post.
 * The view threshold, excluding the post being read and the number of entries per block belong to lib/discovery.ts; here we only
 * trim to the same limits, so a longer array does not lengthen the block.
 *
 * When every block is empty it returns null — no "Discover" h2 standing above empty space, and no footer
 * row on its own (it is the tail of the blocks, not content).
 *
 * It builds its own Container, at the frame width by default (`reader`), the same on /writing, /search and the post page.
 * Synchronous, no fetch: the page calls getDiscovery() and decides for itself when a source fails.
 */
export function DiscoveryGrid({
  id,
  title,
  data,
  variant,
  width,
}: {
  id: string
  title: string
  data: Discovery
  variant: 'writing' | 'article'
  /** The frame. Default `reader` (the 1400px frame width) for both variants: the band sits under the grid of the page, like the post page's. */
  width?: ContainerWidth
}) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.discovery')
  const isWriting = variant === 'writing'

  const popular = data.popular ? shown(data.popular.posts, DISCOVERY_LIMITS.popular) : null
  const recent = isWriting ? null : shown(data.recent, DISCOVERY_LIMITS.recent)
  const series = isWriting ? shown(data.series, DISCOVERY_LIMITS.series) : null
  const tags = isWriting ? shown(data.tags, DISCOVERY_LIMITS.tags) : null
  const months = isWriting ? shown(data.months, DISCOVERY_LIMITS.months) : null
  const blogroll = isWriting ? shown(data.blogroll, Number.POSITIVE_INFINITY) : null

  if (!popular && !recent && !series && !tags && !months && !blogroll) return null

  const isPopular = data.popular?.kind === 'popular'
  const list = isWriting ? LIST_TIGHT : ARTICLE_LIST

  return (
    <Container
      width={width ?? 'reader'}
      as="section"
      labelledBy={id}
      // /writing and /search: the band sits under a hairline (the caller's border-t) and above the footer, which supplies no space of its own.
      // print:hidden: navigation to other posts, not content of the printed page.
      className={isWriting ? 'pt-10 pb-10 sm:pb-14 print:hidden' : 'py-8 sm:py-10 print:hidden'}
    >
      <SectionHeading id={id} title={title} />

      <div className="mt-8 grid gap-x-12 gap-y-8 sm:grid-cols-2">
        {popular ? (
          isPopular ? (
            <Widget title={t('popular')} Icon={TrendingUpIcon}>
              {/* <ol>: the rank is the content of this block. */}
              <ol className={list}>
                {popular.map((post) => (
                  <li key={post.id} className="flex items-baseline justify-between gap-4">
                    <Link
                      href={`/posts/${encodeURIComponent(post.slug)}`}
                      locale={postLinkLocale(post, locale)}
                      className={`min-w-0 break-words ${TITLE_LINK}`}
                    >
                      {post.title}
                    </Link>{' '}
                    {shouldShowViews(post.viewCount) ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
                        <EyeIcon size={14} className={META_ICON} />
                        {/* The space is outside the sr-only, for the same reason as Count. */}
                        {formatCount(post.viewCount as number, locale)}{' '}
                        <span className="sr-only">{t('viewsUnit', { count: post.viewCount as number })}</span>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </Widget>
          ) : (
            <Widget title={t('readFirst')} Icon={StarIcon}>
              <ol className={list}>
                {popular.map((post) => (
                  <li key={post.id}>
                    <Link
                      href={`/posts/${encodeURIComponent(post.slug)}`}
                      locale={postLinkLocale(post, locale)}
                      className={`break-words ${TITLE_LINK}`}
                    >
                      {post.title}
                    </Link>
                  </li>
                ))}
              </ol>
              <MoreLink href="/start-here" label={t('fullList')} />
            </Widget>
          )
        ) : null}

        {recent ? (
          <Widget title={t('recent')} Icon={PenLineIcon}>
            <ul className={list}>
              {recent.map((post) => {
                const date = formatDate(post.publishedAt, 'long', locale)
                return (
                  <li key={post.id}>
                    <Link
                      href={`/posts/${encodeURIComponent(post.slug)}`}
                      locale={postLinkLocale(post, locale)}
                      className={`break-words ${TITLE_LINK}`}
                    >
                      {post.title}
                    </Link>
                    {post.publishedAt && date ? (
                      <div className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
                        <time dateTime={post.publishedAt}>{date}</time>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Widget>
        ) : null}

        {series ? (
          <Widget title={t('series')} Icon={LayersIcon}>
            <ul className={isWriting ? LIST_TWO_LINES : list}>
              {series.map((s, index) => (
                <li key={s.id} className={foldedFrom(index, PHONE_SERIES).trim() || undefined}>
                  <Link href={`/series/${encodeURIComponent(s.slug)}`} className={`break-words ${TITLE_LINK}`}>
                    {s.title}
                  </Link>
                  <div className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">
                    {s.readingMinutes >= 1
                      ? t('seriesPartsWithTime', { parts: s.postCount, minutes: s.readingMinutes })
                      : t('seriesParts', { parts: s.postCount })}
                  </div>
                </li>
              ))}
            </ul>
            {/* Only when there are series not yet shown: when the whole list is already here, that link would lead to itself. */}
            {data.seriesTotal > series.length ? (
              <MoreLink href="/series" label={t('allSeries')} />
            ) : series.length > PHONE_SERIES ? (
              // The fold hides the rest below sm, so the exit to the full list is there even when it would lead to itself from sm.
              <div className="sm:hidden">
                <MoreLink href="/series" label={t('allSeries')} />
              </div>
            ) : null}
          </Widget>
        ) : null}

        {tags ? (
          <Widget title={t('tags')} Icon={TagsIcon}>
            <TagCountChips tags={tags} className="mt-3" phoneLimit={PHONE_TAGS} />
            {/* Always present: /topics also has categories and descriptions, not only the tags that do not fit here. */}
            <MoreLink href="/topics" label={t('allTopics')} />
          </Widget>
        ) : null}

        {months ? (
          <Widget title={t('archive')} Icon={ArchiveIcon}>
            <ul className={isWriting ? LIST_TIGHT : list}>
              {months.map((bucket, index) => (
                // The post count sits right after the label (a month label followed by its count), like the category strip
                // (a category name followed by its count): pushed to the right edge, at 1440 it is ~300px from the label in a 464px column and
                // the eye has to cross the whole gap to pair the two.
                <li
                  key={`${bucket.year}-${bucket.month}`}
                  className={`flex items-baseline gap-1.5${foldedFrom(index, PHONE_MONTHS)}`}
                >
                  {/* The link is a flex item so it is a block, and `first-letter:` applies: the month name
                      at the start of the line, lowercase like formatMonth returns everywhere else. */}
                  <Link
                    href={archiveMonthHref(bucket.year, bucket.month, months[0]!.year)}
                    className={`first-letter:uppercase ${TITLE_LINK}`}
                  >
                    {formatMonth(bucket.year, bucket.month, locale)}
                  </Link>{' '}
                  <Count value={bucket.count} />
                </li>
              ))}
            </ul>
            <MoreLink href="/archive" label={t('fullArchive')} />
          </Widget>
        ) : null}

        {blogroll ? (
          <Widget title={t('blogroll')} Icon={LinkIcon}>
            <ul className={list}>
              {blogroll.map((entry) => (
                <li key={entry.url}>
                  {/* A plain <a>: the target is outside the site. ArrowUpRight says "leaves the site". */}
                  <a href={entry.url} className={`inline-flex items-center gap-1.5 ${TITLE_LINK}`}>
                    {entry.name}
                    <ArrowUpRightIcon size={14} className={META_ICON} />
                  </a>
                  {entry.note ? <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{entry.note}</p> : null}
                </li>
              ))}
            </ul>
          </Widget>
        ) : null}
      </div>

      <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <li>
          {/* `<a>`, not `<Link>`: /random returns a 307 to a different post each time, while the client
              router prefetches it and keeps one target — "random" only once. See Footer.tsx. */}
          <a href="/random" rel="nofollow" className={FOOT_LINK}>
            <ShuffleIcon />
            {t('randomPost')}
          </a>
        </li>
        <li>
          <a href={FEED_PATH} className={FOOT_LINK}>
            <RssIcon />
            {t('followRss')}
          </a>
        </li>
      </ul>
    </Container>
  )
}
