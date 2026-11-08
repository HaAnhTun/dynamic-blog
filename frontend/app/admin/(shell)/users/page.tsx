import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import AdminOnly from '@/components/admin/AdminOnly'
import { Pager } from '@/components/admin/Pager'
import { EmptyState, ErrorAlert, PageHeader } from '@/components/admin/primitives'
import { button, INPUT, PAGE } from '@/components/admin/ui'
import UserTable from '@/components/admin/UserTable'
import { SearchIcon, UsersIcon } from '@/components/icons'
import { adminErrorMessage } from '@/lib/admin-action'
import { SessionExpiredError, listAdminUsers } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { accessCookieName } from '@/lib/auth-cookies'
import { asLocale, lowerCase } from '@/lib/format'
import { subjectOf } from '@/lib/jwt'
import type { AdminUser, Page } from '@/lib/types'
import { changeUserRole, resetUserMfa, suspendUser, unsuspendUser } from './actions'
import {
  ROLE_FILTERS,
  USER_PAGE_SIZE,
  USER_STATUS_FILTERS,
  type UserListState,
  parsePage,
  parseQuery,
  parseRoleFilter,
  parseUserStatusFilter,
  roleOfFilter,
  statusOfUserFilter,
  userListHref,
} from './user-list'

/*
 * The Users page: minimal management — see who has an account, the
 * role, the status; suspend and unsuspend readers, change role (UserTable). No profile editing, no account
 * deletion (deferred).
 */

/**
 * The search box and two filters, sent by plain GET like the post list: a pasteable URL, Back returns to the previous
 * filtering, no JS needed. `key` is the list URL, so the `defaultValue` fields redraw with the new value when the URL changes
 * while the page's React tree is kept (Next keeps it when only searchParams change).
 */
function Toolbar({ state }: { state: UserListState }) {
  const t = useTranslations('Admin.users')
  const tStatuses = useTranslations('Admin.statuses')
  // `sm:w-auto`, not `w-auto`: INPUT carries `w-full`, and Tailwind 4 emits `.w-full` AFTER `.w-auto`, so
  // `w-auto` never wins (the same bug fixed in the post list, app/admin/(shell)/page.tsx). Below sm the select
  // fills the row, fitting phones.
  const select = `${INPUT} h-9 min-w-0 max-w-full py-0 pr-8 sm:w-auto`
  return (
    <form
      key={userListHref({ ...state, page: undefined })}
      role="search"
      action="/admin/users"
      method="get"
      className="flex flex-wrap items-center gap-2"
    >
      <div className="relative w-full sm:w-64">
        <label htmlFor="admin-user-search" className="sr-only">
          {t('searchLabel')}
        </label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500" />
        <input
          id="admin-user-search"
          type="search"
          name="q"
          defaultValue={state.query}
          placeholder={t('searchPlaceholder')}
          className={`${INPUT} h-9 pl-9`}
        />
      </div>
      <label htmlFor="admin-user-role" className="sr-only">
        {t('roleLabel')}
      </label>
      {/* "All…" is an empty value like the post list filters: sends `role=`, read back as "all". */}
      <select id="admin-user-role" name="role" defaultValue={state.role === 'all' ? '' : state.role} className={select}>
        {ROLE_FILTERS.map(({ key, labelKey }) => (
          <option key={key} value={key === 'all' ? '' : key}>
            {tStatuses(labelKey)}
          </option>
        ))}
      </select>
      <label htmlFor="admin-user-status" className="sr-only">
        {t('statusLabel')}
      </label>
      <select id="admin-user-status" name="status" defaultValue={state.status === 'all' ? '' : state.status} className={select}>
        {USER_STATUS_FILTERS.map(({ key, labelKey }) => (
          <option key={key} value={key === 'all' ? '' : key}>
            {tStatuses(labelKey)}
          </option>
        ))}
      </select>
      <button type="submit" className={button('secondary')}>
        {t('filter')}
      </button>
    </form>
  )
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const locale = asLocale(await getLocale())
  const t = await getTranslations('Admin.users')
  const tStatuses = await getTranslations('Admin.statuses')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />
  const params = await searchParams
  const state: UserListState = {
    query: parseQuery(params.q),
    role: parseRoleFilter(params.role),
    status: parseUserStatusFilter(params.status),
  }
  const requested = parsePage(params.page)

  let result: Page<AdminUser> | null = null
  let loadError: string | null = null
  try {
    result = await listAdminUsers({
      q: state.query,
      role: roleOfFilter(state.role),
      status: statusOfUserFilter(state.status),
      page: requested,
      size: USER_PAGE_SIZE,
    })
  } catch (error) {
    // Same way as the Comments page: session expired → login; 403 → no longer ADMIN; other 4xx → a local
    // message, the filter bar remains to change the request; server error or lost connection → the admin error.tsx ("Try again").
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    if (error instanceof ApiError && error.status < 500)
      loadError = adminErrorMessage(error, await getTranslations('Errors.admin'))
    else throw error
  }

  // `?page=` beyond the last page: go to the last page. Outside the try, because the catch above would swallow NEXT_REDIRECT.
  if (result !== null && result.items.length === 0 && result.meta.totalPages > 0 && requested >= result.meta.totalPages) {
    redirect(userListHref({ ...state, page: result.meta.totalPages - 1 }))
  }

  // Who is signed in, by the `sub` claim of the very token sent: that row has no button (UserTable).
  const token = (await cookies()).get(accessCookieName())?.value
  const selfId = token ? subjectOf(token) : null

  const narrowed = state.query !== '' || state.role !== 'all' || state.status !== 'all'
  const roleName = lowerCase(tStatuses(ROLE_FILTERS.find(({ key }) => key === state.role)!.labelKey), locale)
  const statusName = lowerCase(tStatuses(USER_STATUS_FILTERS.find(({ key }) => key === state.status)!.labelKey), locale)

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="shrink-0 text-sm font-medium text-slate-900">
          {/* A space between the two parts: the accessible name concatenates the children text. */}
          {narrowed ? t('results') : t('all')}{' '}
          {result !== null && (
            <span className="ml-1 font-normal text-slate-500">{t('count', { count: result.meta.totalElements })}</span>
          )}
        </h2>
        <Toolbar state={state} />
      </div>

      <div className="mt-3">
        {result === null ? (
          <ErrorAlert>{loadError}</ErrorAlert>
        ) : result.items.length === 0 ? (
          narrowed ? (
            <EmptyState
              icon={<SearchIcon size={20} />}
              title={t('empty.noMatch')}
              action={
                <Link href="/admin/users" className={button('secondary')}>
                  {t('empty.viewAll')}
                </Link>
              }
            >
              {state.query !== ''
                ? t('empty.queryHint', {
                    query: state.query,
                    withFilters: state.role !== 'all' || state.status !== 'all' ? 'yes' : 'no',
                  })
                : t('empty.filtersHint')}
            </EmptyState>
          ) : (
            <EmptyState icon={<UsersIcon size={20} />} title={t('empty.none')}>
              {t('empty.noneHint')}
            </EmptyState>
          )
        ) : (
          <UserTable
            // Changing the filter, search box or page is a different list: rebuild from scratch with the new data.
            key={userListHref({ ...state, page: result.meta.page })}
            users={result.items}
            caption={t('caption', {
              role: roleName,
              status: statusName,
              searched: state.query === '' ? 'no' : 'yes',
              query: state.query,
              page: result.meta.page + 1,
              totalPages: Math.max(1, result.meta.totalPages),
            })}
            selfId={selfId}
            statusFilter={statusOfUserFilter(state.status)}
            roleFilter={roleOfFilter(state.role)}
            onSuspend={suspendUser}
            onUnsuspend={unsuspendUser}
            onChangeRole={changeUserRole}
            onResetMfa={resetUserMfa}
          />
        )}
      </div>

      {result !== null && (
        <Pager
          page={result.meta.page}
          totalPages={result.meta.totalPages}
          total={result.meta.totalElements}
          pageSize={USER_PAGE_SIZE}
          unit="user"
          href={(page) => userListHref({ ...state, page })}
        />
      )}
    </div>
  )
}
