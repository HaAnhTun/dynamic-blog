import Link from 'next/link'
import { redirect } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import AdminOnly from '@/components/admin/AdminOnly'
import { EmptyState, ErrorAlert, PageHeader } from '@/components/admin/primitives'
import { CARD, FOCUS_RING, H2, META, PAGE, SECTION_DESC, STATUS_TEXT } from '@/components/admin/ui'
import { MailIcon } from '@/components/icons'
import { adminErrorMessage } from '@/lib/admin-action'
import { SessionExpiredError, getHeldNewsletterIssues, getNewsletterStats } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/date'
import { asLocale, numberFormat } from '@/lib/format'
import type { HeldNewsletterIssue, NewsletterIssue, NewsletterStats } from '@/lib/types'
import { discardHeldIssue, releaseHeldIssue } from './actions'
import HeldNewsletterIssues from './HeldNewsletterIssues'

/*
 * Newsletter page, ADMIN only: the newsletters waiting for approval (a post an author published for the first time is not sent
 * until an administrator releases it), subscribers by status, the bounce-suppression row count, the latest sends by post, and
 * failures by code. Counts only: no page lists addresses.
 */

/** Status of one send (`Admin.newsletter.issueStatus.<code>`); a code not listed here is shown verbatim. */
const ISSUE_STATUSES: readonly string[] = ['PENDING', 'EXPANDED', 'HELD', 'DISCARDED']

/** Safe failure code the worker writes, never the provider's message (`Admin.newsletter.failureReason.<code>`); a code not listed here is shown verbatim. */
const FAILURE_REASONS: readonly string[] = [
  'CONNECTION_FAILED',
  'TIMEOUT',
  'AUTH_FAILED',
  'REJECTED',
  'INVALID_ADDRESS',
  'SUPPRESSED',
  'UNKNOWN',
]

/** The four delivery counters of a send; labels are `Admin.newsletter.delivery.<key>`. */
const DELIVERY_COUNTS = ['sent', 'retrying', 'dead', 'pending'] as const

const TH = 'py-2.5 text-[13px] font-medium text-slate-500'

/** How many held newsletters the backend lists (`GET /api/v1/admin/newsletter/held`): as many shown means there may be more. */
const HELD_LIST_LIMIT = 100

function Subscribers({ stats }: { stats: NewsletterStats }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.newsletter.subscribers')
  const items = [
    { key: 'confirmed', value: stats.subscribers.confirmed },
    { key: 'pending', value: stats.subscribers.pending },
    { key: 'suppressed', value: stats.suppressed },
  ] as const
  return (
    <dl className="mt-3 grid gap-3 sm:grid-cols-3">
      {items.map(({ key, value }) => (
        <div key={key} className={`${CARD} px-4 py-3`}>
          <dt className="text-[13px] font-medium text-slate-600">{t(`${key}.label`)}</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{numberFormat(locale).format(value)}</dd>
          <dd className={`mt-1 ${META}`}>{t(`${key}.hint`)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Issues({ issues }: { issues: NewsletterIssue[] }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.newsletter.issues')
  return (
    <table className="mt-3 w-full table-fixed border-collapse text-left text-sm">
      <caption className="sr-only">{t('caption')}</caption>
      <thead className="border-b border-slate-200">
        <tr>
          {/* Below md only the post column remains; date, status and the four numbers wrap to a second line under the title. */}
          <th scope="col" className={`${TH} pr-4`}>
            {t('post')}
          </th>
          <th scope="col" className={`${TH} hidden w-28 pr-4 md:table-cell`}>
            {t('created')}
          </th>
          <th scope="col" className={`${TH} hidden w-28 pr-4 md:table-cell`}>
            {t('status')}
          </th>
          {DELIVERY_COUNTS.map((key) => (
            <th key={key} scope="col" className={`${TH} hidden w-20 pl-2 text-right md:table-cell`}>
              {t(`delivery.${key}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {issues.map((issue) => {
          const created = formatDate(issue.createdAt, 'medium', locale)
          const status = ISSUE_STATUSES.includes(issue.status) ? t(`issueStatus.${issue.status}`) : issue.status
          return (
            <tr key={issue.postId} className="align-top">
              <td className="py-3 pr-4">
                <Link
                  href={`/admin/posts/${encodeURIComponent(issue.postId)}/edit`}
                  className={`rounded-sm font-medium text-slate-900 break-words hover:underline hover:underline-offset-4 ${FOCUS_RING}`}
                >
                  {issue.title}
                </Link>
                <p className={`mt-0.5 ${META} md:hidden`}>
                  {[created, status, ...DELIVERY_COUNTS.map((key) => t(`deliveryCount.${key}`, { count: issue[key] }))]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </td>
              <td className="hidden py-3 pr-4 text-slate-600 md:table-cell">
                {created !== null && <time dateTime={issue.createdAt}>{created}</time>}
              </td>
              <td className="hidden py-3 pr-4 text-slate-600 md:table-cell">{status}</td>
              {DELIVERY_COUNTS.map((key) => (
                <td key={key} className="hidden py-3 pl-2 text-right text-slate-700 tabular-nums md:table-cell">
                  {numberFormat(locale).format(issue[key])}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Failures({ failures }: { failures: NewsletterStats['failures'] }) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Admin.newsletter.failures')
  return (
    <table className="mt-3 w-full max-w-xl table-fixed border-collapse text-left text-sm">
      <caption className="sr-only">{t('caption')}</caption>
      <thead className="border-b border-slate-200">
        <tr>
          <th scope="col" className={`${TH} pr-4`}>
            {t('error')}
          </th>
          <th scope="col" className={`${TH} w-24 text-right`}>
            {t('emails')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {failures.map(({ reason, count }) => (
          <tr key={reason} className="align-top">
            <td className="py-2.5 pr-4">
              {FAILURE_REASONS.includes(reason) && <span className="block text-slate-900">{t(`reason.${reason}`)}</span>}
              <code className="font-mono text-[13px] break-all text-slate-500">{reason}</code>
            </td>
            <td className="py-2.5 text-right text-slate-700 tabular-nums">{numberFormat(locale).format(count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default async function AdminNewsletterPage() {
  const t = await getTranslations('Admin.newsletter')
  // Before any backend call: AUTHOR (or a stray token) sees the "admin only" page, nothing else.
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />

  let stats: NewsletterStats | null = null
  let held: HeldNewsletterIssue[] = []
  let loadError: string | null = null
  try {
    ;[stats, held] = await Promise.all([getNewsletterStats(), getHeldNewsletterIssues()])
  } catch (error) {
    // Like the Author applications page: session expired → login; 403 → no longer ADMIN; other 4xx → local message; anything else error.tsx.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    if (error instanceof ApiError && error.status < 500)
      loadError = adminErrorMessage(error, await getTranslations('Errors.admin'))
    else throw error
  }

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} />
      <p className={`-mt-4 mb-8 ${STATUS_TEXT}`}>
        {t.rich('transport', { code: (chunks) => <code className="font-mono text-[13px]">{chunks}</code> })}
      </p>

      {stats === null ? (
        <ErrorAlert>{loadError}</ErrorAlert>
      ) : (
        <>
          {held.length > 0 && (
            <section aria-labelledby="cho-duyet" className="mb-10">
              <h2 id="cho-duyet" className={H2}>
                {t('held.title')}
              </h2>
              <p className={SECTION_DESC}>{t('held.description')}</p>
              <HeldNewsletterIssues issues={held} onRelease={releaseHeldIssue} onDiscard={discardHeldIssue} />
              {held.length >= HELD_LIST_LIMIT && (
                <p className={`mt-3 ${STATUS_TEXT}`}>{t('held.more', { count: held.length })}</p>
              )}
            </section>
          )}

          <section aria-labelledby="nguoi-dang-ky">
            <h2 id="nguoi-dang-ky" className={H2}>
              {t('subscribers.title')}
            </h2>
            <Subscribers stats={stats} />
          </section>

          <section aria-labelledby="lan-gui" className="mt-10">
            <h2 id="lan-gui" className={H2}>
              {t('issues.title')}
            </h2>
            <p className={SECTION_DESC}>{t('issues.description')}</p>
            {stats.issues.length === 0 ? (
              <div className="mt-3">
                <EmptyState icon={<MailIcon size={20} />} title={t('issues.emptyTitle')}>
                  {t('issues.emptyBody')}
                </EmptyState>
              </div>
            ) : (
              <Issues issues={stats.issues} />
            )}
          </section>

          <section aria-labelledby="loi-gui" className="mt-10">
            <h2 id="loi-gui" className={H2}>
              {t('failures.title')}
            </h2>
            <p className={SECTION_DESC}>{t('failures.description')}</p>
            {stats.failures.length === 0 ? (
              <p className={`mt-3 ${STATUS_TEXT}`}>{t('failures.none')}</p>
            ) : (
              <Failures failures={stats.failures} />
            )}
          </section>
        </>
      )}
    </div>
  )
}
