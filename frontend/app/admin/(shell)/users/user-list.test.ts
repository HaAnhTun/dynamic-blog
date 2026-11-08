import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import {
  ROLE_FILTERS,
  USER_STATUS_FILTERS,
  parsePage,
  parseQuery,
  parseRoleFilter,
  parseUserStatusFilter,
  roleOfFilter,
  statusOfUserFilter,
  userListHref,
} from './user-list'
import { msg } from '@/test/render-intl'
import { ACCENTED_NAME_QUERY } from '@/test/fixtures/vi/user-list-query'

describe('user-list', () => {
  it('role and status filters, "any…" first', () => {
    expect(ROLE_FILTERS.map((filter) => translatorFor('vi', 'Admin.statuses')(filter.labelKey))).toEqual([
      msg('Admin.statuses.filter.anyRole'),
      msg('Admin.statuses.role.USER'),
      msg('Site.authorBox.eyebrow'),
      msg('Site.account.admin'),
    ])
    // Same wording as the table's status labels (statuses.ts), not the same as the "Suspend" button.
    expect(USER_STATUS_FILTERS.map((filter) => translatorFor('vi', 'Admin.statuses')(filter.labelKey))).toEqual([
      msg('Admin.statuses.filter.anyStatus'),
      msg('Admin.statuses.user.ACTIVE'),
      msg('Admin.statuses.user.SUSPENDED'),
    ])
  })

  it.each([
    ['user', 'user'],
    ['author', 'author'],
    ['admin', 'admin'],
    [undefined, 'all'],
    ['USER', 'all'],
    ['root', 'all'],
    [['admin', 'user'], 'admin'],
  ] as const)('?role=%j → %s', (raw, expected) => {
    expect(parseRoleFilter(raw as string | string[] | undefined)).toBe(expected)
  })

  it.each([
    ['active', 'active'],
    ['suspended', 'suspended'],
    [undefined, 'all'],
    ['SUSPENDED', 'all'],
    ['banned', 'all'],
  ] as const)('?status=%j → %s', (raw, expected) => {
    expect(parseUserStatusFilter(raw as string | undefined)).toBe(expected)
  })

  it('filter to backend value; "any…" means not sent', () => {
    expect(roleOfFilter('all')).toBeNull()
    expect(roleOfFilter('user')).toBe('USER')
    expect(roleOfFilter('author')).toBe('AUTHOR')
    expect(roleOfFilter('admin')).toBe('ADMIN')
    expect(statusOfUserFilter('all')).toBeNull()
    expect(statusOfUserFilter('active')).toBe('ACTIVE')
    expect(statusOfUserFilter('suspended')).toBe('SUSPENDED')
  })

  it('shortest URL, reads back the exact state', () => {
    expect(userListHref({ query: '', role: 'all', status: 'all' })).toBe('/admin/users')
    expect(userListHref({ query: 'octo cat', role: 'user', status: 'suspended', page: 2 })).toBe(
      '/admin/users?q=octo+cat&role=user&status=suspended&page=2',
    )
    const params = new URL(`http://x${userListHref({ query: ACCENTED_NAME_QUERY, role: 'admin', status: 'active', page: 1 })}`)
      .searchParams
    expect(parseQuery(params.get('q') ?? undefined)).toBe(ACCENTED_NAME_QUERY)
    expect(parseRoleFilter(params.get('role') ?? undefined)).toBe('admin')
    expect(parseUserStatusFilter(params.get('status') ?? undefined)).toBe('active')
    expect(parsePage(params.get('page') ?? undefined)).toBe(1)
  })
})
