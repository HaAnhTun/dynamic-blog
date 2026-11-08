import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import AdminOnly from '@/components/admin/AdminOnly'
import AuthorApplicationList from '@/components/admin/AuthorApplicationList'
import { Pager } from '@/components/admin/Pager'
import { EmptyState, ErrorAlert, PageHeader } from '@/components/admin/primitives'
import { AUTHOR_APPLICATION_STATUS } from '@/components/admin/statuses'
import { PAGE } from '@/components/admin/ui'
import { PenLineIcon } from '@/components/icons'
import { adminErrorMessage } from '@/lib/admin-action'
import { SessionExpiredError, listAuthorApplications } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { accessCookieName } from '@/lib/auth-cookies'
import { asLocale, lowerCase } from '@/lib/format'
import { subjectOf } from '@/lib/jwt'
import type { AdminAuthorApplication, AuthorApplicationStatus, Page } from '@/lib/types'
import { parsePage } from '../post-list'
import { approveApplication, rejectApplication } from './actions'

/*
 * The Author applications page: a reader asks for permission to write posts at /profile, the admin approves or rejects here.
 * Filtering by status (default "Pending", oldest first) and pagination are both done by the backend.
 */

/** Page size, the same number as the other admin lists. */
const PAGE_SIZE = 20

/** The value of `?status=`, lowercase like every admin filter; missing means "pending". */
type Filter = 'pending' | 'approved' | 'rejected'

const FILTERS: readonly { key: Filter; status: AuthorApplicationStatus }[] = [
  { key: 'pending', status: 'PENDING' },
  { key: 'approved', status: 'APPROVED' },
  { key: 'rejected', status: 'REJECTED' },
]

/* The empty list: that entry is empty, and why that is normal (`Admin.applications.empty.<filter>`). */

/** Unknown or missing means "pending": an old link does not become an empty list, the backend does not accept an unknown enum (400). */
function parseFilter(raw: string | string[] | undefined): Filter {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === 'approved' || value === 'rejected' ? value : 'pending'
}

/** URL of a list state, dropping every default parameter. */
function listHref(filter: Filter, page?: number): string {
  const params = new URLSearchParams()
  if (filter !== 'pending') params.set('status', filter)
  if (page !== undefined && page > 0) params.set('page', String(page))
  const search = params.toString()
  return search === '' ? '/admin/applications' : `/admin/applications?${search}`
}

/** Three tab-like entries (links, `aria-current` on the chosen one), like the Comments page. Changing the entry goes back to the first page. */
function StatusTabs({ current }: { current: Filter }) {
  const t = useTranslations('Admin.applications')
  const tStatuses = useTranslations('Admin.statuses')
  return (
    <nav aria-label={t('statusNav')} className="border-b border-slate-200">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {FILTERS.map(({ key, status }) => (
          <li key={key}>
            <Link
              href={listHref(key)}
              aria-current={current === key ? 'page' : undefined}
              className={`inline-flex h-10 items-center border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3 duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 outline-brand ${
                current === key
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
              }`}
            >
              {tStatuses(AUTHOR_APPLICATION_STATUS[status].labelKey)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const locale = asLocale(await getLocale())
  const t = await getTranslations('Admin.applications')
  const tStatuses = await getTranslations('Admin.statuses')
  // Before any backend call: AUTHOR (or a stray token) sees the "admin only" page, nothing else.
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />
  const params = await searchParams
  const filter = parseFilter(params.status)
  const { status } = FILTERS.find(({ key }) => key === filter)!
  const requested = parsePage(params.page)

  let result: Page<AdminAuthorApplication> | null = null
  let loadError: string | null = null
  try {
    result = await listAuthorApplications({ status, page: requested, size: PAGE_SIZE })
  } catch (error) {
    // Like the Users page: session expired → login; 403 → no longer ADMIN (the token carries an old role); other 4xx →
    // a local message; server error or lost connection → the admin error.tsx ("Try again").
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    if (error instanceof ApiError && error.status < 500)
      loadError = adminErrorMessage(error, await getTranslations('Errors.admin'))
    else throw error
  }

  // `?page=` beyond the last page: go to the last page. Outside the try, because the catch above would swallow NEXT_REDIRECT.
  if (result !== null && result.items.length === 0 && result.meta.totalPages > 0 && requested >= result.meta.totalPages) {
    redirect(listHref(filter, result.meta.totalPages - 1))
  }

  // Who is signed in, by the `sub` claim of the very token sent: their own application has no button.
  const token = (await cookies()).get(accessCookieName())?.value
  const selfId = token ? subjectOf(token) : null
  const label = tStatuses(AUTHOR_APPLICATION_STATUS[status].labelKey)

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} />

      <StatusTabs current={filter} />

      <h2 className="mt-6 text-sm font-medium text-slate-900">
        {/* A space between the two parts: the accessible name concatenates the children text. */}
        {label}{' '}
        {result !== null && (
          <span className="ml-1 font-normal text-slate-500">{t('count', { count: result.meta.totalElements })}</span>
        )}
      </h2>

      <div className="mt-3">
        {result === null ? (
          <ErrorAlert>{loadError}</ErrorAlert>
        ) : result.items.length === 0 ? (
          <EmptyState icon={<PenLineIcon size={20} />} title={t(`empty.${filter}.title`)}>
            {t(`empty.${filter}.hint`)}
          </EmptyState>
        ) : (
          <AuthorApplicationList
            // Changing the entry or page is a different list: rebuild from scratch with the new data.
            key={listHref(filter, result.meta.page)}
            applications={result.items}
            label={t('listLabel', {
              status: lowerCase(label, locale),
              page: result.meta.page + 1,
              totalPages: Math.max(1, result.meta.totalPages),
            })}
            status={status}
            selfId={selfId}
            onApprove={approveApplication}
            onReject={rejectApplication}
          />
        )}
      </div>

      {result !== null && (
        <Pager
          page={result.meta.page}
          totalPages={result.meta.totalPages}
          total={result.meta.totalElements}
          pageSize={PAGE_SIZE}
          unit="application"
          href={(page) => listHref(filter, page)}
        />
      )}
    </div>
  )
}
