import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { Link } from '@/i18n/navigation'
import { ArchiveIcon, ChevronRightIcon, FolderIcon, LayersIcon, ListIcon, StarIcon } from '@/components/icons'
import { formatMonth } from '@/lib/date'
import { asLocale } from '@/lib/format'
import type { LeftRailModel, RailPost } from '@/lib/reader-rail'
import { FOCUS, FOCUS_INSET, FOCUS_RING, TRANSITION } from '../SectionHeading'
import { WRITING_SECTIONS } from '../writing-sections'
import { LEFT_SLOT, LEFT_STICKY } from './reader-layout'
import { RailTipHost } from './RailTipHost'
import {
  ACTIVE,
  EYEBROW,
  ExploreGroup,
  ICON,
  LINK,
  LIST,
  NUMBER,
  NUMBER_ACTIVE,
  ROW,
  SKIP_LINK,
  TEXT,
  type Section,
} from './rail-parts'

/** The header of a collapsible group: a row that is also the toggle. */
const SUMMARY = `${ROW} -mx-2 cursor-pointer list-none font-medium text-neutral-900 hover:bg-neutral-200/40 dark:text-neutral-100 dark:hover:bg-neutral-800/60 [&::-webkit-details-marker]:hidden ${FOCUS_RING} ${TRANSITION}`
const CHEVRON =
  'shrink-0 text-neutral-500 transition-transform motion-reduce:transition-none group-open:rotate-90 dark:text-neutral-400'

/**
 * The phone copy of the groups is a closed card opened with a thumb: its rows are 44px tall (`max-lg`, so the hidden desktop copy is
 * not affected). The titles are not cut to one line there: there is no tooltip on a touch screen, so a long title wraps to two lines.
 */
const TOUCH_ROW = 'max-lg:min-h-11'
const PHONE_TITLES = 'max-lg:[&_[data-tip-text]]:line-clamp-2 max-lg:[&_[data-tip-text]]:whitespace-normal'

const SERIES_ID = 'series-cua-bai'
const CATEGORY_ID = 'rail-category'
const LATEST_ID = 'rail-latest'

/** What the groups print, resolved once by `LeftRail` so the internal components stay synchronous. */
type Labels = {
  exploreTitle: string
  latestTitle: string
  categoryTitle: (name: string) => string
  seriesPartOf: (current: number, total: number) => string
  seriesOverview: string
  skipToBody: string
  currentPart: string
  viewAll: ReactNode
  archiveMonth: string | null
  sections: Section[]
  bestPosts: string
}

type Primary = NonNullable<LeftRailModel['primary']>

const postHref = (post: RailPost) => `/posts/${encodeURIComponent(post.slug)}`

/** The rows of a post list: no number, one line, the full title in `data-tip` for the tooltip host. */
function PostRows({ id, posts }: { id: string; posts: RailPost[] }) {
  return (
    <ul aria-labelledby={id} className={`mt-1 ${LIST}`}>
      {posts.map((post) => (
        <li key={post.id} className="min-w-0">
          <Link href={postHref(post)} locale={post.locale} className={`${LINK} ${TOUCH_ROW}`} data-tip={post.title}>
            <span className={TEXT} data-tip-text="">
              {post.title}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * The category name is plain text (the breadcrumb stays the one category link of the page). Collapsible on the desktop copy
 * (a `details`: open for the primary group, closed for the secondary one); on the phone copy, whose card is already the
 * toggle, an always-visible list under its eyebrow.
 */
function CategoryGroup({
  id,
  title,
  posts,
  open,
  collapsible,
}: {
  id: string
  title: string
  posts: RailPost[]
  open: boolean
  collapsible: boolean
}) {
  if (!collapsible) {
    return (
      <div className="min-w-0">
        <p id={id} className={EYEBROW}>
          <span className="min-w-0 break-words">{title}</span>
        </p>
        <PostRows id={id} posts={posts} />
      </div>
    )
  }
  return (
    <details open={open} className="group min-w-0">
      <summary id={id} className={SUMMARY} data-tip={title}>
        <span className={TEXT} data-tip-text="">
          {title}
        </span>
        <ChevronRightIcon size={14} className={CHEVRON} />
      </summary>
      <PostRows id={id} posts={posts} />
    </details>
  )
}

/** The latest posts: a plain list under its eyebrow, never collapsible. */
function LatestGroup({ id, title, posts }: { id: string; title: string; posts: RailPost[] }) {
  return (
    <div className="min-w-0">
      <p id={id} className={EYEBROW}>
        <span className="min-w-0 break-words">{title}</span>
      </p>
      <PostRows id={id} posts={posts} />
    </div>
  )
}

function SeriesGroup({
  primary,
  labels,
  suffix,
  collapsible,
}: {
  primary: Extract<Primary, { kind: 'series' }>
  labels: Labels
  suffix: string
  collapsible: boolean
}) {
  const titleId = `${SERIES_ID}${suffix}`
  const seriesHref = `/series/${encodeURIComponent(primary.slug)}`
  const { current, total, parts } = primary

  const body = (
    <>
      <Link href={seriesHref} className={`${LINK} ${TOUCH_ROW} -mx-2 mt-0.5`}>
        <span className={TEXT}>{labels.seriesOverview}</span>
      </Link>

      {/* <ol>: the order is the meaning of the list. The "…" row is aria-hidden, so a screen reader counts exactly the
          parts being shown, and the number on each row says which part was skipped. `role="list"` keeps the list
          semantics in Safari, which drops them from lists without markers. */}
      <ol role="list" className={`mt-0.5 ${LIST}`}>
        {primary.rows.map((row) => {
          if (row.kind === 'gap') {
            return (
              <li key={`gap-${row.after}`} aria-hidden="true" className="flex px-2 py-0.5">
                <span className={NUMBER}>…</span>
              </li>
            )
          }

          const part = parts[row.index]!

          if (row.index === current - 1) {
            return (
              <li key={part.id} aria-current="true" className="min-w-0">
                <span className={`${ACTIVE} ${TOUCH_ROW}`} data-tip={part.title}>
                  <span className={NUMBER_ACTIVE} data-part-number="">
                    {row.index + 1}
                  </span>{' '}
                  <span className={TEXT} data-tip-text="">
                    {part.title}
                  </span>
                  <span className="sr-only"> {labels.currentPart}</span>
                </span>
              </li>
            )
          }

          return (
            <li key={part.id} className="min-w-0">
              {/* The space between the number and the title is a separate text node, as in SeriesBlock: an accessible
                  name joining the text of child spans does not insert whitespace by itself. */}
              <Link href={postHref(part)} locale={part.locale} className={`${LINK} ${TOUCH_ROW}`} data-tip={part.title}>
                <span className={NUMBER} data-part-number="">
                  {row.index + 1}
                </span>{' '}
                <span className={TEXT} data-tip-text="">
                  {part.title}
                </span>
              </Link>
            </li>
          )
        })}
      </ol>

      {primary.windowed ? (
        <Link
          href={seriesHref}
          className={`mt-2 inline-flex max-w-full items-center text-sm font-medium text-brand hover:underline hover:underline-offset-4 max-lg:min-h-11 ${FOCUS} ${TRANSITION}`}
        >
          {labels.viewAll}
        </Link>
      ) : null}
    </>
  )

  return (
    <div className="min-w-0">
      {/* On the phone copy the card's own row already says "Series · Part 3/4" right above: said twice, one under the other, once it is open. */}
      <p className={collapsible ? EYEBROW : `${EYEBROW} hidden`}>
        <LayersIcon size={14} className="shrink-0" />
        <span className="min-w-0 break-words">{labels.seriesPartOf(current, total)}</span>
      </p>
      {/* The nav is OUTSIDE the details: a collapsed group keeps its landmark, and its name (the summary, which stays
          rendered when the details is closed) is still the series title. */}
      <nav aria-labelledby={titleId} className="mt-1 min-w-0">
        {collapsible ? (
          <details open className="group min-w-0">
            <summary id={titleId} className={SUMMARY} data-tip={primary.title}>
              <span className={TEXT} data-tip-text="">
                {primary.title}
              </span>
              <ChevronRightIcon size={14} className={CHEVRON} />
            </summary>
            {body}
          </details>
        ) : (
          <>
            <p
              id={titleId}
              className={`${ROW} -mx-2 font-medium text-neutral-900 dark:text-neutral-100`}
              data-tip={primary.title}
            >
              <span className={TEXT} data-tip-text="">
                {primary.title}
              </span>
            </p>
            {body}
          </>
        )}
      </nav>
    </div>
  )
}

/**
 * The groups, rendered twice by `LeftRail` (one copy per breakpoint): Explore, the series being read, the category (or the
 * latest posts), the archive month. `suffix` is appended to every id the groups create, so the ids of the two copies stay
 * unique: the desktop copy keeps the canonical `series-cua-bai`. `collapsible` is true on the desktop copy (details/summary
 * groups) and false inside the phone card, whose outer details is the only toggle there (no nested toggles).
 */
function LeftRailGroups({
  model,
  labels,
  suffix,
  collapsible,
}: {
  model: LeftRailModel
  labels: Labels
  suffix: string
  collapsible: boolean
}) {
  const { primary, secondary, month } = model
  const topics = labels.sections.find((section) => section.key === 'topics')?.label
  const hasCategory = primary?.kind === 'category' || secondary !== null
  // The phone card repeats nothing the header and the footer already offer: with a series, a category or the latest posts to show, its
  // Explore group (five links to sections of the site) is left out; the card of a post with none of them still holds it.
  const showExplore = collapsible || (primary === null && secondary === null)
  return (
    <div className="min-w-0 space-y-6">
      {/* None of the five carries aria-current: the post page is not one of these sections. */}
      {showExplore ? (
        <ExploreGroup
          title={labels.exploreTitle}
          links={[...labels.sections, { key: 'best', href: '/start-here', label: labels.bestPosts, Icon: StarIcon }]}
          suffix={suffix}
        />
      ) : null}
      {primary?.kind === 'series' ? (
        <SeriesGroup primary={primary} labels={labels} suffix={suffix} collapsible={collapsible} />
      ) : null}
      {primary?.kind === 'latest' ? (
        <LatestGroup id={`${LATEST_ID}${suffix}`} title={labels.latestTitle} posts={primary.posts} />
      ) : null}
      {hasCategory ? (
        <div className="min-w-0 space-y-1">
          {/* On the phone copy each group's own eyebrow is the category title, so this one would only repeat it. */}
          {collapsible && topics ? <p className={EYEBROW}>{topics}</p> : null}
          {primary?.kind === 'category' ? (
            <CategoryGroup
              id={`${CATEGORY_ID}${suffix}`}
              title={labels.categoryTitle(primary.name)}
              posts={primary.posts}
              open
              collapsible={collapsible}
            />
          ) : null}
          {secondary ? (
            <CategoryGroup
              id={`${CATEGORY_ID}-2${suffix}`}
              title={labels.categoryTitle(secondary.name)}
              posts={secondary.posts}
              open={false}
              collapsible={collapsible}
            />
          ) : null}
        </div>
      ) : null}
      {month && labels.archiveMonth ? (
        <Link href={month.href} className={`${LINK} ${TOUCH_ROW} -mx-2`}>
          <ArchiveIcon size={16} className={ICON} />
          <span className={`${TEXT} first-letter:uppercase`}>{labels.archiveMonth}</span>
        </Link>
      ) : null}
    </div>
  )
}

/**
 * The left sidebar of the post page: Explore (five icon links), the series being read as a collapsible numbered list (or
 * the category, or the latest posts), the archive month. Never an empty box: with a model of nulls it is the Explore group alone.
 *
 * The groups are in the HTML twice, as two CSS-switched copies: a closed card (`details[data-rail-phone]`, the only toggle
 * there) below `lg`, and a sticky scrolling column from `lg` whose series and category groups are native details. The hidden
 * copy is `display:none`, so it is out of the accessibility tree and the tab order. Each copy sits in a `RailTipHost`, the
 * tooltip island for truncated titles.
 *
 * The two skip links are the first siblings, OUTSIDE the aside: a skip link normally precedes every landmark. They are `fixed`
 * on focus, so they take no grid cell and cause no layout shift. No headings in the sidebar (the eyebrows are `<p>`).
 */
export async function LeftRail({ model }: { model: LeftRailModel }) {
  const [t, series, listing, footer, rawLocale] = await Promise.all([
    getTranslations('Site.reader'),
    getTranslations('Site.seriesBlock'),
    getTranslations('Site.listing'),
    getTranslations('Site.footer.links'),
    getLocale(),
  ])
  const locale = asLocale(rawLocale)

  const labels: Labels = {
    exploreTitle: t('exploreTitle'),
    latestTitle: t('latestTitle'),
    categoryTitle: (name) => t('categoryTitle', { category: name }),
    seriesPartOf: (current, total) => series('partOf', { current, total }),
    seriesOverview: t('seriesOverview'),
    skipToBody: t('skipToBody'),
    currentPart: series('currentPart'),
    viewAll: series.rich('viewAll', { arrow: (chunks) => <span aria-hidden="true">{chunks}</span> }),
    archiveMonth: model.month ? t('archiveMonth', { month: formatMonth(model.month.year, model.month.month, locale) }) : null,
    sections: WRITING_SECTIONS.map(({ key, href, labelKey, Icon }) => ({ key, href, label: listing(labelKey), Icon })),
    bestPosts: footer('startHere'),
  }

  const { primary } = model
  const SummaryIcon = primary?.kind === 'series' ? LayersIcon : primary?.kind === 'category' ? FolderIcon : ListIcon
  const summary =
    primary?.kind === 'series'
      ? labels.seriesPartOf(primary.current, primary.total)
      : primary?.kind === 'category'
        ? labels.categoryTitle(primary.name)
        : primary?.kind === 'latest'
          ? labels.latestTitle
          : labels.exploreTitle

  return (
    <>
      <a href="#post-article" className={SKIP_LINK}>
        {t('skipToArticle')}
      </a>
      <a href="#post-body" className={SKIP_LINK}>
        {labels.skipToBody}
      </a>
      <aside aria-label={t('leftLabel')} className={`${LEFT_SLOT} print:hidden`}>
        <details data-rail-phone="" className="group rounded-card border border-neutral-200 lg:hidden dark:border-neutral-800">
          {/* The whole row is the click area (>= 44px) and the focus ring is drawn inward because <summary> fills the
              bordered box. `flex` and `list-none` remove ::marker; Safari needs its marker hidden separately. */}
          <summary
            data-rail-phone=""
            className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-4 py-2 [&::-webkit-details-marker]:hidden ${FOCUS_INSET}`}
          >
            <span className={EYEBROW}>
              <SummaryIcon size={14} className="shrink-0" />
              <span className="min-w-0 truncate">{summary}</span>
            </span>
            <ChevronRightIcon
              size={14}
              className="shrink-0 rotate-90 text-neutral-500 group-open:-rotate-90 dark:text-neutral-400"
            />
          </summary>
          <div className={`min-w-0 px-4 pt-1 pb-4 ${PHONE_TITLES}`}>
            <RailTipHost>
              <LeftRailGroups model={model} labels={labels} suffix="-m" collapsible={false} />
            </RailTipHost>
          </div>
        </details>
        <div data-rail-sticky="" className={`hidden lg:block ${LEFT_STICKY}`}>
          <RailTipHost>
            <LeftRailGroups model={model} labels={labels} suffix="" collapsible />
          </RailTipHost>
        </div>
      </aside>
    </>
  )
}
