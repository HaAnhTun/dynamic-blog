import type { ReactNode } from 'react'
import { Link } from '@/i18n/navigation'
import { CalendarDaysIcon, ClockIcon, FolderIcon, PenLineIcon, TagIcon } from '@/components/icons'
import type { Category, PostSummary, Tag } from '@/lib/types'
import { formatDate, formatUpdated } from '@/lib/date'
import { FOCUS, TRANSITION } from './SectionHeading'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/**
 * The API returns `readingMinutes` on every post and every summary — verified against
 * the running backend, not assumed:
 *   curl -s "localhost:8080/api/v1/posts?size=1" → "readingMinutes":12
 * (PostMapper computes it; PostResponse and PostSummaryResponse both declare it.)
 *
 * `lib/types.ts` declares it as `readingMinutes: number`, but a type describes what the API
 * promises, not what a given payload holds, so the value is still checked at runtime.
 * The guard is not ceremony: `0` and a negative number both mean "no useful answer"
 * and a reading time of 0 is worse than printing nothing, and if the key is ever missing from
 * an older cached response this returns null rather than rendering NaN in the reading time.
 */
export function readingMinutesOf(post: PostSummary): number | null {
  const value: unknown = post.readingMinutes
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null
  return Math.round(value)
}

const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400'

/** One item of the meta row: icon then text, tighter than the gap between two items so the eye pairs the
 *  icon with its own text. */
const ITEM = 'inline-flex items-center gap-1.5'

/**
 * Color of the leading icon (the same icon color as the widget headings). Paler than the text beside it:
 * the icon only says the kind of information, the text is the information. Exported so ListRow's series kicker
 * uses the same color.
 */
export const META_ICON = 'text-neutral-400 dark:text-neutral-500'

const LINK = `${FOCUS} ${TRANSITION} hover:text-brand`

/**
 * Everything the reader needs to place an article before reading it: when it was
 * published, where it sits, how long it will take, and what it is about.
 *
 * Every field is independently optional. A post with no category, no tags, no date
 * and no reading time renders an empty row rather than four separators with nothing
 * between them — which is why there are no literal "·" separators here and the
 * spacing is `gap-x-3` instead.
 *
 * Each item has a leading 14px icon: CalendarDays, Folder, Clock. The icon sits
 * BESIDE <time>, not inside it — the content of <time> must be the date itself — and the icon always goes
 * with its own item: a missing item means a missing icon, never an icon standing alone.
 *
 * `updatedAt`: "[PenLine] Updated <time>" right after the publish date, when
 * formatUpdated says it is worth showing — edited on a day (UTC) after the publish date. List rows do not
 * pass it: a second date column on each row is noise, and that place belongs to the publish date.
 */
export function ReadingMeta({
  publishedAt,
  updatedAt,
  category,
  tags,
  readingMinutes,
  className = '',
  leading,
  trailing,
}: {
  publishedAt: string | null
  /** The post's last edit; only shown when different from the publish date (formatUpdated). */
  updatedAt?: string | null
  category: Category | null
  tags: Tag[]
  readingMinutes: number | null
  className?: string
  /** Extra items at the start of the same flex row (the post hero's series badge and title), the twin of `trailing`. */
  leading?: ReactNode
  /** Extra items at the end of the same flex row (the post page's views), so the row is not wrapped in a second flex row. */
  trailing?: ReactNode
}) {
  // timeZone is not optional, and its absence is invisible on a UTC host. Without it the
  // date is formatted in the server's zone, so a post published at 17:30Z prints as the
  // 29th on any host at UTC+7 and the 27th west of UTC-6 — two readers on two continents
  // see two different publication dates for the same article. vitest.config.mts pins
  // TZ=Asia/Ho_Chi_Minh precisely so the test for this line can fail. formatDate owns
  // the option (lib/date.ts).
  //
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.article')
  // Formatted before the JSX rather than inside <time>: formatDate returns null for a value
  // it cannot parse, and the old `{publishedAt && <time>…}` then rendered an empty <time>.
  // With an icon beside it that empty <time> would be a calendar glyph with no date.
  const date = formatDate(publishedAt, 'long', locale)
  // null whether missing, broken, earlier, or on the same day as the publish date — so a non-null `updatedAt` in
  // the branch that shows below has already been checked.
  const updated = formatUpdated(publishedAt, updatedAt, locale)

  return (
    <div className={className || undefined}>
      <div className={ROW}>
        {leading}

        {publishedAt && date ? (
          <span className={ITEM}>
            <CalendarDaysIcon size={14} className={META_ICON} />
            <time dateTime={publishedAt}>{date}</time>
          </span>
        ) : null}

        {updatedAt && updated ? (
          // The "updated" label and <time> in one span: a single flex item, so the gap between the text and the date is
          // a normal space, not the gap-1.5 slot; and textContent reads on as the updated label followed by the date.
          <span className={`${ITEM} max-sm:order-last max-sm:basis-full`}>
            <PenLineIcon size={14} className={META_ICON} />
            <span>
              {t.rich('updated', {
                date: updated,
                time: (chunks) => <time dateTime={updatedAt}>{chunks}</time>,
              })}
            </span>
          </span>
        ) : null}

        {category && (
          // The icon sits inside the link so the glyph is part of the click target; it is
          // aria-hidden, so the link's accessible name is still the category name alone.
          <Link
            href={`/categories/${encodeURIComponent(category.slug)}`}
            className={`${ITEM} ${LINK} max-sm:relative max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:-inset-y-3`}
          >
            <FolderIcon size={14} className={META_ICON} />
            {category.name}
          </Link>
        )}

        {readingMinutes !== null && (
          // Not wrapped in <time>: a reading estimate is a duration, and <time> needs
          // an ISO 8601 duration ("PT12M") in dateTime to be valid. Plain text is
          // honest; a <time dateTime="12 min"> is a lie a validator would catch.
          <span className={ITEM}>
            <ClockIcon size={14} className={META_ICON} />
            {t('readingTime', { minutes: readingMinutes })}
          </span>
        )}

        {trailing}
      </div>

      <TagList tags={tags} className="mt-3" />
    </div>
  )
}

/**
 * The tag row of a post: a leading Tag glyph then the chips. Shared by the post page
 * (through ReadingMeta) and the list row (ListRow), so the "link by slug" rule lives in
 * one place.
 *
 * The glyph sits OUTSIDE the tags `<ul>` (aria-label "Tags"): the list holds only tag items, so a screen
 * reader still reads the right tag count. `items-start` and `mt-[5px]` center the 14px glyph on the first
 * row of chips (chips are 24px tall) even when the chips wrap onto several lines.
 *
 * No tags means nothing renders: an empty block would still keep its margin.
 */
export function TagList({ tags, className }: { tags: Tag[]; className?: string }) {
  const t = useTranslations('Site.article')
  if (tags.length === 0) return null

  return (
    <div className={className ? `flex items-start gap-2 ${className}` : 'flex items-start gap-2'}>
      <TagIcon size={14} className={`mt-[11px] sm:mt-[5px] ${META_ICON}`} />
      <ul aria-label={t('tagsLabel')} className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <li key={tag.id}>
            {/*
              `tag.slug`, never `tag.name`. The two differ for any tag with
              diacritics, capitals or a space (a tag with diacritics and capitals becomes a lowercase ASCII slug), and the route
              matches on the slug — linking by name produces a 404 for exactly the
              Vietnamese tags this site is full of.

              The chip's classes sit on the <a>, not the <li>, so the painted shape
              and the clickable shape are the same shape. `inline-flex` and 36px tall below sm (a transparent `::after` of 4px above and below makes the hit area 44px; chip rows are 8px apart, so
              the areas touch and do not overlap), `inline-block` and 24px from sm, where a mouse is the pointer. px/py on a default-inline anchor does not lay out the same way.
            */}
            <Link
              href={`/tags/${encodeURIComponent(tag.slug)}`}
              className={`relative inline-flex min-h-9 items-center rounded-full bg-neutral-100 px-3 text-[0.8125rem] text-neutral-700 after:absolute after:inset-x-0 after:-inset-y-1 sm:inline-block sm:min-h-0 sm:py-1 sm:text-xs sm:after:hidden transition-colors duration-[120ms] hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none dark:bg-neutral-800 dark:text-neutral-300`}
            >
              {tag.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
