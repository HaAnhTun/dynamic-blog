import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import {
  COMMENT_FILTERS,
  DEFAULT_COMMENT_FILTER,
  commentListHref,
  parseCommentFilter,
  parsePage,
  parsePostFilter,
  parseQuery,
  statusOfFilter,
} from './comment-list'
import { msg } from '@/test/render-intl'

describe('comment-list', () => {
  it('four filters in exactly the specified order and wording', () => {
    expect(COMMENT_FILTERS.map((filter) => translatorFor('vi', 'Admin.comments')(filter.labelKey))).toEqual([
      msg('Site.notifications.center.filterAll'),
      msg('Admin.statuses.comment.VISIBLE'),
      msg('Admin.statuses.comment.HIDDEN'),
      msg('Admin.statuses.comment.DELETED'),
    ])
  })

  // Pinned on purpose: the default entry is "Visible" — what readers currently see, what needs
  // moderating — not "All" (which includes deleted comments). "All" now has its own URL, ?status=all.
  it('the default entry is "Visible"', () => {
    expect(DEFAULT_COMMENT_FILTER).toBe('visible')
  })

  it.each([
    ['all', 'all'],
    ['visible', 'visible'],
    ['hidden', 'hidden'],
    ['deleted', 'deleted'],
    [undefined, 'visible'],
    ['', 'visible'],
    ['HIDDEN', 'visible'],
    ['spam', 'visible'],
    [['hidden', 'deleted'], 'hidden'],
  ] as const)('?status=%j → %s: an unknown value is the default entry, never a confusing empty list', (raw, expected) => {
    expect(parseCommentFilter(raw as string | string[] | undefined)).toBe(expected)
  })

  it.each([
    ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'],
    // Uppercase from a hand-pasted URL: the same post, one spelling.
    ['ABCDEF01-2345-6789-ABCD-EF0123456789', 'abcdef01-2345-6789-abcd-ef0123456789'],
    [['22222222-2222-4222-8222-222222222222', 'x'], '22222222-2222-4222-8222-222222222222'],
    [undefined, null],
    ['', null],
    // Not a UUID means not sent: the backend returns 400 for a malformed postId, and the page must not become an error.
    ['khong-phai-uuid', null],
    ['../../admin/users', null],
    ['11111111-1111-4111-8111-11111111111', null],
  ] as const)('?post=%j → %s', (raw, expected) => {
    expect(parsePostFilter(raw as string | string[] | undefined)).toBe(expected)
  })

  it('filter → backend status; "all" means not sent', () => {
    expect(statusOfFilter('all')).toBeNull()
    expect(statusOfFilter('visible')).toBe('VISIBLE')
    expect(statusOfFilter('hidden')).toBe('HIDDEN')
    expect(statusOfFilter('deleted')).toBe('DELETED')
  })

  it('shares the page and search-box readers with the post list: garbage number is the first page, the search box trims whitespace and length', () => {
    expect(parsePage('2')).toBe(2)
    expect(parsePage('1e3')).toBe(0)
    expect(parsePage('2147483648')).toBe(0)
    expect(parseQuery('  spam  ')).toBe('spam')
    expect(parseQuery('x'.repeat(500))).toHaveLength(100)
  })

  // Pinned on purpose: the entry dropped from the URL is now "Visible", while "All" carries ?status=all.
  it('shortest URL for each status: default parameters dropped, search box encoded', () => {
    expect(commentListHref({ status: 'visible', query: '' })).toBe('/admin/comments')
    expect(commentListHref({ status: 'visible', query: '', page: 0 })).toBe('/admin/comments')
    expect(commentListHref({ status: 'all', query: '' })).toBe('/admin/comments?status=all')
    expect(commentListHref({ status: 'hidden', query: '' })).toBe('/admin/comments?status=hidden')
    expect(commentListHref({ status: 'deleted', query: 'a&b c', page: 2 })).toBe(
      '/admin/comments?status=deleted&q=a%26b+c&page=2',
    )
    // Round trip: the built URL reads back exactly that state, including the default entry and "All".
    for (const status of ['visible', 'all'] as const) {
      const params = new URL(`http://x${commentListHref({ status, query: 'code #1', page: 3 })}`).searchParams
      expect(parseCommentFilter(params.get('status') ?? undefined)).toBe(status)
      expect(parseQuery(params.get('q') ?? undefined)).toBe('code #1')
      expect(parsePage(params.get('page') ?? undefined)).toBe(3)
    }
  })

  it('filter by post: ?post= goes with status, search box and page; missing (null) means every post', () => {
    const post = '11111111-1111-4111-8111-111111111111'
    expect(commentListHref({ status: 'hidden', query: 'spam', post, page: 1 })).toBe(
      `/admin/comments?status=hidden&q=spam&post=${post}&page=1`,
    )
    expect(commentListHref({ status: 'visible', query: '', post })).toBe(`/admin/comments?post=${post}`)
    expect(commentListHref({ status: 'visible', query: '', post: null })).toBe('/admin/comments')
    const params = new URL(`http://x${commentListHref({ status: 'all', query: '', post })}`).searchParams
    expect(parsePostFilter(params.get('post') ?? undefined)).toBe(post)
  })
})
