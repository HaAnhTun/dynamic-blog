// frontend/app/admin/(shell)/page.tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import NoAccess from '@/components/admin/NoAccess'
import { Pager } from '@/components/admin/Pager'
import PostListActions, { RowCheckbox, SelectAllCheckbox, type ListPost } from '@/components/admin/PostListActions'
import PostRowActions from '@/components/admin/PostRowActions'
import { PostThumb } from '@/components/admin/PostThumb'
import { EmptyState, PageHeader, StatusBadge } from '@/components/admin/primitives'
import { button, FOCUS_RING, INPUT, META, PAGE } from '@/components/admin/ui'
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  ClockIcon,
  FolderIcon,
  LayersIcon,
  PenLineIcon,
  SearchIcon,
  StarIcon,
  UploadIcon,
  XIcon,
} from '@/components/icons'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { LOCALES, isLocale } from '@/i18n/config'
import { SessionExpiredError } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/date'
import { asLocale, lowerCase, numberFormat } from '@/lib/format'
import type { PostSummary } from '@/lib/types'
import { feature, unfeature } from './curated/actions'
import { DeletedNotice } from './DeletedNotice'
import { everyAdminPost } from './every-admin-post'
import {
  HEALTH_CHECKS,
  type HealthKey,
  type ListState,
  type Option,
  PAGE_SIZE,
  type PostCounts,
  type SortOrder,
  type StatusFilter,
  categoryOptions,
  countPosts,
  filterPosts,
  healthCheck,
  healthCounts,
  listHref,
  pageOf,
  parseHealth,
  parseLanguage,
  parsePage,
  parseQuery,
  parseSlug,
  parseSort,
  parseStatus,
  shownEditDate,
  sortPosts,
  tagOptions,
} from './post-list'
import { bulkSetPublished, deletePosts } from './posts/actions'

/*
 * The first page of the admin: the post list, doubling as the overview. The admin has no separate
 * Dashboard page and the /admin route stays "Posts". The overview consists of:
 * - four real numbers read from the post list itself; the first three are also status filters;
 * - a "Needs attention" line counting what a post should have but is missing, each item a filter.
 * No chart, no number without a source. Views per day, by source and the most-read posts are on the
 * Analytics page (/admin/analytics).
 */

/*
 * Text of the page lives in `Admin.dashboard`: `emptyHint.<filter>` is the sentence under the empty state of a filter (nothing
 * searched: why the entry is empty and what to do next); `filters.<filter>` is the label of each filter, used for the overview
 * cell, the table caption and the sentence "no posts in …" (there is no "archived" filter: the only way into that status is an
 * author deleting their own post, which hides it, and only an ADMIN's list shows it, under "All", see post-list.ts);
 * `copy.<role>` is the page text by role (an AUTHOR's list only has their own posts, and not the ones they deleted: the backend
 * filters).
 */
type Role = 'admin' | 'author'

type HealthCheck = (typeof HEALTH_CHECKS)[number]

/** "Best posts" is ADMIN work: AUTHOR has no "Needs attention" item about it. */
const AUTHOR_CHECKS: readonly HealthCheck[] = HEALTH_CHECKS.filter((check) => check.key !== 'featured-unpublished')

/** The part of a row its actions need (PostListActions, PostRowActions): the whole summary is not sent. */
function listPost(post: PostSummary): ListPost {
  return { id: post.id, title: post.title, status: post.status, featured: post.featured }
}

/** The one value of `?deleted=` the delete action sets (`removePost`). Anything else is not a notice: the URL proves nothing. */
const DELETED_FLAG = '1'

function PublishedDate({ post }: { post: PostSummary }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.dashboard')
  if (post.publishedAt === null) return <span className="text-slate-500">{t('notPublished')}</span>
  // Explicit timeZone, the rule lib/date.ts states for every date on the site: without it
  // the rendered date depends on the server's zone, and the test that guards it cannot
  // fail on a UTC host.
  return <time dateTime={post.publishedAt}>{formatDate(post.publishedAt, 'medium', locale)}</time>
}

/**
 * The four overview cells. The first three are filter links (aria-current on the chosen cell, a bold line at the bottom like a
 * tab); "Views" is a number, not clickable, so no hover. In the DOM the label comes before the number so the accessible
 * name reads "Draft 2"; on screen the big number sits on top thanks to flex-col-reverse.
 *
 * The dividers are the 1px gap of the grid over a slate-200 background (`gap-px`), so it is right both when the grid is 2×2 on
 * phones and 1×4 from sm, with no border to compute per cell.
 *
 * Changing status keeps every other filter (search box, category, tag, sort, "Needs attention"), back to the first page.
 * So the number in each cell counts over exactly those filters (passed in by the page): the number is the number of posts the link opens,
 * not the total of the whole blog while the list is narrowed. With no filtering the two are the same.
 */
function Overview({ counts, state }: { counts: PostCounts; state: ListState }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.dashboard')
  const filters: { key: StatusFilter; value: number }[] = [
    { key: 'all', value: counts.all },
    { key: 'published', value: counts.published },
    { key: 'draft', value: counts.draft },
  ]
  const cell = 'relative flex flex-col-reverse gap-1 px-4 py-3.5 sm:px-5'
  const number = 'text-2xl font-semibold tabular-nums tracking-tight text-slate-900'
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4">
      {filters.map(({ key, value }) => {
        const current = state.status === key
        return (
          <Link
            key={key}
            href={listHref({ ...state, status: key, page: undefined })}
            aria-current={current ? 'page' : undefined}
            className={`${cell} transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 outline-brand ${
              current
                ? 'bg-slate-50 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-slate-900'
                : 'bg-white hover:bg-slate-50'
            }`}
          >
            <span className={`text-[13px] ${current ? 'font-medium text-slate-900' : 'text-slate-600'}`}>
              {t(`filters.${key}`)}
            </span>
            {/* A space between the two elements: the accessible name concatenates the children text without adding
                            a space, so without it it is "Draft2". In flex it takes no room. */}{' '}
            <span className={number}>{numberFormat(locale).format(value)}</span>
          </Link>
        )
      })}
      <p className={`${cell} bg-white`}>
        <span className="text-[13px] text-slate-600">{t('views')}</span>{' '}
        <span className={number}>{numberFormat(locale).format(counts.views)}</span>
      </p>
    </div>
  )
}

/**
 * "Needs attention": one line, each item with a post count is a filter link (?health=…), over every status. The link
 * keeps the search box, category and tag, so the count is over exactly those filters (passed in by the page), like the
 * status cells. With no item nothing is drawn: an "everything is fine" block is only noise on the most opened
 * screen of the admin.
 */
function Attention({
  counts,
  state,
  checks,
}: {
  counts: Record<HealthKey, number>
  state: ListState
  checks: readonly HealthCheck[]
}) {
  const t = useTranslations('Admin.dashboard')
  const issues = checks.filter((check) => counts[check.key] > 0)
  if (issues.length === 0) return null
  return (
    <section aria-labelledby="can-chu-y" className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1.5 text-[13px] leading-5">
      <h2 id="can-chu-y" className="inline-flex items-center gap-1.5 font-medium text-amber-800">
        <CircleAlertIcon size={14} className="self-center" />
        {t('attention.title')}
      </h2>
      <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
        {issues.map((check, index) => {
          const current = state.health === check.key
          return (
            <li key={check.key} className="text-slate-600">
              <Link
                href={listHref({ ...state, status: 'all', health: current ? null : check.key, page: undefined })}
                aria-current={current ? 'page' : undefined}
                title={t(`health.${check.key}.hint`)}
                className={`rounded-sm underline decoration-slate-300 underline-offset-4 transition-colors duration-150 motion-reduce:transition-none hover:text-slate-900 hover:decoration-slate-900 ${FOCUS_RING} ${
                  current ? 'font-medium text-slate-900 decoration-slate-900' : ''
                }`}
              >
                {t(`health.${check.key}.item`, { count: counts[check.key] })}
              </Link>
              {index < issues.length - 1 && <span aria-hidden="true"> ·</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The search box and three filters, sent by plain GET: the result is a pasteable URL, Back returns to the previous
 * filtering, no JS needed. The status and the "Needs attention" filter go along in hidden fields, so searching while filtering
 * does not lose the filter.
 *
 * `key` is the filter URL: changing the query by <Link> ("clear filter" chip, status cell, "Clear all filters")
 * does not rebuild the page — Next keeps the React tree of the page when only searchParams change — and an already drawn
 * `defaultValue` field keeps its old value. Without the key, a filter just removed would stay in the select and come back
 * on the next "Filter".
 */
function Toolbar({ state, categories, tags }: { state: ListState; categories: Option[]; tags: Option[] }) {
  const t = useTranslations('Admin.dashboard.toolbar')
  // `sm:w-auto`, not `w-auto`: INPUT carries `w-full`, and Tailwind 4 emits `.w-full` AFTER `.w-auto`, so
  // `w-auto` never wins (measured: the three selects spread over the full width, stacked even at 1280px). The `sm:`
  // variant comes after every base class. Below sm the select fills the row as before, fitting phones.
  const select = `${INPUT} h-9 min-w-0 max-w-full py-0 pr-8 sm:w-auto`
  return (
    <form
      key={listHref({ ...state, page: undefined })}
      role="search"
      action="/admin"
      method="get"
      className="flex flex-wrap items-center gap-2"
    >
      {state.status !== 'all' && <input type="hidden" name="status" value={state.status} />}
      {state.health !== null && <input type="hidden" name="health" value={state.health} />}
      <div className="relative w-full sm:w-64">
        <label htmlFor="admin-post-search" className="sr-only">
          {t('searchLabel')}
        </label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500" />
        <input
          id="admin-post-search"
          type="search"
          name="q"
          defaultValue={state.query}
          placeholder={t('searchPlaceholder')}
          className={`${INPUT} h-9 pl-9`}
        />
      </div>
      <label htmlFor="admin-post-category" className="sr-only">
        {t('category')}
      </label>
      <select id="admin-post-category" name="cat" defaultValue={state.category} className={select}>
        <option value="">{t('anyCategory')}</option>
        {categories.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
          </option>
        ))}
      </select>
      <label htmlFor="admin-post-tag" className="sr-only">
        {t('tag')}
      </label>
      <select id="admin-post-tag" name="tag" defaultValue={state.tag} className={select}>
        <option value="">{t('anyTag')}</option>
        {tags.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
          </option>
        ))}
      </select>
      <label htmlFor="admin-post-language" className="sr-only">
        {t('language')}
      </label>
      <select id="admin-post-language" name="lang" defaultValue={state.language ?? ''} className={select}>
        <option value="">{t('anyLanguage')}</option>
        {LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LANGUAGE_NAMES[locale]}
          </option>
        ))}
      </select>
      <label htmlFor="admin-post-sort" className="sr-only">
        {t('sort')}
      </label>
      <select id="admin-post-sort" name="sort" defaultValue={state.sort} className={select}>
        <option value="newest">{t('sortNewest')}</option>
        <option value="updated">{t('sortUpdated')}</option>
        <option value="views">{t('sortViews')}</option>
      </select>
      <button type="submit" className={button('secondary')}>
        {t('filter')}
      </button>
    </form>
  )
}

/** The secondary filters that are on, each removable on its own; and one "Clear all filters" way out. */
function ActiveFilters({ state, categories, tags }: { state: ListState; categories: Option[]; tags: Option[] }) {
  const t = useTranslations('Admin.dashboard.activeFilters')
  const tHealth = useTranslations('Admin.dashboard')
  const chips: { key: string; label: string; href: string }[] = []
  const reset = { ...state, page: undefined }
  if (state.query !== '')
    chips.push({ key: 'q', label: t('query', { query: state.query }), href: listHref({ ...reset, query: '' }) })
  if (state.category !== '') {
    const name = categories.find((option) => option.slug === state.category)?.name ?? state.category
    chips.push({ key: 'cat', label: t('category', { name }), href: listHref({ ...reset, category: '' }) })
  }
  if (state.tag !== '') {
    const name = tags.find((option) => option.slug === state.tag)?.name ?? state.tag
    chips.push({ key: 'tag', label: t('tag', { name }), href: listHref({ ...reset, tag: '' }) })
  }
  if (state.language !== undefined && state.language !== '') {
    chips.push({
      key: 'lang',
      label: t('language', { name: LANGUAGE_NAMES[state.language] }),
      href: listHref({ ...reset, language: '' }),
    })
  }
  if (state.health !== null) {
    chips.push({
      key: 'health',
      label: tHealth(`health.${healthCheck(state.health).key}.label`),
      href: listHref({ ...reset, health: null }),
    })
  }
  if (chips.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-slate-500">{t('label')}</span>
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          className={`inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white py-0.5 pr-1.5 pl-2.5 text-slate-700 transition-colors duration-150 motion-reduce:transition-none hover:border-slate-400 hover:bg-slate-50 ${FOCUS_RING}`}
        >
          {chip.label}
          <XIcon size={14} className="text-slate-500" />
          <span className="sr-only">{t('remove')}</span>
        </Link>
      ))}
      {chips.length > 1 && (
        <Link
          href={listHref({ status: state.status, query: '' })}
          className={`rounded-sm text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 ${FOCUS_RING}`}
        >
          {t('clearAll')}
        </Link>
      )}
    </div>
  )
}

/**
 * The secondary line of a post: what helps recognise and decide, in order of importance. No tags:
 * measured on a screenshot, adding tags makes each row three or four lines of secondary text (phone) — a wall of information
 * for something only needed in the editor. The post's tags are in the settings column there, and filtering by tag is in the top bar.
 *
 * "edited <date>" only when it says something more (post-list.ts, `shownEditDate`): a draft, a post
 * edited on a day after the publish day, or when sorted by "Recently edited".
 */
function PostMeta({ post, sort }: { post: PostSummary; sort: SortOrder }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.dashboard.meta')
  const item = 'inline-flex items-center gap-1.5'
  const series = post.series ?? null
  const edited = shownEditDate(post, sort, locale)
  return (
    <p className={`${META} mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1`}>
      {/* These two items have their own column from sm/md; below that they sit here so phones lose nothing. */}
      <StatusBadge status={post.status} className="sm:hidden" />
      <span className={`${item} md:hidden`}>
        <PublishedDate post={post} />
      </span>
      {edited !== null && (
        <span className={item}>
          <PenLineIcon size={14} className="text-slate-400" />
          {/* The word and <time> in one span: textContent reads "edited 2 Oct 2026" together. */}
          <span>
            {t.rich('edited', {
              date: formatDate(edited, 'medium', locale) ?? '',
              time: (chunks) => <time dateTime={edited}>{chunks}</time>,
            })}
          </span>
        </span>
      )}
      {post.language !== undefined && (
        <span className={item} lang={isLocale(post.language) ? post.language : undefined}>
          {isLocale(post.language) ? LANGUAGE_NAMES[post.language] : post.language}
        </span>
      )}
      {post.category !== null && (
        <span className={item}>
          <FolderIcon size={14} className="text-slate-400" />
          {post.category.name}
        </span>
      )}
      {series !== null && (
        <span className={item}>
          <LayersIcon size={14} className="text-slate-400" />
          {t('seriesPart', { title: series.title, position: series.position })}
        </span>
      )}
      {post.featured && (
        <span className={`${item} text-slate-700`}>
          <StarIcon size={14} className="text-amber-600" />
          {typeof post.featuredRank === 'number' ? t('featuredRanked', { rank: post.featuredRank }) : t('featured')}
        </span>
      )}
      <span className={item}>
        <ClockIcon size={14} className="text-slate-400" />
        {t('readingMinutes', { minutes: post.readingMinutes })}
      </span>
      {post.status === 'PUBLISHED' && (
        <a
          href={`/posts/${encodeURIComponent(post.slug)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`${item} rounded-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline ${FOCUS_RING}`}
        >
          {/* A space OUTSIDE the span: the accessible name trims leading/trailing whitespace of each child element. */}
          {t('view')} <span className="sr-only">{t('viewSr', { title: post.title })}</span>
          <ArrowUpRightIcon size={14} />
        </a>
      )}
    </p>
  )
}

/**
 * The table of the page being viewed, drawn on the server. The client island is only in the cells that need state: the select
 * at the start of each row and at the top of the table, the action buttons under each post's secondary line — they meet through
 * PostListActions wrapping the table.
 */
function PostsTable({ posts, caption, sort }: { posts: PostSummary[]; caption: string; sort: SortOrder }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.dashboard.table')
  const th = 'py-2.5 text-[13px] font-medium text-slate-500'
  return (
    <table className="w-full table-fixed border-collapse text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="border-b border-slate-200">
        <tr>
          {/* Select column: the column head is the "select the whole page" box, so the name of the column is the name of that box. */}
          <th scope="col" className={`${th} w-9`}>
            <SelectAllCheckbox />
          </th>
          <th scope="col" className={`${th} pr-4`}>
            {t('post')}
          </th>
          <th scope="col" className={`${th} hidden w-32 pr-4 sm:table-cell`}>
            {t('status')}
          </th>
          <th scope="col" className={`${th} hidden w-36 pr-4 md:table-cell`}>
            {t('publishedOn')}
          </th>
          <th scope="col" className={`${th} hidden w-24 text-right lg:table-cell`}>
            {t('views')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {posts.map((post) => (
          <tr
            key={post.id}
            className="align-top transition-colors duration-150 motion-reduce:transition-none hover:bg-slate-50/70"
          >
            {/* py-3 + a 32px cell: the centre of the select box lines up with the centre of the title's first line (py-4 + a 24px line). */}
            <td className="py-3">
              <RowCheckbox id={post.id} title={post.title} />
            </td>
            <td className="py-4 pr-4">
              <div className="flex items-start gap-4">
                <PostThumb post={post} className="mt-0.5 hidden w-[4.5rem] shrink-0 sm:block" />
                <div className="min-w-0">
                  {/* The title is the post edit link, like Ghost's post list: click the very thing you are looking for. */}
                  <Link
                    href={`/admin/posts/${post.id}/edit`}
                    className={`rounded-sm text-[15px] font-semibold leading-6 text-slate-900 break-words hover:underline hover:underline-offset-4 ${FOCUS_RING}`}
                  >
                    {post.title}
                  </Link>
                  <PostMeta post={post} sort={sort} />
                  <PostRowActions post={listPost(post)} />
                </div>
              </div>
            </td>
            <td className="hidden py-4 pr-4 sm:table-cell">
              <StatusBadge status={post.status} />
            </td>
            <td className="hidden py-4 pr-4 text-slate-600 md:table-cell">
              <PublishedDate post={post} />
            </td>
            <td className="hidden py-4 text-right tabular-nums text-slate-600 lg:table-cell">
              {post.status === 'PUBLISHED' ? (
                numberFormat(locale).format(post.viewCount ?? 0)
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default async function AdminPostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const locale = asLocale(await getLocale())
  const t = await getTranslations('Admin.dashboard')
  const tImport = await getTranslations('Admin.posts.import')
  const params = await searchParams
  // Only chooses the UI: the backend filters the list and rejects every AUTHOR action on another person's post.
  const admin = (await adminRole()) === 'ADMIN'
  const role: Role = admin ? 'admin' : 'author'
  const copy = { title: t(`copy.${role}.title`), lead: t(`copy.${role}.lead`), empty: t(`copy.${role}.empty`) }
  const checks: readonly HealthCheck[] = admin ? HEALTH_CHECKS : AUTHOR_CHECKS
  const health = parseHealth(params.health)
  const state: ListState = {
    status: parseStatus(params.status),
    query: parseQuery(params.q),
    category: parseSlug(params.cat),
    tag: parseSlug(params.tag),
    sort: parseSort(params.sort),
    language: parseLanguage(params.lang),
    health: checks.some((check) => check.key === health) ? health : null,
  }
  const deleted = (Array.isArray(params.deleted) ? params.deleted[0] : params.deleted) === DELETED_FLAG

  let posts: PostSummary[]
  try {
    // Every post, every status: the counters and filters need the whole list (see post-list.ts).
    posts = await everyAdminPost()
  } catch (error) {
    // The gap the spec accepts: middleware checked the token, then it expired before
    // this call. A Server Component cannot set a cookie, so the only recovery is to
    // send the author back through login.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    // The token still carries an old role (demoted to reader, locked): say why, not the "Try again" of error.tsx.
    if (error instanceof ApiError && error.status === 403) return <NoAccess title={copy.title} reason="account" />
    throw error
  }

  const newPost = (
    <Link href="/admin/posts/new" className={button('primary')}>
      <PenLineIcon />
      {t('newPost')}
    </Link>
  )

  // Importing files is a different job from writing: a secondary button (the header of the list, below "Write a post" when empty).
  const importLink = (label: string) => (
    <Link href="/admin/posts/import" className={button('secondary')}>
      <UploadIcon />
      {label}
    </Link>
  )

  if (posts.length === 0) {
    return (
      <div className={PAGE}>
        <PageHeader title={copy.title} description={copy.empty} />
        {deleted && <DeletedNotice />}
        {/* Exactly one invitation to write on the screen: a button at the top of the page would be a second copy of the same job. */}
        <EmptyState
          icon={<PenLineIcon size={20} />}
          title={t('noPosts.title')}
          action={
            <div className="flex flex-col items-center gap-3">
              <Link href="/admin/posts/new" className={button('primary')}>
                <PenLineIcon />
                {t('noPosts.action')}
              </Link>
              {importLink(tImport('entry.empty'))}
            </div>
          }
        >
          {t('noPosts.body')}
        </EmptyState>
      </div>
    )
  }

  // Each number is the number of posts its link opens: a status cell counts over every filter except the status,
  // "Needs attention" counts over the search box, category and tag (its link resets the status and replaces "health").
  // With no filtering it is the total of the whole blog.
  const counts = countPosts(filterPosts(posts, { ...state, status: 'all' }, locale))
  const healthCount = healthCounts(filterPosts(posts, { ...state, status: 'all', health: null }, locale))
  const categories = categoryOptions(posts, locale)
  const tags = tagOptions(posts, locale)
  const filtered = sortPosts(filterPosts(posts, state, locale), state.sort)
  const requestedPage = parsePage(params.page)
  const current = pageOf(filtered, requestedPage)
  const filterLabel = t(`filters.${state.status}`)
  const filterName = lowerCase(filterLabel, locale)
  const narrowed =
    state.query !== '' || state.category !== '' || state.tag !== '' || (state.language ?? '') !== '' || state.health !== null

  return (
    <div className={PAGE}>
      <PageHeader
        title={copy.title}
        description={copy.lead}
        actions={
          <>
            {importLink(tImport('entry.header'))}
            {newPost}
          </>
        }
      />
      {deleted && <DeletedNotice />}

      <Overview counts={counts} state={state} />
      <Attention counts={healthCount} state={state} checks={checks} />

      <div className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="shrink-0 text-sm font-medium text-slate-900">
          {/* A space between the two parts: the accessible name concatenates the children text, without it it is "Filter results12 posts". */}
          {narrowed ? t('results') : filterLabel}{' '}
          <span className="ml-1 font-normal text-slate-500">{t('postCount', { count: filtered.length })}</span>
        </h2>
        <Toolbar state={state} categories={categories} tags={tags} />
      </div>
      <ActiveFilters state={state} categories={categories} tags={tags} />

      <div className="mt-3">
        {/*
          Selection, bulk action bar and notice line of the list. Wraps the empty state too:
                    after deleting every post of the page the sentence "Deleted 3 posts." is still there. `key` is the requested URL (the page
                    in the URL, not the clamped page): changing the filter or page is a different list, the selection does not
                    follow; after an action the page redraws at the SAME URL, so the selection and the notice stay.
        */}
        <PostListActions
          key={listHref({ ...state, page: requestedPage })}
          posts={current.items.map(listPost)}
          author={!admin}
          onSetPublished={bulkSetPublished}
          onDelete={deletePosts}
          onFeature={admin ? feature : undefined}
          onUnfeature={admin ? unfeature : undefined}
        >
          {filtered.length === 0 ? (
            // Two different situations, two different sentences: filtering by status only and getting empty means nothing
            // "does not match", that entry is just empty.
            <EmptyState
              icon={<SearchIcon size={20} />}
              title={narrowed ? t('empty.noMatch') : t('empty.noneIn', { filter: filterLabel })}
              action={
                <Link href="/admin" className={button('secondary')}>
                  {t('empty.viewAll')}
                </Link>
              }
            >
              {!narrowed
                ? t(`emptyHint.${state.status}`)
                : state.query !== ''
                  ? t('empty.queryHint', {
                      status: state.status,
                      filter: filterName,
                      query: state.query,
                      withFilters:
                        state.category !== '' || state.tag !== '' || (state.language ?? '') !== '' || state.health !== null
                          ? 'yes'
                          : 'no',
                    })
                  : t('empty.filtersHint')}
            </EmptyState>
          ) : (
            <PostsTable
              posts={current.items}
              sort={state.sort}
              caption={t('table.caption', {
                filter: filterName,
                searched: state.query === '' ? 'no' : 'yes',
                query: state.query,
                sort: state.sort,
                page: current.page + 1,
                totalPages: current.totalPages,
              })}
            />
          )}
        </PostListActions>
      </div>

      <Pager
        page={current.page}
        totalPages={current.totalPages}
        total={filtered.length}
        pageSize={PAGE_SIZE}
        unit="post"
        href={(page) => listHref({ ...state, page })}
      />
    </div>
  )
}
