import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationType, UserNotification } from '@/lib/types'
import { NotificationItem } from './NotificationItem'
import { msg } from '@/test/render-intl'
import { AGO_VI } from '@/test/fixtures/vi/relative-time'
import { ACCENTED_SLUG } from '@/test/fixtures/vi/notification-slug'

/**
 * A notification item: the sentence, the excerpt, the time, the "new" label, the link's destination, and what
 * happens on click. Marking as read and asking the comments section to find the target are fakes: their behavior has its
 * own tests (lib/notifications-client.test.tsx, NotificationBell.test.tsx).
 */
const nav = vi.hoisted(() => ({ pathname: '/notifications' }))
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
}))

const spies = vi.hoisted(() => ({ markNotificationRead: vi.fn(async () => {}), requestCommentTarget: vi.fn() }))
vi.mock('@/lib/notifications-client', () => ({ markNotificationRead: spies.markNotificationRead }))
vi.mock('@/lib/comment-target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/comment-target')>()),
  requestCommentTarget: spies.requestCommentTarget,
}))

const ID = '0b9a5a4e-7c1d-4f7e-8f52-3c1e2d9a6b10'
const COMMENT = '7d3f1c2b-9a8e-4f6d-b5c4-a3b2c1d0e9f8'
// 14:30 on 8 October 2026 UTC+7 (the test suite's TZ); "now" is 3 minutes after that.
const CREATED = '2026-10-08T07:30:00Z'
const NOW = Date.parse(CREATED) + 3 * 60_000

function notification(type: NotificationType, overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id: ID,
    type,
    createdAt: CREATED,
    read: false,
    actor: { displayName: 'Alice Reader', githubLogin: 'doc-gia', avatarUrl: null },
    post: { slug: 'bai-viet', title: msg('Site.about.readNextLinks.writing') },
    commentId: type === 'POST_LIKED' ? null : COMMENT,
    excerpt: type === 'POST_LIKED' ? null : 'An excerpt',
    ...overrides,
  }
}

/** The sentence the reader sees, from the catalog: actor, lead, the post title between curly quotes, tail. */
function sentence(type: NotificationType): string {
  const title = msg('Site.about.readNextLinks.writing')
  return `Alice Reader ${msg(`Site.notifications.copy.lead.${type}`)} “${title}”${msg(`Site.notifications.copy.tail.${type}`)}`
}

function renderItem(item: UserNotification, variant: 'panel' | 'page' = 'panel', onOpen = vi.fn()) {
  render(<NotificationItem notification={item} now={NOW} variant={variant} onOpen={onOpen} />)
  return { link: screen.getByRole('link'), onOpen }
}

/** jsdom cannot navigate: block the default behavior, the link's onClick still runs. */
function clickWithoutNavigation(element: HTMLElement, init?: MouseEventInit) {
  const stop = (event: Event) => event.preventDefault()
  document.addEventListener('click', stop, { capture: true })
  try {
    fireEvent.click(element, init)
  } finally {
    document.removeEventListener('click', stop, { capture: true })
  }
}

beforeEach(() => {
  nav.pathname = '/notifications'
  spies.markNotificationRead.mockClear()
  spies.requestCommentTarget.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('NotificationItem: content', () => {
  it.each([
    ['POST_LIKED', sentence('POST_LIKED'), '/posts/bai-viet'],
    ['POST_COMMENTED', sentence('POST_COMMENTED'), `/posts/bai-viet#binh-luan-${COMMENT}`],
    ['COMMENT_REPLIED', sentence('COMMENT_REPLIED'), `/posts/bai-viet#binh-luan-${COMMENT}`],
    ['COMMENT_LIKED', sentence('COMMENT_LIKED'), `/posts/bai-viet#binh-luan-${COMMENT}`],
  ] as const)('%s: the sentence and the link destination', (type, sentence, href) => {
    const { link } = renderItem(notification(type))

    expect(link).toHaveAttribute('href', href)
    expect(link).toHaveTextContent(sentence)
    // The person's name is bold, in <bdi>: a right-to-left name does not reorder the text around it.
    expect(link.querySelector('strong bdi')).toHaveTextContent('Alice Reader')
  })

  it('excerpt: normal-weight, pale text, at most two lines, a long URL still wraps; POST_LIKED has none', () => {
    const { link } = renderItem(notification('COMMENT_REPLIED', { excerpt: '<b>not HTML</b>' }))

    const excerpt = screen.getByText('<b>not HTML</b>')
    expect(link.contains(excerpt)).toBe(true)
    expect(excerpt).toHaveClass('line-clamp-2', '[overflow-wrap:anywhere]')
    expect(link.querySelector('b')).toBeNull()
  })

  it('time: "3 minutes ago" in <time dateTime>, the full time in the title; the panel does not show the full time as text', () => {
    const { link } = renderItem(notification('POST_LIKED'))

    const time = link.querySelector('time')!
    expect(time).toHaveTextContent(AGO_VI.minutes3)
    expect(time).toHaveAttribute('dateTime', CREATED)
    expect(time).toHaveAttribute('title', '14:30, 08/10/2026')
    expect(link).not.toHaveTextContent('14:30, 08/10/2026')
  })

  it('on the /notifications page: the full time is visible secondary text (a phone has no title)', () => {
    const { link } = renderItem(notification('POST_LIKED'), 'page')

    expect(link).toHaveTextContent(`${AGO_VI.minutes3}·14:30, 08/10/2026`)
  })

  it('unread: a faint brand background and the "New" label VISIBLE, no sr-only fragment in the link', () => {
    const { link } = renderItem(notification('COMMENT_LIKED'))

    expect(link).toHaveClass('bg-brand/5')
    expect(screen.getByText(msg('Site.notifications.item.new'))).toBeVisible()
    expect(link.querySelector('.sr-only')).toBeNull()
  })

  it('read: no background, no "New"', () => {
    const { link } = renderItem(notification('COMMENT_LIKED', { read: true }))

    expect(link).not.toHaveClass('bg-brand/5')
    expect(screen.queryByText(msg('Site.notifications.item.new'))).toBeNull()
  })

  it('the 28px avatar is only for the eye: adds nothing to the link name', () => {
    const { link } = renderItem(notification('POST_LIKED'))

    expect(link.textContent!.startsWith('A')).toBe(true)
    const initial = link.querySelector('[aria-hidden="true"]')
    expect(initial).toHaveClass('h-7', 'w-7')
  })
})

describe('NotificationItem: click to open', () => {
  it('unread: marks it read, then reports to its container that it opened right in this tab', () => {
    const item = notification('COMMENT_REPLIED')
    const { link, onOpen } = renderItem(item)

    clickWithoutNavigation(link)

    expect(spies.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ID)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(item, true)
  })

  it('read: not sent again, still reports to its container (closing the panel)', () => {
    const { link, onOpen } = renderItem(notification('COMMENT_REPLIED', { read: true }))

    clickWithoutNavigation(link)

    expect(spies.markNotificationRead).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('already on that very post (including a slug with diacritics, compared after decoding): asks the comments section to find the target comment', () => {
    nav.pathname = `/posts/${ACCENTED_SLUG}`
    const { link } = renderItem(notification('COMMENT_LIKED', { post: { slug: ACCENTED_SLUG, title: 'X' } }))

    clickWithoutNavigation(link)

    expect(spies.requestCommentTarget).toHaveBeenCalledExactlyOnceWith(COMMENT)
  })

  it('another post, or POST_LIKED on that very post: asks nothing', () => {
    nav.pathname = '/posts/bai-khac'
    clickWithoutNavigation(renderItem(notification('COMMENT_LIKED')).link)
    expect(spies.requestCommentTarget).not.toHaveBeenCalled()
  })

  it('POST_LIKED on that very post: there is no target comment to ask for', () => {
    nav.pathname = '/posts/bai-viet'
    clickWithoutNavigation(renderItem(notification('POST_LIKED')).link)
    expect(spies.requestCommentTarget).not.toHaveBeenCalled()
  })

  // next/link does not navigate on these clicks (`isModifiedEvent`): the notification opens in another tab or window.
  it.each([
    ['Ctrl-click', { ctrlKey: true }],
    ['⌘-click', { metaKey: true }],
    ['Shift-click', { shiftKey: true }],
    ['Alt-click', { altKey: true }],
    ['middle click', { button: 1 }],
  ] as const)(
    '%s on that very post: still marks as read, reports that the host is not leaving this card, does not ask the comment area for this card',
    (_label, init) => {
      nav.pathname = '/posts/bai-viet'
      const item = notification('COMMENT_LIKED')
      const { link, onOpen } = renderItem(item)

      clickWithoutNavigation(link, init)

      expect(spies.markNotificationRead).toHaveBeenCalledExactlyOnceWith(ID)
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(item, false)
      expect(spies.requestCommentTarget).not.toHaveBeenCalled()
    },
  )
})
