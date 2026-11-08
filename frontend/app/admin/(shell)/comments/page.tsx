import Link from 'next/link'
import { redirect } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import AdminOnly from '@/components/admin/AdminOnly'
import CommentModeration from '@/components/admin/CommentModeration'
import { Pager } from '@/components/admin/Pager'
import { EmptyState, ErrorAlert, PageHeader } from '@/components/admin/primitives'
import { button, FOCUS_RING, INPUT, PAGE, WARN_TEXT } from '@/components/admin/ui'
import { MessageSquareIcon, SearchIcon, XIcon } from '@/components/icons'
import { adminErrorMessage } from '@/lib/admin-action'
import { SessionExpiredError, getAdminPost, listAdminComments } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import { asLocale, lowerCase } from '@/lib/format'
import type { AdminComment, Page } from '@/lib/types'
import { deleteComment, hideComment, restoreComment } from './actions'
import {
  COMMENT_FILTERS,
  COMMENT_PAGE_SIZE,
  DEFAULT_COMMENT_FILTER,
  type CommentListState,
  commentListHref,
  parseCommentFilter,
  parsePage,
  parsePostFilter,
  parseQuery,
  statusOfFilter,
} from './comment-list'

/*
 * The Comments page: every reader comment on every post, newest first, filtered by status, searched by content or author;
 * hide, show again, delete right on the row (CommentModeration). No chart, no bulk actions: a personal blog
 * does not have the moderation volume that would need them.
 *
 * Filtering by one post (`?post=<id>`, the "Post: …" chip, the "Only comments on this post" link on each row),
 * the author's name leading to the Users page, and the default entry is "Visible" (comment-list.ts).
 */

/* The empty list when nothing is being searched: that entry is empty, and why that is normal (`Admin.comments.empty.<filter>`). */

/**
 * The four status filters, as tabs (links, `aria-current` on the chosen entry). Changing the filter keeps the search box and
 * the post filter, back to the first page. No counts: each number is another backend call, for something only
 * occasionally needed.
 *
 * `px-2.5` below sm: four tabs fit one row at 320px (288px of text). `flex-wrap` is only a safety net, for a
 * font that draws wider than computed, so the page never overflows horizontally.
 */
function StatusTabs({ state }: { state: CommentListState }) {
  const t = useTranslations('Admin.comments')
  return (
    <nav aria-label={t('statusNav')} className="border-b border-slate-200">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {COMMENT_FILTERS.map(({ key, labelKey }) => {
          const current = state.status === key
          return (
            <li key={key}>
              <Link
                href={commentListHref({ status: key, query: state.query, post: state.post })}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex h-10 items-center border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3 duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 outline-brand ${
                  current
                    ? 'border-slate-900 text-slate-900'
                    : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                {t(labelKey)}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * The search box, sent by plain GET like the post list: the result is a pasteable URL, Back returns to the previous search.
 * The chosen filter and the post filter go along in hidden fields. `key` is the list URL: Next keeps the page's React tree
 * when only searchParams change, and an already drawn `defaultValue` input keeps the old text after clicking "clear search".
 */
function SearchForm({ state }: { state: CommentListState }) {
  const t = useTranslations('Admin.comments')
  return (
    <form
      key={commentListHref({ ...state, page: undefined })}
      role="search"
      action="/admin/comments"
      method="get"
      className="flex w-full items-center gap-2 lg:w-auto"
    >
      {state.status !== DEFAULT_COMMENT_FILTER && <input type="hidden" name="status" value={state.status} />}
      {state.post && <input type="hidden" name="post" value={state.post} />}
      <div className="relative min-w-0 flex-1 lg:w-72 lg:flex-none">
        <label htmlFor="admin-comment-search" className="sr-only">
          {t('searchLabel')}
        </label>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500" />
        <input
          id="admin-comment-search"
          type="search"
          name="q"
          defaultValue={state.query}
          placeholder={t('searchPlaceholder')}
          className={`${INPUT} h-9 pl-9`}
        />
      </div>
      <button type="submit" className={button('secondary')}>
        {t('search')}
      </button>
    </form>
  )
}

/**
 * Title of the post being filtered by, for the "Post: …" chip and the table caption; null when it cannot be read (the post was just
 * deleted, a transient error): the chip is still there, with a generic name. Never throws — the chip is secondary, the list is
 * the main job; an expired session meets the list call at the same moment and redirects.
 */
async function postTitleOf(id: string): Promise<string | null> {
  try {
    return (await getAdminPost(id)).title
  } catch {
    return null
  }
}

export default async function AdminCommentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const locale = asLocale(await getLocale())
  const t = await getTranslations('Admin.comments')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />
  const params = await searchParams
  const state: CommentListState = {
    status: parseCommentFilter(params.status),
    query: parseQuery(params.q),
    post: parsePostFilter(params.post),
  }
  const post = state.post ?? null
  const requested = parsePage(params.page)

  let result: Page<AdminComment> | null = null
  let fetchedTitle: string | null = null
  let loadError: string | null = null
  try {
    // In parallel: the post title (only when filtering by post) does not wait for the list, and vice versa.
    ;[result, fetchedTitle] = await Promise.all([
      listAdminComments({
        status: statusOfFilter(state.status),
        q: state.query,
        postId: post,
        page: requested,
        size: COMMENT_PAGE_SIZE,
      }),
      post === null ? null : postTitleOf(post),
    ])
  } catch (error) {
    // Expired session: to login (a Server Component cannot set cookies). 403: the account is no longer
    // ADMIN (the token carries an old role). The backend refuses the request itself (other 4xx): a local message, the filter strip and
    // search box intact to change the request — retrying unchanged would fail again. Server error or lost
    // connection: the admin error.tsx, where "Try again" makes sense.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    if (error instanceof ApiError && error.status < 500)
      loadError = adminErrorMessage(error, await getTranslations('Errors.admin'))
    else throw error
  }

  // `?page=` beyond the last page (the list just got shorter, or an old URL): go to the last page instead of a confusing
  // empty page. Outside the try: redirect() throws NEXT_REDIRECT, and the catch above would swallow it.
  if (result !== null && result.items.length === 0 && result.meta.totalPages > 0 && requested >= result.meta.totalPages) {
    redirect(commentListHref({ ...state, page: result.meta.totalPages - 1 }))
  }

  const narrowed = state.query !== ''
  const filterLabel = t(`filters.${state.status}`)
  const filterName = lowerCase(filterLabel, locale)
  // Title: read from the post, else from its own comments (the same post), else the generic name.
  const postTitle = post === null ? null : (fetchedTitle ?? result?.items.find((row) => row.postId === post)?.postTitle ?? null)
  // A backend without the post filter (older than the post filter) ignores `postId` and returns comments of every post: say so,
  // instead of letting the "Post: …" chip claim a filter that does not exist.
  const postFilterIgnored = post !== null && result !== null && result.items.some((row) => row.postId !== post)
  // "Only comments on this post" on each row: keeps the status entry, drops the search box (the search is usually what led to
  // this row; within that post the whole conversation is needed). When already filtering by post there is no link.
  const postFilterHrefs =
    post === null && result !== null
      ? Object.fromEntries(
          result.items.map((row) => [row.postId, commentListHref({ status: state.status, query: '', post: row.postId })]),
        )
      : undefined
  const chipClass = `inline-flex max-w-full items-center gap-1 rounded-full border border-slate-300 bg-white py-0.5 pr-1.5 pl-2.5 text-slate-700 transition-colors duration-150 motion-reduce:transition-none hover:border-slate-400 hover:bg-slate-50 ${FOCUS_RING}`

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('description')} />

      <StatusTabs state={state} />

      <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="shrink-0 text-sm font-medium text-slate-900">
          {/* A space between the two parts: the accessible name concatenates the children text, without it it is "All12 comments". */}
          {narrowed ? t('results') : filterLabel}{' '}
          {result !== null && (
            <span className="ml-1 font-normal text-slate-500">{t('count', { count: result.meta.totalElements })}</span>
          )}
        </h2>
        <SearchForm state={state} />
      </div>

      {(narrowed || post !== null) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-slate-500">{t('chip.label')}</span>
          {post !== null && (
            <Link href={commentListHref({ ...state, post: null, page: undefined })} className={chipClass}>
              {/* A long title wraps inside the chip, not pushing the page into horizontal overflow at 320px. */}
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {postTitle === null ? t('chip.selectedPost') : t('chip.post', { title: postTitle })}
              </span>
              <XIcon size={14} className="text-slate-500" /> <span className="sr-only">{t('chip.removePost')}</span>
            </Link>
          )}
          {narrowed && (
            <Link href={commentListHref({ ...state, query: '', page: undefined })} className={chipClass}>
              {t('chip.query', { query: state.query })}
              <XIcon size={14} className="text-slate-500" />
              {/* A space OUTSIDE the sr-only span: without it, the accessible name is "“spam”(clear this search)". */}{' '}
              <span className="sr-only">{t('chip.removeQuery')}</span>
            </Link>
          )}
        </div>
      )}

      {postFilterIgnored && <p className={`mt-2 ${WARN_TEXT}`}>{t('postFilterIgnored')}</p>}

      <div className="mt-3">
        {result === null ? (
          <ErrorAlert>{loadError}</ErrorAlert>
        ) : result.items.length === 0 ? (
          narrowed ? (
            <EmptyState
              icon={<SearchIcon size={20} />}
              title={t('empty.noMatch')}
              action={
                <Link href={commentListHref({ status: 'all', query: '' })} className={button('secondary')}>
                  {t('empty.viewAll')}
                </Link>
              }
            >
              {t('empty.queryHint', { status: state.status, query: state.query, onPost: post === null ? 'no' : 'yes' })}
            </EmptyState>
          ) : post !== null ? (
            // Filtering by post yet empty: that post has nothing in this entry — not "no comments yet" for the whole site.
            <EmptyState
              icon={<MessageSquareIcon size={20} />}
              title={t('empty.postNone', { filter: filterLabel })}
              action={
                <Link href={commentListHref({ ...state, post: null, page: undefined })} className={button('secondary')}>
                  {t('empty.clearPost')}
                </Link>
              }
            >
              {t('empty.postHint')}
            </EmptyState>
          ) : (
            <EmptyState icon={<MessageSquareIcon size={20} />} title={t(`empty.${state.status}.title`)}>
              {t(`empty.${state.status}.hint`)}
            </EmptyState>
          )
        ) : (
          <CommentModeration
            // Changing the filter, search box, post or page is a different list: rebuild from scratch with the new data, instead
            // of keeping the state of the old list (Next keeps the React tree when only searchParams change).
            key={commentListHref({ ...state, page: result.meta.page })}
            comments={result.items}
            caption={t('caption', {
              filter: filterName,
              onPost: post === null ? 'no' : 'yes',
              postTitle: postTitle ?? t('captionSelectedPost'),
              searched: narrowed ? 'yes' : 'no',
              query: state.query,
              page: result.meta.page + 1,
              totalPages: Math.max(1, result.meta.totalPages),
            })}
            statusFilter={statusOfFilter(state.status)}
            postFilterHrefs={postFilterHrefs}
            onHide={hideComment}
            onRestore={restoreComment}
            onDelete={deleteComment}
          />
        )}
      </div>

      {result !== null && (
        <Pager
          page={result.meta.page}
          totalPages={result.meta.totalPages}
          total={result.meta.totalElements}
          pageSize={COMMENT_PAGE_SIZE}
          unit="comment"
          href={(page) => commentListHref({ ...state, page })}
        />
      )}
    </div>
  )
}
