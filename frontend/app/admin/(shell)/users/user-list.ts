import { USER_ROLE, USER_STATUS } from '@/components/admin/statuses'
import type { UserRole, UserStatus } from '@/lib/types'

/*
 * Reading and building the URL of the Users page: filter by role and status, search by name or
 * login, paginate, all done by the backend (`GET /api/v1/admin/users?q&role&status&page&size`).
 * Same mould as comments/comment-list.ts; the page reader and the search box are shared with the post list.
 */
export { parsePage, parseQuery } from '../post-list'

export const USER_PAGE_SIZE = 20

export type RoleFilter = 'all' | 'user' | 'author' | 'admin'
export type UserStatusFilter = 'all' | 'active' | 'suspended'

const ROLE_OF: Record<Exclude<RoleFilter, 'all'>, UserRole> = { user: 'USER', author: 'AUTHOR', admin: 'ADMIN' }
const STATUS_OF: Record<Exclude<UserStatusFilter, 'all'>, UserStatus> = { active: 'ACTIVE', suspended: 'SUSPENDED' }

/** Filter choices; `labelKey` is a key of `Admin.statuses`, taken from statuses.ts so the filter and the table column say the same word. */
export const ROLE_FILTERS: readonly { key: RoleFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'filter.anyRole' },
  { key: 'user', labelKey: USER_ROLE.USER },
  { key: 'author', labelKey: USER_ROLE.AUTHOR },
  { key: 'admin', labelKey: USER_ROLE.ADMIN },
]

export const USER_STATUS_FILTERS: readonly { key: UserStatusFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'filter.anyStatus' },
  { key: 'active', labelKey: USER_STATUS.ACTIVE.labelKey },
  { key: 'suspended', labelKey: USER_STATUS.SUSPENDED.labelKey },
]

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

/** Lowercase value like every admin filter; unknown or missing means "any…" (the backend returns 400 for an unknown enum). */
export function parseRoleFilter(raw: string | string[] | undefined): RoleFilter {
  const value = first(raw)
  return value === 'user' || value === 'author' || value === 'admin' ? value : 'all'
}

export function parseUserStatusFilter(raw: string | string[] | undefined): UserStatusFilter {
  const value = first(raw)
  return value === 'active' || value === 'suspended' ? value : 'all'
}

export function roleOfFilter(filter: RoleFilter): UserRole | null {
  return filter === 'all' ? null : ROLE_OF[filter]
}

export function statusOfUserFilter(filter: UserStatusFilter): UserStatus | null {
  return filter === 'all' ? null : STATUS_OF[filter]
}

export type UserListState = {
  query: string
  role: RoleFilter
  status: UserStatusFilter
  page?: number
}

/** URL of a list state, dropping every default parameter. */
export function userListHref({ query, role, status, page }: UserListState): string {
  const params = new URLSearchParams()
  if (query !== '') params.set('q', query)
  if (role !== 'all') params.set('role', role)
  if (status !== 'all') params.set('status', status)
  if (page !== undefined && page > 0) params.set('page', String(page))
  const search = params.toString()
  return search === '' ? '/admin/users' : `/admin/users?${search}`
}
