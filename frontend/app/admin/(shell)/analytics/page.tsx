import Link from 'next/link'
import { redirect } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import NoAccess from '@/components/admin/NoAccess'
import { EmptyState, ErrorAlert, PageHeader, StatusBadge } from '@/components/admin/primitives'
import { button, FOCUS_RING, H2, INPUT, LABEL, META, PAGE, TEXT_LINK } from '@/components/admin/ui'
import { TrendingUpIcon } from '@/components/icons'
import { adminErrorMessage } from '@/lib/admin-action'
import { SessionExpiredError, getAnalytics } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { Locale } from '@/i18n/config'
import { formatDate } from '@/lib/date'
import { asLocale, numberFormat } from '@/lib/format'
import type { Analytics, AnalyticsSource, AnalyticsTopPost } from '@/lib/types'
import { DailyChart } from './DailyChart'
import { type DateRange, MAX_RANGE_DAYS, parseDateRange } from './range'

/*
 * The Analytics page: views per day, the most read posts and traffic sources over a date range. The table is
 * the main part; the small SVG chart is only for a quick look.
 */

/* The page text by role is `Admin.analytics.copy.<role>`: AUTHOR's figures only cover their own posts (the backend filters in the SQL statement). */

/** The six fixed source groups, in display order (labels: `Admin.analytics.sources.<group>`). An unknown group (added by the backend later) shows verbatim, last. */
const SOURCE_ORDER = ['direct', 'search', 'social', 'github', 'internal', 'other']

const TH = 'py-2.5 text-[13px] font-medium text-slate-500'

function dayText(day: string, locale: Locale): string {
  return formatDate(day, 'medium', locale) ?? day
}

function Day({ day }: { day: string }) {
  const locale = asLocale(useLocale())
  return <time dateTime={day}>{dayText(day, locale)}</time>
}

/**
 * A GET form like the other admin filters: the result is a pasteable URL. `key` is the range being viewed: Next keeps the React tree when
 * only searchParams change (the "Last 30 days" link), and an already drawn `defaultValue` field keeps its old value.
 */
function RangeForm({ from, to, error, custom }: { from: string; to: string; error: DateRange['error']; custom: boolean }) {
  const t = useTranslations('Admin.analytics')
  const invalid = (field: 'from' | 'to') => (error?.fields.includes(field) ? true : undefined)
  const describedBy = error === null ? undefined : 'analytics-range-error'
  // `basis-32`: below sm the two fields share one row (fits at 320px) and the button wraps to the next row; without it, `flex-1` shrinks the two fields
  // to a few dozen px to make room for the button (measured on a 320px screenshot).
  const field = 'min-w-0 flex-1 basis-32 sm:flex-none'
  return (
    <form
      key={`${from}|${to}`}
      action="/admin/analytics"
      method="get"
      aria-label={t('range.label')}
      className="flex flex-wrap items-end gap-3"
    >
      <div className={field}>
        <label htmlFor="analytics-from" className={LABEL}>
          {t('range.from')}
        </label>
        <input
          id="analytics-from"
          type="date"
          name="from"
          defaultValue={from}
          aria-invalid={invalid('from')}
          aria-describedby={describedBy}
          className={`${INPUT} sm:w-44`}
        />
      </div>
      <div className={field}>
        <label htmlFor="analytics-to" className={LABEL}>
          {t('range.to')}
        </label>
        <input
          id="analytics-to"
          type="date"
          name="to"
          defaultValue={to}
          aria-invalid={invalid('to')}
          aria-describedby={describedBy}
          className={`${INPUT} sm:w-44`}
        />
      </div>
      <div className="flex items-center gap-4">
        <button type="submit" className={button('secondary')}>
          {t('range.submit')}
        </button>
        {custom && (
          <Link href="/admin/analytics" className={`${TEXT_LINK} text-sm`}>
            {t('range.last30')}
          </Link>
        )}
      </div>
      {error !== null && (
        <div id="analytics-range-error" className="w-full">
          <ErrorAlert>{t(error.message, { days: MAX_RANGE_DAYS })}</ErrorAlert>
        </div>
      )}
    </form>
  )
}

/** Two total cells. The label comes before the number in the DOM (reads "All time 1.234"); the big number sits on top thanks to flex-col-reverse. */
function Totals({ totals }: { totals: Analytics['totals'] }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.analytics.totals')
  const cell = 'flex flex-col-reverse justify-end gap-1 bg-white px-4 py-3.5 sm:px-5'
  const value = 'text-2xl font-semibold tracking-tight text-slate-900'
  return (
    <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200">
      <div className={cell}>
        <dt className="text-[13px] text-slate-600">{t('inRange')}</dt>
        <dd className={value}>{numberFormat(locale).format(totals.views)}</dd>
      </div>
      <div className={cell}>
        <dt className="text-[13px] text-slate-600">{t('allTime')}</dt>
        <dd className={value}>{numberFormat(locale).format(totals.allTimeViews)}</dd>
      </div>
    </dl>
  )
}

/** Every day of the range (up to 366 rows), so it scrolls in its own frame; the frame takes focus to scroll by keyboard. */
function DailyTable({ data }: { data: Analytics }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.analytics.daily')
  const head = `${TH} sticky top-0 bg-slate-50 px-4`
  return (
    <div
      role="region"
      aria-label={t('tableLabel')}
      tabIndex={0}
      className={`mt-4 max-h-80 overflow-auto rounded-lg border border-slate-200 ${FOCUS_RING}`}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t('caption', { from: dayText(data.from, locale), to: dayText(data.to, locale) })}</caption>
        <thead>
          <tr>
            <th scope="col" className={head}>
              {t('day')}
            </th>
            <th scope="col" className={`${head} text-right`}>
              {t('views')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.daily.map((row) => (
            <tr key={row.day}>
              <th scope="row" className="px-4 py-2 font-normal text-slate-700">
                <Day day={row.day} />
              </th>
              <td className="px-4 py-2 text-right tabular-nums text-slate-900">
                {/* Before `since` the backend returns 0, but that day was not measured yet: do not print a made-up 0. */}
                {data.since !== null && row.day < data.since ? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">{t('noData')}</span>
                  </>
                ) : (
                  numberFormat(locale).format(row.views)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TopPosts({ posts }: { posts: AnalyticsTopPost[] }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.analytics.top')
  if (posts.length === 0) return <p className={`mt-3 ${META}`}>{t('empty')}</p>
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead className="border-b border-slate-200">
          <tr>
            <th scope="col" className={`${TH} pr-4`}>
              {t('post')}
            </th>
            <th scope="col" className={`${TH} hidden w-28 pr-4 sm:table-cell`}>
              {t('status')}
            </th>
            <th scope="col" className={`${TH} w-20 text-right`}>
              {t('views')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {posts.map((post) => (
            <tr key={post.id} className="align-top">
              <td className="py-3 pr-4">
                <Link
                  href={`/admin/posts/${encodeURIComponent(post.id)}/edit`}
                  className={`rounded-sm font-medium text-slate-900 [overflow-wrap:anywhere] hover:underline hover:underline-offset-4 ${FOCUS_RING}`}
                >
                  {post.title}
                </Link>
                {/* The status column exists from sm; below that the status sits under the title. */}
                <div className="mt-1 sm:hidden">
                  <StatusBadge status={post.status} />
                </div>
              </td>
              <td className="hidden py-3 pr-4 sm:table-cell">
                <StatusBadge status={post.status} />
              </td>
              <td className="py-3 text-right tabular-nums text-slate-900">{numberFormat(locale).format(post.views)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Sources({ sources }: { sources: AnalyticsSource[] }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.analytics.sources')
  const total = sources.reduce((sum, row) => sum + row.views, 0)
  const rank = (source: string) => {
    const index = SOURCE_ORDER.indexOf(source)
    return index === -1 ? SOURCE_ORDER.length : index
  }
  const rows = [...sources].sort((a, b) => rank(a.source) - rank(b.source))
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead className="border-b border-slate-200">
          <tr>
            <th scope="col" className={`${TH} pr-4`}>
              {t('source')}
            </th>
            <th scope="col" className={`${TH} pr-4 text-right`}>
              {t('views')}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {t('share')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.source}>
              <th scope="row" className="py-2.5 pr-4 font-normal text-slate-700">
                {SOURCE_ORDER.includes(row.source) ? t(`group.${row.source}`) : row.source}
              </th>
              <td className="py-2.5 pr-4 text-right tabular-nums text-slate-900">{numberFormat(locale).format(row.views)}</td>
              <td className="py-2.5 text-right tabular-nums text-slate-600">
                {total === 0
                  ? '—'
                  : numberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(row.views / total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Report({ data }: { data: Analytics }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.analytics.report')
  const since = data.since
  return (
    <>
      <p className={`mt-6 ${META}`}>
        {t.rich('range', { from: () => <Day day={data.from} />, to: () => <Day day={data.to} />, timeZone: data.timeZone })}
      </p>
      <Totals totals={data.totals} />
      <p className={`mt-3 max-w-2xl ${META}`}>
        {t('note')} {since === null ? t('noDaily') : t.rich('dailySince', { day: () => <Day day={since} /> })}
      </p>

      {data.totals.views === 0 ? (
        <div className="mt-8">
          <EmptyState icon={<TrendingUpIcon size={20} />} title={t('emptyTitle')}>
            {since === null ? t('emptyNoDaily') : t('emptySince', { date: dayText(since, locale) })}
          </EmptyState>
        </div>
      ) : (
        <>
          <section aria-labelledby="analytics-daily" className="mt-10">
            <h2 id="analytics-daily" className={H2}>
              {t('byDay')}
            </h2>
            <DailyChart days={data.daily} since={data.since} />
            <DailyTable data={data} />
          </section>
          <div className="mt-10 grid gap-10 lg:grid-cols-5">
            <section aria-labelledby="analytics-top" className="min-w-0 lg:col-span-3">
              <h2 id="analytics-top" className={H2}>
                {t('topPosts')}
              </h2>
              <TopPosts posts={data.topPosts} />
            </section>
            <section aria-labelledby="analytics-sources" className="min-w-0 lg:col-span-2">
              <h2 id="analytics-sources" className={H2}>
                {t('sources')}
              </h2>
              <Sources sources={data.sources} />
            </section>
          </div>
        </>
      )}
    </>
  )
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('Admin.analytics')
  const params = await searchParams
  const role = (await adminRole()) === 'ADMIN' ? 'admin' : 'author'
  const copy = { title: t(`copy.${role}.title`), lead: t(`copy.${role}.lead`) }
  const range = parseDateRange(params.from, params.to)

  // Invalid date range: a local message next to the form, no backend call with garbage.
  let data: Analytics | null = null
  let loadError: string | null = null
  if (range.error === null) {
    try {
      data = await getAnalytics({ from: range.from || undefined, to: range.to || undefined })
    } catch (error) {
      // Like the Comments page: expired session goes to login; 403 is a token with an old role; other 4xx is a local message, the form
      // stays intact to change the date range; server error or lost connection is rethrown to error.tsx ("Try again").
      if (error instanceof SessionExpiredError) redirect('/admin/login')
      if (error instanceof ApiError && error.status === 403) return <NoAccess title={copy.title} reason="account" />
      if (error instanceof ApiError && error.status < 500)
        loadError = adminErrorMessage(error, await getTranslations('Errors.admin'))
      else throw error
    }
  }

  return (
    <div className={PAGE}>
      <PageHeader title={copy.title} description={copy.lead} />
      <RangeForm
        from={data?.from ?? range.from}
        to={data?.to ?? range.to}
        error={range.error}
        custom={range.from !== '' || range.to !== ''}
      />
      {loadError !== null && <ErrorAlert className="mt-6">{loadError}</ErrorAlert>}
      {data !== null && <Report data={data} />}
    </div>
  )
}
