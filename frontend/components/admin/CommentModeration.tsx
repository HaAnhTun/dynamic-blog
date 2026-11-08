'use client'

import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { Trash2Icon } from '@/components/icons'
import { Avatar } from '@/components/site/Avatar'
import { formatDate } from '@/lib/date'
import { asLocale, lowerCase } from '@/lib/format'
import type { AdminComment, CommentStatus } from '@/lib/types'
import { ErrorAlert, ToneBadge } from './primitives'
import { StaleListNotice } from './StaleListNotice'
import { commentStatusLook, USER_STATUS } from './statuses'
import { button, FOCUS_RING, META, postStatusLabel, STATUS_TEXT } from './ui'
import { focusStayedIn, useRowAction } from './useRowAction'

type Outcome = AdminComment | { error: string }

export type CommentModerationProps = {
  /** One page of the list, as the backend returns it (newest first). */
  comments: AdminComment[]
  /** Table caption (sr-only): the filter, the search box and the current page. */
  caption: string
  /**
   * Status the list is filtered by; null means "all". A row that changes to another status has already left
   * the list on the server: StaleListNotice offers a reload before moving to another page.
   */
  statusFilter: CommentStatus | null
  /**
   * "Only this post's comments": URL of the list filtered by a single post, by post id. The page builds
   * it up front (keeping the current status tab) because a client component cannot receive a function from the
   * server. Absent when the list is already filtered by exactly one post, in which case there is no link.
   */
  postFilterHrefs?: Record<string, string>
  onHide: (id: string) => Promise<Outcome>
  onRestore: (id: string) => Promise<Outcome>
  /** null means deleted. */
  onDelete: (id: string) => Promise<{ error: string } | null>
}

/** Column count: the delete-confirmation row and the error row span the full table width. */
const COLUMNS = 6

/**
 * Longer than that, the first three lines do not fit in the narrowest column (~176px of text on a 320px screen): the
 * show-full button appears. A rough count, not a measurement: on wide screens the button may show for a comment that fits in three lines, which is harmless.
 */
const LONG_CHARS = 120
const LONG_LINES = 3

/** The beginning of the comment inside the button's accessible name: enough to tell apart two comments by the same author. */
const EXCERPT = 40

/** A row button: small, borderless like the Edit/Delete of the Topics page; faded with a wait cursor while pending. */
const ROW_BUTTON = button('ghost', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')
const ROW_DANGER = button(
  'ghost',
  'sm',
  'text-red-700 hover:bg-red-50 hover:text-red-800 aria-disabled:cursor-wait aria-disabled:opacity-60',
)

type Notice = { kind: 'hide' | 'restore' | 'delete'; name: string }

function excerpt(content: string): string {
  const chars = Array.from(content.replace(/\s+/g, ' ').trim())
  return chars.length > EXCERPT ? `${chars.slice(0, EXCERPT).join('').trimEnd()}…` : chars.join('')
}

/**
 * Moderation table of the Comments page: one row per comment with the
 * author, post, date, status, and the hide / unhide / delete buttons in the style of TopicManager rows.
 *
 * The result of each action is applied straight to the row (state, initialized from props): the action does not updateTag,
 * so the page does not re-render. A row that just changed does NOT vanish from the current filter: the moderator sees
 * what they just did, can undo it right there, and focus keeps its place. The price is that the server pagination
 * is stale once a row leaves the filter; StaleListNotice says so and reloads exactly this page.
 * Changing the filter or page rebuilds this component (`key` is the list URL), with fresh data.
 *
 * One `role="status"` region for the whole table, always present, announces the result of each action.
 */
export default function CommentModeration({
  comments,
  caption,
  statusFilter,
  postFilterHrefs,
  onHide,
  onRestore,
  onDelete,
}: CommentModerationProps) {
  const t = useTranslations('Admin.comments.table')
  const [rows, setRows] = useState(comments)
  const [notice, setNotice] = useState<Notice | null>(null)
  const table = useRef<HTMLTableElement>(null)
  // The reload-list button was just pressed: when the new list arrives, the notice and its button disappear. If focus
  // was on that button (now fallen back to <body>), move it to the table so keyboard users do not have to Tab from the start.
  const refocusTable = useRef(false)
  // The server sends a new list while `key` does not change (pressing the tab already open, router.refresh()): the new data
  // wins. A new array only arrives when the page re-renders on the server, which the actions never trigger,
  // so a change just applied in place is not overwritten by its own stale copy. React's "adjust state when a prop
  // changes" pattern: compare during render, not in an effect (an effect would paint once with the old data).
  const [source, setSource] = useState(comments)
  if (comments !== source) {
    setSource(comments)
    setRows(comments)
  }

  useEffect(() => {
    if (!refocusTable.current) return
    refocusTable.current = false
    if (focusStayedIn(null)) table.current?.focus()
  }, [source])

  function replace(updated: AdminComment) {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
  }

  // Rows currently shown that have left the filter (hidden under the visible tab, deleted under the hidden tab, ...). Under "all" no row can leave.
  const left = statusFilter === null ? 0 : rows.filter((row) => row.status !== statusFilter).length

  const th = 'py-2.5 text-[13px] font-medium text-slate-500'

  return (
    <>
      <table ref={table} tabIndex={-1} className={`w-full table-fixed border-collapse text-left text-sm ${FOCUS_RING}`}>
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-slate-200">
          <tr>
            {/* Less important columns hide progressively as the screen narrows; what they say goes on a secondary line under the content. */}
            <th scope="col" className={`${th} pr-4`}>
              {t('comment')}
            </th>
            <th scope="col" className={`${th} hidden w-40 pr-4 md:table-cell`}>
              {t('author')}
            </th>
            <th scope="col" className={`${th} hidden w-44 pr-4 xl:table-cell`}>
              {t('post')}
            </th>
            <th scope="col" className={`${th} hidden w-32 pr-4 xl:table-cell`}>
              {t('date')}
            </th>
            <th scope="col" className={`${th} hidden w-24 pr-4 sm:table-cell`}>
              {t('status')}
            </th>
            <th scope="col" className={`${th} w-24 text-right`}>
              {t('actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((comment, index) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              first={index === 0}
              postFilterHref={postFilterHrefs?.[comment.postId] ?? null}
              onHide={onHide}
              onRestore={onRestore}
              onDelete={onDelete}
              onChanged={replace}
              announce={setNotice}
            />
          ))}
        </tbody>
      </table>
      {/* Always present: a live region must exist before its content changes for the change to be announced. */}
      <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
        {notice !== null && t.rich(`notice.${notice.kind}`, { name: notice.name, bdi: (chunks) => <bdi>{chunks}</bdi> })}
      </p>
      {left > 0 && (
        <StaleListNotice
          count={left}
          unit="comment"
          onReload={() => {
            refocusTable.current = true
          }}
        />
      )}
    </>
  )
}

/** Where focus must go after the next render of the row; null leaves it alone. */
type FocusTarget = 'hide' | 'restore' | 'delete' | 'cancel' | 'row' | null

function CommentRow({
  comment,
  first,
  postFilterHref,
  onHide,
  onRestore,
  onDelete,
  onChanged,
  announce,
}: Omit<CommentModerationProps, 'comments' | 'caption' | 'statusFilter' | 'postFilterHrefs'> & {
  comment: AdminComment
  first: boolean
  /** "Only this post's comments"; null means no link. */
  postFilterHref: string | null
  onChanged: (comment: AdminComment) => void
  announce: (notice: Notice | null) => void
}) {
  const t = useTranslations('Admin.comments.table')
  const tStatuses = useTranslations('Admin.statuses')
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const action = useRowAction('Comment moderation')
  const cell = useRef<HTMLTableCellElement>(null)
  const hideButton = useRef<HTMLButtonElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmGroup = useRef<HTMLDivElement>(null)
  // Remember the KIND of target, not the element: the button to focus (e.g. unhide after hiding) only exists after the next
  // render, i.e. in the effect below, the same way as in TopicManager.
  const focusNext = useRef<FocusTarget>(null)

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    const element = {
      hide: hideButton,
      restore: restoreButton,
      delete: deleteButton,
      cancel: cancelButton,
      row: cell,
    }[target].current
    element?.focus()
  }, [comment.status, confirming])

  const name = comment.authorDisplayName
  const target = t('target', { name, excerpt: excerpt(comment.content) })
  const look = commentStatusLook(comment.status, tStatuses)
  const contentId = `${id}-content`
  const promptId = `${id}-prompt`
  const long = comment.content.length > LONG_CHARS || comment.content.split('\n').length > LONG_LINES

  function moderate(kind: 'hide' | 'restore', origin: HTMLButtonElement) {
    announce(null)
    void action.run(
      () => (kind === 'hide' ? onHide : onRestore)(comment.id),
      (updated) => {
        if (updated === null) return
        // The button just pressed vanishes with the old status; the button taking its place is the undo button.
        if (updated.status !== comment.status && focusStayedIn(origin)) {
          focusNext.current = kind === 'hide' ? 'restore' : 'hide'
        }
        onChanged(updated)
        announce({ kind, name })
      },
    )
  }

  function openConfirm() {
    if (action.busy()) return
    action.setError(null)
    focusNext.current = 'cancel'
    setConfirming(true)
  }

  function cancel() {
    if (action.busy()) return
    action.setError(null)
    focusNext.current = 'delete'
    setConfirming(false)
  }

  function remove() {
    announce(null)
    void action.run(
      () => onDelete(comment.id),
      () => {
        // A deleted comment's row has no buttons left: focus goes to the row itself, where the deleted label is.
        if (focusStayedIn(confirmGroup.current)) focusNext.current = 'row'
        setConfirming(false)
        onChanged({ ...comment, status: 'DELETED' })
        announce({ kind: 'delete', name })
      },
    )
  }

  const busy = action.pending || undefined

  return (
    <>
      <tr
        className={`align-top transition-colors duration-150 motion-reduce:transition-none hover:bg-slate-50/70 ${
          first ? '' : 'border-t border-slate-100'
        }`}
      >
        <td ref={cell} tabIndex={-1} className="py-4 pr-4 focus-visible:outline-2 focus-visible:-outline-offset-2 outline-brand">
          {comment.reply && (
            <span className="mb-1.5 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 text-[12px] leading-5 font-medium text-slate-600">
              {t('reply')}
            </span>
          )}
          {/* Plain React text, never HTML or markdown: `<script>` in the comment is just text. */}
          <p
            id={contentId}
            className={`whitespace-pre-wrap text-sm leading-6 text-slate-900 [overflow-wrap:anywhere] ${
              expanded ? '' : 'line-clamp-3'
            }`}
          >
            {comment.content}
          </p>
          {long && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={() => setExpanded((open) => !open)}
              className={`mt-1 rounded-sm text-[13px] font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 hover:decoration-slate-900 ${FOCUS_RING}`}
            >
              {/* Name it like the row buttons: each long comment gets its own name, not ten buttons all named
                  like the show-full button. Whitespace OUTSIDE the sr-only span. */}
              {expanded ? t('collapse') : t('expand')} <span className="sr-only">{target}</span>
            </button>
          )}
          <RowMeta comment={comment} postFilterHref={postFilterHref} />
        </td>
        <td className="hidden py-4 pr-4 md:table-cell">
          <Author comment={comment} />
        </td>
        <td className="hidden py-4 pr-4 xl:table-cell">
          <PostLink comment={comment} />
          {postFilterHref !== null && (
            <span className={`mt-1 block ${META}`}>
              <PostFilterLink comment={comment} href={postFilterHref} />
            </span>
          )}
        </td>
        <td className="hidden py-4 pr-4 text-slate-600 xl:table-cell">
          <CommentDate iso={comment.createdAt} />
        </td>
        <td className="hidden py-4 pr-4 sm:table-cell">
          <ToneBadge label={look.label} tone={look.tone} />
        </td>
        <td className="py-3 text-right">
          {!confirming && comment.status !== 'DELETED' && (
            <div className="flex flex-col items-end gap-1">
              {comment.status === 'VISIBLE' && (
                <button
                  ref={hideButton}
                  type="button"
                  aria-disabled={busy}
                  onClick={(event) => moderate('hide', event.currentTarget)}
                  className={ROW_BUTTON}
                >
                  {/* Whitespace OUTSIDE the span, and the rest of the name in ONE sr-only span: Chrome
                      inserts whitespace around each sr-only span, so splitting the name into several spans breaks the name. */}
                  {t('hide')} <span className="sr-only">{target}</span>
                </button>
              )}
              {comment.status === 'HIDDEN' && (
                <button
                  ref={restoreButton}
                  type="button"
                  aria-disabled={busy}
                  onClick={(event) => moderate('restore', event.currentTarget)}
                  className={ROW_BUTTON}
                >
                  {t('restore')} <span className="sr-only">{target}</span>
                </button>
              )}
              <button ref={deleteButton} type="button" aria-disabled={busy} onClick={openConfirm} className={ROW_DANGER}>
                {t('delete')} <span className="sr-only">{target}</span>
              </button>
            </div>
          )}
        </td>
      </tr>

      {confirming && (
        <tr>
          <td colSpan={COLUMNS} className="pb-4">
            <div
              ref={confirmGroup}
              role="group"
              aria-labelledby={promptId}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                cancel()
              }}
              className="rounded-lg border border-red-200 bg-red-50/60 p-4"
            >
              <p id={promptId} className="text-[13px] leading-5 text-red-900">
                {t.rich('confirmDelete', { strong: (chunks) => <strong className="font-semibold">{chunks}</strong> })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {/* Focus the cancel button first: a second Enter on the same spot must cancel, not delete. */}
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={remove}
                  className={button('dangerSolid', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
                >
                  <Trash2Icon />
                  {action.pending ? t('deleting') : t('delete')}
                </button>
                <button
                  ref={cancelButton}
                  type="button"
                  aria-disabled={busy}
                  onClick={cancel}
                  className={button('secondary', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
                >
                  {t('cancel')}
                </button>
              </div>
              {action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
            </div>
          </td>
        </tr>
      )}

      {/* Hide / unhide failed: error sentence right under the row, focus stays on the button just pressed for a retry. */}
      {!confirming && action.error !== null && (
        <tr>
          <td colSpan={COLUMNS} className="pb-4">
            <ErrorAlert>{action.error}</ErrorAlert>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Secondary line under the content: what the columns hidden on narrow screens would show (status below sm, author below md,
 * post and date below xl), so a phone loses nothing; and "edited" at every screen size.
 */
function RowMeta({ comment, postFilterHref }: { comment: AdminComment; postFilterHref: string | null }) {
  const t = useTranslations('Admin.comments.table')
  const tStatuses = useTranslations('Admin.statuses')
  const look = commentStatusLook(comment.status, tStatuses)
  const edited = comment.editedAt !== null
  return (
    <p className={`${META} mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 ${edited ? '' : 'xl:hidden'}`}>
      <ToneBadge label={look.label} tone={look.tone} className="sm:hidden" />
      <span className="[overflow-wrap:anywhere] md:hidden">
        <AuthorName comment={comment} className="font-medium text-slate-700" />
        {comment.authorGithubLogin !== null ? ` @${comment.authorGithubLogin}` : null}
        {comment.authorStatus === 'SUSPENDED' ? (
          <span className="text-red-700"> · {tStatuses(USER_STATUS.SUSPENDED.labelKey)}</span>
        ) : null}
      </span>
      <span className="xl:hidden">{t.rich('onPost', { post: () => <PostLink comment={comment} /> })}</span>
      {postFilterHref !== null && (
        <span className="xl:hidden">
          <PostFilterLink comment={comment} href={postFilterHref} />
        </span>
      )}
      <span className="xl:hidden">
        <CommentDate iso={comment.createdAt} />
      </span>
      {edited && <span>{t('edited')}</span>}
    </p>
  )
}

/**
 * The Users page, searching for exactly this author: a shortcut to suspending a reader who spams. Searches
 * by GitHub login (unique), or by display name when there is no login. Only for readers (USER): the Users
 * page can only suspend readers, so a link to an admin account would be a dead end.
 */
function usersHref(comment: AdminComment): string | null {
  if (comment.authorRole !== 'USER') return null
  return `/admin/users?${new URLSearchParams({ q: comment.authorGithubLogin ?? comment.authorDisplayName })}`
}

/** The author name, in <bdi> (a right-to-left name does not reorder the text around it); a link when there is a page to go to. */
function AuthorName({ comment, className }: { comment: AdminComment; className: string }) {
  const t = useTranslations('Admin.comments.table')
  const href = usersHref(comment)
  const name = <bdi className={className}>{comment.authorDisplayName}</bdi>
  if (href === null) return name
  return (
    // prefetch is off on both links of the row: twenty rows would be forty prefetches of a page rarely opened.
    <Link
      href={href}
      prefetch={false}
      className={`rounded-sm underline decoration-slate-300 underline-offset-4 hover:decoration-slate-900 ${FOCUS_RING}`}
    >
      {/* Whitespace OUTSIDE the sr-only span: accessible name is the person's name followed by a see-on-the-Users-page suffix. */}
      {name} <span className="sr-only">{t('usersPageSr')}</span>
    </Link>
  )
}

/**
 * "Only this post's comments": the per-post filtered list of the row, keeping the current status tab.
 * The accessible name carries the post title: twenty links with the same text are twenty links that cannot be told apart.
 */
function PostFilterLink({ comment, href }: { comment: AdminComment; href: string }) {
  const t = useTranslations('Admin.comments.table')
  return (
    <Link
      href={href}
      prefetch={false}
      className={`rounded-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 hover:decoration-slate-900 ${FOCUS_RING}`}
    >
      {t('onlyThisPost')} <span className="sr-only">{t('onlyThisPostSr', { title: comment.postTitle })}</span>
    </Link>
  )
}

function Author({ comment }: { comment: AdminComment }) {
  const tStatuses = useTranslations('Admin.statuses')
  return (
    <div className="flex items-start gap-2.5">
      <Avatar name={comment.authorDisplayName} src={comment.authorAvatarUrl} size={28} className="mt-0.5" />
      <div className="min-w-0">
        <AuthorName comment={comment} className="block font-medium text-slate-900 [overflow-wrap:anywhere]" />
        {/* An account with only a password and no GitHub login: never "@null". */}
        {comment.authorGithubLogin !== null && (
          <span className={`block ${META} [overflow-wrap:anywhere]`}>@{comment.authorGithubLogin}</span>
        )}
        {/* Same text as the status labels on the Users page (statuses.ts). */}
        {comment.authorStatus === 'SUSPENDED' && (
          <span className="block text-[13px] leading-5 text-red-700">{tStatuses(USER_STATUS.SUSPENDED.labelKey)}</span>
        )}
      </div>
    </div>
  )
}

const POST_LINK = `rounded-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-4 [overflow-wrap:anywhere] hover:decoration-slate-900 ${FOCUS_RING}`

/**
 * The comment's post, the related-post link, always opens in a new tab so the list
 * being filtered stays intact. Published: goes to the post's comments section (`#binh-luan`). Unpublished (draft,
 * removed): the public link is a 404, so the post opens in the admin editor, with its status; moderation
 * can still be done on the comment of a removed post.
 */
function PostLink({ comment }: { comment: AdminComment }) {
  const t = useTranslations('Admin.comments.table')
  const tStatuses = useTranslations('Admin.statuses')
  const locale = asLocale(useLocale())
  if (comment.postStatus !== 'PUBLISHED') {
    return (
      <a
        href={`/admin/posts/${encodeURIComponent(comment.postId)}/edit`}
        target="_blank"
        rel="noopener noreferrer"
        className={POST_LINK}
      >
        {comment.postTitle}{' '}
        <span className="font-normal text-slate-500">
          {t('postNotPublished', { status: lowerCase(postStatusLabel(comment.postStatus, tStatuses), locale) })}
        </span>{' '}
        <span className="sr-only">{t('newTabSr')}</span>
      </a>
    )
  }
  return (
    <a
      href={`/posts/${encodeURIComponent(comment.postSlug)}#binh-luan`}
      target="_blank"
      rel="noopener noreferrer"
      className={POST_LINK}
    >
      {/* Whitespace OUTSIDE the span: the accessible name trims leading/trailing whitespace of each child element. */}
      {comment.postTitle} <span className="sr-only">{t('viewCommentsSr')}</span>
    </a>
  )
}

/** Publish date in UTC (lib/date.ts), like every date of the site; an unreadable value prints nothing. */
function CommentDate({ iso }: { iso: string }) {
  const locale = asLocale(useLocale())
  const text = formatDate(iso, 'medium', locale)
  return text === null ? null : <time dateTime={iso}>{text}</time>
}
