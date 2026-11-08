import { describe, expect, it } from 'vitest'
import type { CommentPage, CommentThread, PublicComment } from '@/lib/types'
import {
  INITIAL_STATE,
  commentsReducer,
  focusAfterDelete,
  parseCommentPage,
  parseLikeState,
  parsePublicComment,
  parseVisibleComment,
  type CommentsState,
} from './comment-state'

/**
 * The pure part of the comments area: merging keyset pages, de-duplicating against comments just
 * posted in place, deleting into a placeholder or disappearing, likes, reloading the
 * first page. The component only dispatches; every decision about "what is still shown" lives here.
 */

function comment(id: string, extra: Partial<PublicComment> = {}): PublicComment {
  return {
    id,
    status: 'VISIBLE',
    content: `Content ${id}`,
    author: { displayName: `User ${id}`, githubLogin: `user-${id}`, avatarUrl: null, siteOwner: false },
    createdAt: '2026-10-08T07:00:00Z',
    edited: false,
    mine: false,
    editedAt: null,
    likeCount: 0,
    likedByMe: false,
    ...extra,
  }
}

/** Exactly the shape the older backend sends: no `editedAt`, `likeCount`, `likedByMe`. */
function v5(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const shape: Record<string, unknown> = { ...comment(id) }
  delete shape.editedAt
  delete shape.likeCount
  delete shape.likedByMe
  return { ...shape, ...extra }
}

function thread(id: string, replies: string[] = [], extra: Partial<PublicComment> = {}): CommentThread {
  return { comment: comment(id, extra), replies: replies.map((reply) => comment(reply)) }
}

function page(threads: CommentThread[], nextCursor: string | null = null): CommentPage {
  return { threads, nextCursor }
}

function ready(threads: CommentThread[], appended: CommentThread[] = [], nextCursor: string | null = null): CommentsState {
  return { status: 'ready', more: 'idle', threads, appended, nextCursor }
}

/** The order of ids as on screen: a root then its replies, `threads` before `appended`. */
function order(state: CommentsState): string[] {
  return [...state.threads, ...state.appended].flatMap((t) => [t.comment.id, ...t.replies.map((r) => r.id)])
}

describe('commentsReducer: page load', () => {
  it('first page: threads in server order, the cursor of the next page, status ready', () => {
    const next = commentsReducer(INITIAL_STATE, { type: 'page', page: page([thread('a', ['a1']), thread('b')], 'c1') })

    expect(next.status).toBe('ready')
    expect(next.more).toBe('idle')
    expect(order(next)).toEqual(['a', 'a1', 'b'])
    expect(next.nextCursor).toBe('c1')
  })

  it('a later page appends after, without repeating a thread already present (even a duplicate inside the page)', () => {
    const start = ready([thread('a'), thread('b')], [], 'c1')

    const next = commentsReducer(start, {
      type: 'page',
      page: page([thread('b'), thread('c'), thread('c'), thread('d')], null),
    })

    expect(order(next)).toEqual(['a', 'b', 'c', 'd'])
    expect(next.nextCursor).toBeNull()
  })

  it('DE-DUPLICATION: a later page containing a comment just posted in place moves it out of `appended`, to the position the server gives', () => {
    const start = ready([thread('a')], [thread('cua-toi', [], { mine: true })], 'c1')

    const next = commentsReducer(start, {
      type: 'page',
      page: page([thread('b'), thread('cua-toi', [], { mine: true }), thread('c')]),
    })

    expect(next.appended).toEqual([])
    expect(order(next)).toEqual(['a', 'b', 'cua-toi', 'c'])
    expect(order(next).filter((id) => id === 'cua-toi')).toHaveLength(1)
  })

  it('the server version of a just-posted thread keeps the in-place replies the server has not returned (nothing lost to a network race)', () => {
    const local: CommentThread = { comment: comment('moi'), replies: [comment('r-server'), comment('r-local')] }
    const start = ready([thread('a')], [local], 'c1')

    const next = commentsReducer(start, { type: 'page', page: page([thread('moi', ['r-server'])]) })

    expect(order(next)).toEqual(['a', 'moi', 'r-server', 'r-local'])
  })

  it('first page error: status error; "load more" error: the list stays, only `more` reports the error', () => {
    expect(commentsReducer(INITIAL_STATE, { type: 'failed', more: false }).status).toBe('error')

    const start = ready([thread('a')], [], 'c1')
    const loading = commentsReducer(start, { type: 'more' })
    expect(loading.more).toBe('loading')
    const failed = commentsReducer(loading, { type: 'failed', more: true })
    expect(failed.status).toBe('ready')
    expect(failed.more).toBe('error')
    expect(order(failed)).toEqual(['a'])
    expect(failed.nextCursor).toBe('c1')
  })

  it('retry after an error: loading, then when the page arrives ready', () => {
    const failed = commentsReducer(INITIAL_STATE, { type: 'failed', more: false })
    const retrying = commentsReducer(failed, { type: 'retry' })
    expect(retrying.status).toBe('loading')
    expect(commentsReducer(retrying, { type: 'page', page: page([thread('a')]) }).status).toBe('ready')
  })
})

describe('commentsReducer: write', () => {
  it('a new root comment goes into `appended`, after every server thread; posting a duplicate id is ignored', () => {
    const start = ready([thread('a')])

    const once = commentsReducer(start, { type: 'root-added', comment: comment('moi', { mine: true }) })
    const twice = commentsReducer(once, { type: 'root-added', comment: comment('moi', { mine: true }) })

    expect(order(once)).toEqual(['a', 'moi'])
    expect(once.appended[0]!.comment.mine).toBe(true)
    expect(twice).toEqual(once)
  })

  it('a reply is appended to the end of the right thread, even a thread just posted in place; a duplicate id is ignored', () => {
    const start = ready([thread('a', ['a1']), thread('b')], [thread('moi')])

    let next = commentsReducer(start, { type: 'reply-added', rootId: 'a', reply: comment('a2') })
    next = commentsReducer(next, { type: 'reply-added', rootId: 'moi', reply: comment('moi1') })
    next = commentsReducer(next, { type: 'reply-added', rootId: 'a', reply: comment('a2') })

    expect(order(next)).toEqual(['a', 'a1', 'a2', 'b', 'moi', 'moi1'])
  })

  it('edit: replaces exactly that comment, root or reply, anywhere', () => {
    const start = ready([thread('a', ['a1'])], [thread('moi')])

    let next = commentsReducer(start, { type: 'edited', comment: comment('a1', { content: 'Changed', edited: true }) })
    next = commentsReducer(next, { type: 'edited', comment: comment('moi', { content: 'Also changed', edited: true }) })

    expect(next.threads[0]!.replies[0]).toMatchObject({ content: 'Changed', edited: true })
    expect(next.appended[0]!.comment).toMatchObject({ content: 'Also changed', edited: true })
    expect(next.threads[0]!.comment.content).toBe('Content a')
  })
})

describe('commentsReducer: delete', () => {
  it('a root that still has replies becomes a "deleted" placeholder: no content, no author, no longer mine', () => {
    const start = ready([
      thread('a', ['a1'], { mine: true, edited: true, editedAt: '2026-10-08T08:00:00Z', likeCount: 3, likedByMe: true }),
    ])

    const next = commentsReducer(start, { type: 'deleted', id: 'a' })

    // Exactly as the server returns for a placeholder: no edit time, 0 likes, not "liked".
    expect(next.threads[0]!.comment).toEqual({
      ...start.threads[0]!.comment,
      status: 'DELETED',
      content: null,
      author: null,
      edited: false,
      mine: false,
      editedAt: null,
      likeCount: 0,
      likedByMe: false,
    })
    expect(order(next)).toEqual(['a', 'a1'])
  })

  it('a placeholder from the older backend (likeCount null) stays null: no like is invented', () => {
    const start = ready([thread('a', ['a1'], { mine: true, likeCount: null })])

    const next = commentsReducer(start, { type: 'deleted', id: 'a' })

    expect(next.threads[0]!.comment.likeCount).toBeNull()
  })

  it('a root with no replies left disappears; a reply disappears', () => {
    const start = ready([thread('a'), thread('b', ['b1', 'b2'])], [thread('moi')])

    let next = commentsReducer(start, { type: 'deleted', id: 'a' })
    next = commentsReducer(next, { type: 'deleted', id: 'b1' })
    next = commentsReducer(next, { type: 'deleted', id: 'moi' })

    expect(order(next)).toEqual(['b', 'b2'])
  })

  it('deleting the last reply of a placeholder: the whole thread disappears, as the server will return it', () => {
    const start = ready([thread('an', ['an1'], { status: 'HIDDEN', content: null, author: null }), thread('b')])

    const next = commentsReducer(start, { type: 'deleted', id: 'an1' })

    expect(order(next)).toEqual(['b'])
  })
})

describe('commentsReducer: comment likes', () => {
  it('puts the { liked, count } of the server on exactly the right comment, root or reply, in threads or appended', () => {
    const start = ready([thread('a', ['a1', 'a2'])], [thread('moi')])

    let next = commentsReducer(start, { type: 'liked', id: 'a1', like: { liked: true, count: 7 } })
    next = commentsReducer(next, { type: 'liked', id: 'moi', like: { liked: true, count: 1 } })
    next = commentsReducer(next, { type: 'liked', id: 'a', like: { liked: false, count: 2 } })

    expect(next.threads[0]!.replies[0]).toMatchObject({ likeCount: 7, likedByMe: true })
    expect(next.threads[0]!.replies[1]).toMatchObject({ likeCount: 0, likedByMe: false })
    expect(next.appended[0]!.comment).toMatchObject({ likeCount: 1, likedByMe: true })
    expect(next.threads[0]!.comment).toMatchObject({ likeCount: 2, likedByMe: false })
    // Nothing else changes.
    expect(next.threads[0]!.replies[0]!.content).toBe('Content a1')
    expect(order(next)).toEqual(order(start))
  })

  it('a comment that just became a placeholder while a like was in flight: keeps the 0 of the placeholder', () => {
    const start = ready([thread('a', ['a1'], { status: 'DELETED', content: null, author: null })])

    const next = commentsReducer(start, { type: 'liked', id: 'a', like: { liked: true, count: 4 } })

    expect(next.threads[0]!.comment).toMatchObject({ likeCount: 0, likedByMe: false })
  })

  it('an id not on the page: nothing changes', () => {
    const start = ready([thread('a', ['a1'])])

    const next = commentsReducer(start, { type: 'liked', id: 'khac', like: { liked: true, count: 4 } })

    expect(next.threads).toEqual(start.threads)
  })
})

describe('commentsReducer: reload the first page', () => {
  it('the new first page replaces every loaded page, its cursor, status ready', () => {
    const start = { ...ready([thread('a'), thread('b'), thread('c')], [], null), more: 'loading' as const }

    const next = commentsReducer(start, {
      type: 'reloaded',
      page: page([thread('a', ['a1']), thread('b')], 'c2'),
    })

    expect(order(next)).toEqual(['a', 'a1', 'b'])
    expect(next.nextCursor).toBe('c2')
    expect(next.status).toBe('ready')
    expect(next.more).toBe('idle')
  })

  it('a later page exists: a comment just posted in place leaves the screen — its place is at the end, "load more" brings it back', () => {
    const start = ready([thread('a')], [thread('cua-toi', [], { mine: true })])

    const next = commentsReducer(start, { type: 'reloaded', page: page([thread('a')], 'c2') })

    expect(next.appended).toEqual([])
    expect(order(next)).toEqual(['a'])
  })

  it('the first page is also the last page: a comment just posted that the page does not have yet stays, one it already has does not repeat', () => {
    const start = ready([thread('a')], [thread('da-co', [], { mine: true }), thread('chua-co', [], { mine: true })])

    const next = commentsReducer(start, { type: 'reloaded', page: page([thread('a'), thread('da-co')]) })

    expect(order(next)).toEqual(['a', 'da-co', 'chua-co'])
    expect(next.appended.map((t) => t.comment.id)).toEqual(['chua-co'])
  })

  it('also the way out of a first page error', () => {
    const failed = commentsReducer(INITIAL_STATE, { type: 'failed', more: false })

    expect(commentsReducer(failed, { type: 'reloaded', page: page([thread('a')]) }).status).toBe('ready')
  })
})

describe('focusAfterDelete: the next comment, otherwise the previous comment, otherwise null (the heading)', () => {
  const state = ready([thread('a', ['a1', 'a2']), thread('b')], [thread('moi')])

  it('a reply in the middle of a thread: the next reply', () => {
    expect(focusAfterDelete(state, 'a1')).toBe('a2')
  })

  it('the last reply of a thread: the next root', () => {
    expect(focusAfterDelete(state, 'a2')).toBe('b')
  })

  it('a root that still has replies (becomes a placeholder): its first reply', () => {
    expect(focusAfterDelete(state, 'a')).toBe('a1')
  })

  it('the last comment: the comment right before', () => {
    expect(focusAfterDelete(state, 'moi')).toBe('b')
  })

  it('skips whatever disappears together: the last reply of a placeholder takes the root with it', () => {
    const lonely = ready([thread('a'), thread('an', ['an1'], { status: 'DELETED', content: null, author: null })])
    expect(focusAfterDelete(lonely, 'an1')).toBe('a')
  })

  it('nothing left: null, the component moves focus to the heading', () => {
    expect(focusAfterDelete(ready([thread('a')]), 'a')).toBeNull()
  })
})

describe('reading the payload by the contract', () => {
  it('accepts a correct CommentPage, including placeholders and a null login', () => {
    const valid = page(
      [
        thread('a', ['a1'], { edited: true, editedAt: '2026-10-08T08:00:00Z', likeCount: 3, likedByMe: true }),
        thread('an', ['an1'], { status: 'DELETED', content: null, author: null }),
      ],
      'c1',
    )
    valid.threads[0]!.comment.author = { displayName: 'Admin', githubLogin: null, avatarUrl: null, siteOwner: true }
    expect(parseCommentPage(valid)).toEqual(valid)
    expect(parseCommentPage(page([]))).toEqual(page([]))
  })

  it('author.siteOwner: reads the server flag exactly, true or false', () => {
    const owner = parsePublicComment(
      comment('a', { author: { displayName: 'Owner', githubLogin: null, avatarUrl: null, siteOwner: true } }),
    )
    const reader = parsePublicComment(comment('b'))

    expect(owner?.author?.siteOwner).toBe(true)
    expect(reader?.author?.siteOwner).toBe(false)
  })

  it('author.profileSlug (T-003): when present it is carried; missing (older backend) or null (locked) it is absent; a wrong type is a contract mismatch', () => {
    const base = { displayName: 'A', githubLogin: null, avatarUrl: null, siteOwner: false }

    expect(parsePublicComment(comment('a', { author: { ...base, profileSlug: 'user-a' } }))?.author).toEqual({
      ...base,
      profileSlug: 'user-a',
    })
    expect(parsePublicComment(comment('b'))?.author).not.toHaveProperty('profileSlug')
    expect(parsePublicComment(comment('d', { author: { ...base, profileSlug: null } }))?.author).toEqual(base)
    expect(parsePublicComment({ ...comment('c'), author: { ...base, profileSlug: 7 } })).toBeNull()
  })

  it('a backend without siteOwner (not restarted after the upgrade): missing gives false, the comment is still readable', () => {
    // Like the three newer fields above: `next dev` loads the new frontend immediately, the backend on :8080 keeps the old class until
    // it restarts. A missing flag means nobody is the site owner — never guessed from the name.
    const author = { displayName: 'User a', githubLogin: 'user-a', avatarUrl: null }
    const parsed = parseCommentPage({
      threads: [{ comment: { ...comment('a'), author }, replies: [v5('a1', { author })] }],
      nextCursor: null,
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.threads[0]!.comment.author).toEqual({ ...author, siteOwner: false })
    expect(parsed!.threads[0]!.replies[0]!.author).toEqual({ ...author, siteOwner: false })
  })

  it('the result only has the contract fields: an unknown server field does not come along', () => {
    const parsed = parsePublicComment({ ...comment('a'), userId: 'u-1', email: 'x@example.com' })

    expect(parsed).toEqual(comment('a'))
    expect(parsed).not.toHaveProperty('userId')

    // Even inside author: the site owner flag is the only thing about role that passes through.
    const author = parsePublicComment({
      ...comment('b'),
      author: { displayName: 'B', githubLogin: null, avatarUrl: null, siteOwner: true, role: 'ADMIN', id: 'u-2' },
    })?.author
    expect(author).toEqual({ displayName: 'B', githubLogin: null, avatarUrl: null, siteOwner: true })
  })

  it('the older backend (not restarted): the three newer fields missing take the older values, the page does not break', () => {
    const parsed = parseCommentPage({
      threads: [{ comment: v5('a', { edited: true }), replies: [v5('a1')] }],
      nextCursor: null,
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.threads[0]!.comment).toMatchObject({ edited: true, editedAt: null, likeCount: null, likedByMe: false })
    expect(parsed!.threads[0]!.replies[0]).toMatchObject({ editedAt: null, likeCount: null, likedByMe: false })
  })

  it.each([
    ['null', null],
    ['missing threads', { nextCursor: null }],
    ['nextCursor is a number', { threads: [], nextCursor: 1 }],
    ['replies is not an array', { threads: [{ comment: comment('a'), replies: null }], nextCursor: null }],
    ['unknown status', { threads: [{ comment: comment('a', { status: 'SPAM' as never }), replies: [] }], nextCursor: null }],
    ['VISIBLE without content', { threads: [{ comment: comment('a', { content: null }), replies: [] }], nextCursor: null }],
    ['VISIBLE without an author', { threads: [{ comment: comment('a', { author: null }), replies: [] }], nextCursor: null }],
    [
      'author name is not a string',
      { threads: [{ comment: comment('a', { author: { displayName: 1 } as never }), replies: [] }], nextCursor: null },
    ],
    ['mine is not a boolean', { threads: [{ comment: comment('a', { mine: 'yes' as never }), replies: [] }], nextCursor: null }],
    ['one broken reply', { threads: [{ comment: comment('a'), replies: [comment('a1'), { id: 'a2' }] }], nextCursor: null }],
  ])('rejects: %s', (_label, value) => {
    expect(parseCommentPage(value)).toBeNull()
  })

  it.each([
    ['negative likeCount', { likeCount: -1 }],
    ['fractional likeCount', { likeCount: 1.5 }],
    ['likeCount is a string', { likeCount: '3' }],
    ['likeCount beyond the safe integer', { likeCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['likeCount null (present but not a number)', { likeCount: null }],
    ['likedByMe is a string', { likedByMe: 'yes' }],
    ['likedByMe null', { likedByMe: null }],
    ['editedAt is a number', { editedAt: 1_728_370_800 }],
    ['author.siteOwner is a string', { author: { displayName: 'A', githubLogin: null, avatarUrl: null, siteOwner: 'true' } }],
    ['author.siteOwner is a number', { author: { displayName: 'A', githubLogin: null, avatarUrl: null, siteOwner: 1 } }],
    ['author.siteOwner null', { author: { displayName: 'A', githubLogin: null, avatarUrl: null, siteOwner: null } }],
  ])('a newer field present with the wrong type still breaks the whole page, like any other field: %s', (_label, extra) => {
    const value = { threads: [{ comment: { ...comment('a'), ...extra }, replies: [] }], nextCursor: null }

    expect(parseCommentPage(value)).toBeNull()
  })

  it('parseVisibleComment: only a complete VISIBLE comment (what POST/PUT return), including the older shape', () => {
    expect(parseVisibleComment(comment('a'))).toEqual(comment('a'))
    expect(parseVisibleComment(v5('a'))).toMatchObject({ id: 'a', likeCount: null, likedByMe: false, editedAt: null })
    expect(parseVisibleComment(comment('a', { status: 'DELETED', content: null, author: null }))).toBeNull()
    expect(parseVisibleComment({ id: 'a' })).toBeNull()
    expect(parseVisibleComment(undefined)).toBeNull()
  })

  it('parseLikeState: { liked, count } by the contract, otherwise null', () => {
    expect(parseLikeState({ liked: true, count: 3 })).toEqual({ liked: true, count: 3 })
    expect(parseLikeState({ liked: false, count: 0, extra: 1 })).toEqual({ liked: false, count: 0 })
    expect(parseLikeState({ liked: 'yes', count: 3 })).toBeNull()
    expect(parseLikeState({ liked: true, count: -1 })).toBeNull()
    expect(parseLikeState({ liked: true })).toBeNull()
    expect(parseLikeState(null)).toBeNull()
  })
})
