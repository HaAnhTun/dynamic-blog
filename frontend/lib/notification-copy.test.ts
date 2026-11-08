// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { translatorFor } from '@/test/intl'
import {
  NOTIFICATION_TYPES,
  notificationCopy,
  notificationHref,
  notificationSentence,
  notificationWriteError,
  parseNotification,
  parseNotificationPage,
  unreadLabel,
} from './notification-copy'
import type { NotificationType, UserNotification } from './types'
import { msg } from '@/test/render-intl'
import { SLUG_XIN_CHAO } from '@/test/fixtures/vi/accented-text'

const t = translatorFor('vi', 'Site.notifications')
const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'
const COMMENT = '7d3f1c2b-9a8e-4f6d-b5c4-a3b2c1d0e9f8'

function notification(type: NotificationType, overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id: ID,
    type,
    createdAt: '2026-10-08T07:30:00Z',
    read: false,
    actor: { displayName: 'Alice Reader', githubLogin: 'doc-gia', avatarUrl: null },
    post: { slug: 'bai-viet-dau-tien', title: 'First post' },
    commentId: type === 'POST_LIKED' ? null : COMMENT,
    excerpt: type === 'POST_LIKED' ? null : 'Great!',
    ...overrides,
  }
}

/** Exactly the JSON shape the backend returns (`NotificationResponse`), so the reader is tried on real data. */
function wire(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    type,
    createdAt: '2026-10-08T07:30:00.123456Z',
    read: false,
    actor: { displayName: 'Alice Reader', githubLogin: 'doc-gia', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    post: { slug: 'bai-viet-dau-tien', title: 'First post' },
    commentId: type === 'POST_LIKED' ? null : COMMENT,
    excerpt: type === 'POST_LIKED' ? null : 'Great!',
    ...overrides,
  }
}

/** The sentence the reader sees, from the catalog: actor, lead, the post title between curly quotes, tail. */
function sentence(type: NotificationType): string {
  return `Alice Reader ${msg(`Site.notifications.copy.lead.${type}`)} “First post”${msg(`Site.notifications.copy.tail.${type}`)}`
}

describe('notificationSentence and notificationHref: the four types', () => {
  it.each([
    ['POST_LIKED', sentence('POST_LIKED'), '/posts/bai-viet-dau-tien'],
    ['POST_COMMENTED', sentence('POST_COMMENTED'), `/posts/bai-viet-dau-tien#binh-luan-${COMMENT}`],
    ['COMMENT_REPLIED', sentence('COMMENT_REPLIED'), `/posts/bai-viet-dau-tien#binh-luan-${COMMENT}`],
    ['COMMENT_LIKED', sentence('COMMENT_LIKED'), `/posts/bai-viet-dau-tien#binh-luan-${COMMENT}`],
  ] as const)('%s', (type, sentence, href) => {
    const item = notification(type)

    expect(notificationSentence(item, t)).toBe(sentence)
    expect(notificationHref(item)).toBe(href)
  })

  it('each type has its own sentence; the post title always sits between lead and tail', () => {
    expect(NOTIFICATION_TYPES).toEqual(['POST_LIKED', 'POST_COMMENTED', 'COMMENT_REPLIED', 'COMMENT_LIKED'])
    const leads = NOTIFICATION_TYPES.map((type) => notificationCopy(type, t).lead)
    expect(new Set(leads).size).toBe(4)
    for (const type of NOTIFICATION_TYPES) expect(notificationCopy(type, t).tail.endsWith('.')).toBe(true)
  })

  it('a slug with diacritics is encoded like postPath: href and the post page path are one string', () => {
    expect(notificationHref(notification('COMMENT_LIKED', { post: { slug: SLUG_XIN_CHAO, title: 'X' } }))).toBe(
      `/posts/xin-ch%C3%A0o#binh-luan-${COMMENT}`,
    )
  })
})

describe('parseNotification: a notification that matches the contract, or null', () => {
  it.each(['POST_LIKED', 'POST_COMMENTED', 'COMMENT_REPLIED', 'COMMENT_LIKED'])('%s is valid', (type) => {
    const parsed = parseNotification(wire(type))

    expect(parsed).toEqual({
      id: ID,
      type,
      createdAt: '2026-10-08T07:30:00.123456Z',
      read: false,
      actor: { displayName: 'Alice Reader', githubLogin: 'doc-gia', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
      post: { slug: 'bai-viet-dau-tien', title: 'First post' },
      commentId: type === 'POST_LIKED' ? null : COMMENT,
      excerpt: type === 'POST_LIKED' ? null : 'Great!',
    })
  })

  it('keeps only the contract fields: unknown fields (id of the actor, email) are not passed on', () => {
    const parsed = parseNotification(
      wire('COMMENT_LIKED', {
        recipientId: 'x',
        actor: { displayName: 'A', githubLogin: null, avatarUrl: null, id: 'u1', email: 'a@b.c' },
        post: { slug: 's', title: 't', content: 'body text' },
      }),
    )!

    expect(Object.keys(parsed).sort()).toEqual(
      ['actor', 'commentId', 'createdAt', 'excerpt', 'id', 'post', 'read', 'type'].sort(),
    )
    expect(parsed.actor).toEqual({ displayName: 'A', githubLogin: null, avatarUrl: null })
    expect(parsed.post).toEqual({ slug: 's', title: 't' })
  })

  it.each([
    ['unknown type', wire('POST_SHARED')],
    ['id is not a UUID', wire('POST_LIKED', { id: '../x' })],
    ['read is not a boolean', wire('POST_LIKED', { read: 'false' })],
    ['createdAt missing', wire('POST_LIKED', { createdAt: undefined })],
    ['actor without a name', wire('POST_LIKED', { actor: { githubLogin: null, avatarUrl: null } })],
    ['actor null', wire('POST_LIKED', { actor: null })],
    ['post missing', wire('POST_LIKED', { post: null })],
    ['empty slug', wire('POST_LIKED', { post: { slug: '', title: 'x' } })],
    ['excerpt is a number', wire('COMMENT_REPLIED', { excerpt: 3 })],
    ['a comment type without commentId', wire('COMMENT_REPLIED', { commentId: null })],
    ['commentId is not a UUID', wire('COMMENT_LIKED', { commentId: 'abc' })],
    ['POST_LIKED with a commentId', wire('POST_LIKED', { commentId: COMMENT })],
    ['not an object', 'POST_LIKED'],
  ])('%s: null', (_label, value) => {
    expect(parseNotification(value)).toBeNull()
  })
})

describe('parseNotificationPage', () => {
  it('a valid page: keeps the cursors, reads each item', () => {
    const page = parseNotificationPage({
      items: [wire('POST_LIKED'), wire('COMMENT_REPLIED')],
      nextCursor: 'abc',
      headCursor: 'xyz',
    })

    expect(page?.items.map((item) => item.type)).toEqual(['POST_LIKED', 'COMMENT_REPLIED'])
    expect(page?.nextCursor).toBe('abc')
    expect(page?.headCursor).toBe('xyz')
  })

  it('an item of unknown type or wrong shape is DROPPED, not failing the whole page (a new type added to the backend later)', () => {
    const page = parseNotificationPage({
      items: [wire('POST_SHARED'), wire('POST_LIKED'), { id: ID }, null, wire('COMMENT_LIKED')],
      nextCursor: null,
      headCursor: null,
    })

    expect(page).not.toBeNull()
    expect(page!.items.map((item) => item.type)).toEqual(['POST_LIKED', 'COMMENT_LIKED'])
  })

  it.each([
    ['null', null],
    ['no items', { nextCursor: null, headCursor: null }],
    ['items is not an array', { items: {}, nextCursor: null, headCursor: null }],
    ['nextCursor is a number', { items: [], nextCursor: 1, headCursor: null }],
    ['headCursor missing', { items: [], nextCursor: null }],
    ['a string', 'items'],
  ])('wrong envelope (%s): null, meaning "could not load"', (_label, value) => {
    expect(parseNotificationPage(value)).toBeNull()
  })
})

describe('unreadLabel and notificationWriteError', () => {
  it('99 is "99", from 100 (the server caps at 100) it is "99+"', () => {
    expect(unreadLabel(1)).toBe('1')
    expect(unreadLabel(99)).toBe('99')
    expect(unreadLabel(100)).toBe('99+')
  })

  it('network and 5xx: check the connection; anything else: retry. Never the backend text', () => {
    expect(notificationWriteError(0, 'NETWORK', t)).toBe(msg('Site.profile.author.errors.network'))
    expect(notificationWriteError(502, 'UPSTREAM_UNAVAILABLE', t)).toBe(msg('Site.profile.author.errors.network'))
    expect(notificationWriteError(403, 'USER_SUSPENDED', t)).toBe(msg('Site.notifications.errors.generic'))
    expect(notificationWriteError(400, 'VALIDATION_ERROR', t)).toBe(msg('Site.notifications.errors.generic'))
  })
})
