import type { CommentAuthor, CommentPage, CommentStatus, CommentThread, LikeState, PublicComment } from '@/lib/types'

/**
 * The pure part of the comments area: the `useReducer` state in
 * CommentSection, the transformations of it, and reading the payload by the contract. No React, no fetch:
 * every decision about "what is still shown, and where" lives here and is tested directly.
 *
 * - `threads`: the threads in server order, merged from keyset pages, never repeating an id.
 * - `appended`: root comments just posted during this view, shown after `threads`. When a later page contains
 *   their ids, they leave `appended` and sit where the server puts them — never shown twice.
 * - `status`: the first page (`idle` is not yet asked; the UI draws it like `loading`). `more`: the "load more" button.
 */

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type MoreStatus = 'idle' | 'loading' | 'error'

export type CommentsState = {
  status: LoadStatus
  more: MoreStatus
  threads: CommentThread[]
  appended: CommentThread[]
  nextCursor: string | null
}

export const INITIAL_STATE: CommentsState = { status: 'idle', more: 'idle', threads: [], appended: [], nextCursor: null }

export type CommentsAction =
  /** "Retry" after the first page failed. */
  | { type: 'retry' }
  /** "Load more comments". */
  | { type: 'more' }
  | { type: 'page'; page: CommentPage }
  /** The first page reloads when the reader presses a notification of the post that is currently open. */
  | { type: 'reloaded'; page: CommentPage }
  | { type: 'failed'; more: boolean }
  | { type: 'root-added'; comment: PublicComment }
  | { type: 'reply-added'; rootId: string; reply: PublicComment }
  | { type: 'edited'; comment: PublicComment }
  | { type: 'deleted'; id: string }
  /** The server recorded a like or unlike of comment `id`: the server's `{ liked, count }`. */
  | { type: 'liked'; id: string; like: LikeState }

export function commentsReducer(state: CommentsState, action: CommentsAction): CommentsState {
  switch (action.type) {
    case 'retry':
      return { ...state, status: 'loading' }
    case 'more':
      return { ...state, more: 'loading' }
    case 'failed':
      return action.more ? { ...state, more: 'error' } : { ...state, status: 'error' }
    case 'page':
      return mergePage(state, action.page)
    case 'reloaded':
      // The new first page replaces every loaded page; "load more" goes again from its cursor. Comments just posted in
      // place only stay when this page is also the last page: if a later page exists their place is the end of the
      // list, and "load more" will bring them to exactly that place.
      return mergePage({ ...INITIAL_STATE, appended: action.page.nextCursor === null ? state.appended : [] }, action.page)
    case 'liked':
      return mapThreads(state, (thread) => ({
        comment: withLike(thread.comment, action.id, action.like),
        replies: thread.replies.map((reply) => withLike(reply, action.id, action.like)),
      }))
    case 'root-added':
      if (hasThread(state, action.comment.id)) return state
      return { ...state, appended: [...state.appended, { comment: action.comment, replies: [] }] }
    case 'reply-added':
      return mapThreads(state, (thread) =>
        thread.comment.id === action.rootId && !thread.replies.some((reply) => reply.id === action.reply.id)
          ? { ...thread, replies: [...thread.replies, action.reply] }
          : thread,
      )
    case 'edited':
      return mapThreads(state, (thread) => ({
        comment: thread.comment.id === action.comment.id ? action.comment : thread.comment,
        replies: thread.replies.map((reply) => (reply.id === action.comment.id ? action.comment : reply)),
      }))
    case 'deleted':
      return { ...state, threads: deleteFrom(state.threads, action.id), appended: deleteFrom(state.appended, action.id) }
  }
}

function hasThread(state: CommentsState, id: string): boolean {
  return state.threads.some((t) => t.comment.id === id) || state.appended.some((t) => t.comment.id === id)
}

function mapThreads(state: CommentsState, update: (thread: CommentThread) => CommentThread): CommentsState {
  return { ...state, threads: state.threads.map(update), appended: state.appended.map(update) }
}

/**
 * A like belongs only to a VISIBLE comment: a comment that just became a placeholder while a like
 * was in flight keeps the placeholder's 0.
 */
function withLike(comment: PublicComment, id: string, like: LikeState): PublicComment {
  if (comment.id !== id || comment.status !== 'VISIBLE') return comment
  return { ...comment, likeCount: like.count, likedByMe: like.liked }
}

/**
 * Append a page after the existing threads. The keyset `(created_at, id)` makes a later page neither repeat nor skip,
 * but de-duplicating by id is still a safety net (a retry, StrictMode running the effect twice).
 *
 * A thread just posted in place that this page has: take the server's version (right position, right data), and add
 * the in-place replies the server has not returned yet (posted while the page request was in flight).
 */
function mergePage(state: CommentsState, page: CommentPage): CommentsState {
  const seen = new Set(state.threads.map((t) => t.comment.id))
  const local = new Map(state.appended.map((t) => [t.comment.id, t]))
  const incoming: CommentThread[] = []
  for (const thread of page.threads) {
    const id = thread.comment.id
    if (seen.has(id)) continue
    seen.add(id)
    const mine = local.get(id)
    incoming.push(mine ? { ...thread, replies: unionReplies(thread.replies, mine.replies) } : thread)
  }
  return {
    status: 'ready',
    more: 'idle',
    threads: [...state.threads, ...incoming],
    appended: state.appended.filter((t) => !seen.has(t.comment.id)),
    nextCursor: page.nextCursor,
  }
}

function unionReplies(server: PublicComment[], local: PublicComment[]): PublicComment[] {
  const ids = new Set(server.map((reply) => reply.id))
  return [...server, ...local.filter((reply) => !ids.has(reply.id))]
}

/**
 * A soft delete as the reader sees it: a root that still has replies becomes a "deleted" placeholder —
 * no content, no author, no longer "mine" — otherwise it disappears. A placeholder that loses its
 * last reply also disappears: the server will not return it any more.
 */
function deleteFrom(threads: CommentThread[], id: string): CommentThread[] {
  const out: CommentThread[] = []
  for (const thread of threads) {
    if (thread.comment.id === id) {
      if (thread.replies.length > 0) out.push({ ...thread, comment: asDeleted(thread.comment) })
      continue
    }
    const replies = thread.replies.filter((reply) => reply.id !== id)
    if (replies.length === thread.replies.length) out.push(thread)
    else if (replies.length > 0 || thread.comment.status === 'VISIBLE') out.push({ ...thread, replies })
  }
  return out
}

/** Exactly as the server returns for a placeholder: no edit time, 0 likes (null stays null: the older backend). */
function asDeleted(comment: PublicComment): PublicComment {
  return {
    ...comment,
    status: 'DELETED',
    content: null,
    author: null,
    edited: false,
    mine: false,
    editedAt: null,
    likeCount: comment.likeCount === null ? null : 0,
    likedByMe: false,
  }
}

/**
 * The comment that receives focus after `id` is deleted: the next one on screen, otherwise the one right
 * before, skipping everything that disappears with this deletion. null: no comment is left, focus goes to the heading.
 */
export function focusAfterDelete(state: CommentsState, id: string): string | null {
  const before = visibleOrder(state)
  const after = new Set(visibleOrder(commentsReducer(state, { type: 'deleted', id })))
  const index = before.indexOf(id)
  if (index === -1) return null
  const next = before.slice(index + 1).find((candidate) => after.has(candidate))
  if (next !== undefined) return next
  return (
    before
      .slice(0, index)
      .reverse()
      .find((candidate) => after.has(candidate)) ?? null
  )
}

function visibleOrder(state: CommentsState): string[] {
  return [...state.threads, ...state.appended].flatMap((t) => [t.comment.id, ...t.replies.map((reply) => reply.id)])
}

/* The `CommentPage` / `CommentResponse` contract, checked again in the browser like LikeButton
   checks `LikeState`: a payload that breaks the contract is "could not load", never a half-drawn comment.

   READS and not only checks. The newer fields — `editedAt`, `likeCount`, `likedByMe`, and
   `author.siteOwner` (the site owner flag) — if MISSING take the values of the earlier version: `next dev` loads the
   new frontend immediately, while the backend on :8080 keeps the old class until the site owner restarts it, and a
   strict check would break every comments area in that window. PRESENT with the wrong type still breaks the whole page,
   like every other field. The result is a freshly built object with only the fields of the contract. */

export type VisibleComment = PublicComment & { status: 'VISIBLE'; content: string; author: CommentAuthor }

const STATUSES: readonly CommentStatus[] = ['VISIBLE', 'HIDDEN', 'DELETED']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** A count: a safe integer, not negative. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * The author, or undefined when the contract is broken (null is a valid value for a placeholder, so it is not used).
 * A missing `siteOwner` means the backend has no site owner label yet: false, nobody is the site owner.
 * `profileSlug`: missing means the backend has no public profile yet, null means the author is locked; either way it is absent
 * altogether, and the name does not become a link.
 */
function parseAuthor(value: unknown): CommentAuthor | undefined {
  if (!isRecord(value)) return undefined
  const { displayName, githubLogin, avatarUrl, profileSlug } = value
  const siteOwner = sinceV6(value.siteOwner, isBoolean, false)
  if (
    typeof displayName !== 'string' ||
    !isNullableString(githubLogin) ||
    !isNullableString(avatarUrl) ||
    siteOwner === undefined ||
    (profileSlug !== undefined && !isNullableString(profileSlug))
  ) {
    return undefined
  }
  return { displayName, githubLogin, avatarUrl, siteOwner, ...(typeof profileSlug === 'string' ? { profileSlug } : {}) }
}

/** One newer field: missing gives `fallback` (the earlier version's value); present it must pass `check`, otherwise undefined. */
function sinceV6<T, F>(value: unknown, check: (candidate: unknown) => candidate is T, fallback: F): T | F | undefined {
  if (value === undefined) return fallback
  return check(value) ? value : undefined
}

/** A comment that matches the contract, or null. VISIBLE must have content and an author. */
export function parsePublicComment(value: unknown): PublicComment | null {
  if (!isRecord(value)) return null
  const { id, content, createdAt, edited, mine } = value
  const status = STATUSES.find((candidate) => candidate === value.status)
  if (
    status === undefined ||
    typeof id !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof edited !== 'boolean' ||
    typeof mine !== 'boolean' ||
    !isNullableString(content)
  ) {
    return null
  }
  const author = value.author === null ? null : parseAuthor(value.author)
  const editedAt = sinceV6(value.editedAt, isNullableString, null)
  const likeCount = sinceV6(value.likeCount, isCount, null)
  const likedByMe = sinceV6(value.likedByMe, isBoolean, false)
  if (author === undefined || editedAt === undefined || likeCount === undefined || likedByMe === undefined) return null
  if (status === 'VISIBLE' && (content === null || author === null)) return null
  return { id, status, content, author, createdAt, edited, mine, editedAt, likeCount, likedByMe }
}

/** What POST and PUT return: always the sender's own VISIBLE comment. Anything else is null. */
export function parseVisibleComment(value: unknown): VisibleComment | null {
  const comment = parsePublicComment(value)
  if (comment === null || comment.status !== 'VISIBLE' || comment.content === null || comment.author === null) return null
  return { ...comment, status: 'VISIBLE', content: comment.content, author: comment.author }
}

/** Every element matches the contract, or null: one broken comment breaks the whole page. */
function parseComments(values: readonly unknown[]): PublicComment[] | null {
  const comments: PublicComment[] = []
  for (const value of values) {
    const comment = parsePublicComment(value)
    if (comment === null) return null
    comments.push(comment)
  }
  return comments
}

function parseThread(value: unknown): CommentThread | null {
  if (!isRecord(value) || !Array.isArray(value.replies)) return null
  const comment = parsePublicComment(value.comment)
  const replies = parseComments(value.replies)
  return comment === null || replies === null ? null : { comment, replies }
}

export function parseCommentPage(value: unknown): CommentPage | null {
  if (!isRecord(value)) return null
  const { threads: items, nextCursor } = value
  if (!Array.isArray(items) || !isNullableString(nextCursor)) return null
  const threads: CommentThread[] = []
  for (const item of items) {
    const thread = parseThread(item)
    if (thread === null) return null
    threads.push(thread)
  }
  return { threads, nextCursor }
}

/** The `{ liked, count }` of PUT / DELETE on a comment like, or null when the contract is broken. */
export function parseLikeState(value: unknown): LikeState | null {
  if (!isRecord(value)) return null
  const { liked, count } = value
  return typeof liked === 'boolean' && isCount(count) ? { liked, count } : null
}
