'use client'

import { useTranslations } from 'next-intl'
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Trash2Icon } from '@/components/icons'
import type { Translator } from '@/i18n/translator'
import { ErrorAlert } from './primitives'
import { button, CHECKBOX, STATUS_TEXT } from './ui'
import { focusStayedIn, useRowAction } from './useRowAction'

/*
 * Select several posts and run bulk actions on the post list.
 *
 * The table is still drawn on the server (thumbnails, SVG cover art, dates do not reach the browser as JS); only
 * the cells that need state are client islands: the checkbox of each row, the "select whole page" box at the table head, the
 * action bar and the buttons of each row (PostRowActions). They meet through the context of PostListActions,
 * the component wrapping the table.
 *
 * After each successful action, the action calls updateTag and Next redraws the page in the same response: the new list
 * (new status, deleted rows gone) arrives through the `posts` prop, with no client-side copy to keep in sync.
 * Only the selection, the notification sentence and focus belong to the client.
 */

/** One post of the page being viewed: enough to know which action can change which post, and to write the notification sentence. */
export type ListPost = { id: string; title: string; status: string; featured: boolean }

/** Result of a bulk action (posts/actions.ts): changed, already like that before, could not be done. */
export type BulkResult = { done: string[]; skipped: string[]; failed: { id: string; error: string }[] }
export type BulkOutcome = BulkResult | { error: string }

/** Result of the featured-posts action (curated/actions.ts): the post as the backend saved it, or an error sentence. */
export type FeatureOutcome = { id: string } | { error: string }

export type PostListActionHandlers = {
  /** Publish (`true`) or unpublish the whole group; at most 20 posts at a time. */
  onSetPublished: (ids: string[], published: boolean) => Promise<BulkOutcome>
  /** Delete the whole group for good; at most 20 posts at a time. */
  onDelete: (ids: string[]) => Promise<BulkOutcome>
  /** Featured posts is an ADMIN job: if the page does not pass these two actions, the row has no such button. */
  onFeature?: (id: string) => Promise<FeatureOutcome>
  onUnfeature?: (id: string) => Promise<FeatureOutcome>
}

export type BulkKind = 'publish' | 'unpublish' | 'delete'

type PostListContext = PostListActionHandlers & {
  /** The viewer is an AUTHOR: their delete only hides a post, and the confirmations say so. */
  author: boolean
  posts: ListPost[]
  selected: ReadonlySet<string>
  toggle: (id: string, on: boolean) => void
  setAll: (on: boolean) => void
  deselect: (ids: readonly string[]) => void
  /** Says the result in the list's shared notification line (`role="status"`). */
  announce: (message: string) => void
  /**
   * Call RIGHT BEFORE an action that may make the rows of `ids` leave the page (delete; publish or unpublish while
   * filtering by status): when the new list arrives and those rows are gone, focus — which fell back to <body> with the
   * button just pressed — goes to the notification line. Only considered at the next list change; `false` cancels (the action failed).
   */
  expectRemoval: (ids: readonly string[] | false) => void
  selectAllRef: RefObject<HTMLInputElement | null>
}

const Context = createContext<PostListContext | null>(null)

export function usePostList(): PostListContext {
  const value = useContext(Context)
  if (value === null) throw new Error('usePostList: must be used inside <PostListActions>')
  return value
}

/** The title of post `id` on this page, for the failed-posts list; an unknown id (already left the page) prints the id itself. */
function titleOf(posts: readonly ListPost[], id: string): string {
  return posts.find((post) => post.id === id)?.title ?? id
}

/**
 * The sentence of the notification line after a bulk action. With failed posts it reads like "published 1/2 posts." (counted over those
 * that had to change, not those already like that); the reason for each post is in the error box below.
 * `t` is the `Admin.posts.list` translator.
 */
export function bulkSummary(kind: BulkKind, result: BulkResult, t: Translator): string {
  const parts: string[] = []
  const done = result.done.length
  const failed = result.failed.length
  if (done > 0) {
    parts.push(failed > 0 ? t(`donePartial.${kind}`, { done, total: done + failed }) : t(`doneAll.${kind}`, { count: done }))
  }
  if (result.skipped.length > 0) parts.push(t(`skipped.${kind}`, { count: result.skipped.length }))
  return parts.join(' ')
}

/**
 * Wraps the table of the list page: keeps the selection, the notification line and the bulk action bar (drawn right
 * above the table), and passes the handlers (Server Actions the page passes in) to every island in the table.
 *
 * The page sets `key` to the list URL: Next keeps the React tree when only the query changes, but the selection and the notification sentence
 * of one list must not live on into another list. After an action, the page redraws at the SAME URL,
 * so the selection stays intact: only posts still on the page are counted.
 */
export default function PostListActions({
  posts,
  author,
  children,
  ...handlers
}: PostListActionHandlers & { posts: ListPost[]; author: boolean; children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [message, setMessage] = useState('')
  const status = useRef<HTMLParagraphElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const removal = useRef<readonly string[] | null>(null)

  // A new list from the server (after updateTag): a row just deleted or just out of the filter vanished together with the button that
  // held focus. Only move focus when it really fell back to <body>: someone who Tabbed elsewhere is left alone.
  useEffect(() => {
    const ids = removal.current
    if (ids === null) return
    removal.current = null
    const gone = ids.every((id) => !posts.some((post) => post.id === id))
    if (gone && focusStayedIn(null)) status.current?.focus()
  }, [posts])

  const value: PostListContext = {
    ...handlers,
    author,
    posts,
    selected,
    toggle: (id, on) =>
      setSelected((current) => {
        const next = new Set(current)
        if (on) next.add(id)
        else next.delete(id)
        return next
      }),
    setAll: (on) => setSelected(on ? new Set(posts.map((post) => post.id)) : new Set()),
    deselect: (ids) =>
      setSelected((current) => {
        const next = new Set(current)
        for (const id of ids) next.delete(id)
        return next
      }),
    announce: setMessage,
    expectRemoval: (ids) => {
      removal.current = ids === false ? null : ids
    },
    selectAllRef,
  }

  return (
    <Context.Provider value={value}>
      <BulkBar status={status} />
      {/* Always present and never display:none: a live region must be in the accessibility tree before its
          content changes for the change to be announced. Empty means height 0. It receives focus (tabIndex -1) when the button just pressed
          vanishes, so the result sentence is read and Tab continues from here. */}
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className={`${STATUS_TEXT} rounded-sm [&:not(:empty)]:mb-3 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand`}
      >
        {message}
      </p>
      {children}
    </Context.Provider>
  )
}

/**
 * The "select whole page" box at the head of the selection column: on selects every post of this page (at most 20, exactly the limit of
 * one action), off clears all. Indeterminate (`indeterminate`) when only part is selected.
 */
export function SelectAllCheckbox() {
  const t = useTranslations('Admin.posts.list')
  const { posts, selected, setAll, selectAllRef } = usePostList()
  const count = posts.filter((post) => selected.has(post.id)).length
  const all = posts.length > 0 && count === posts.length
  const some = count > 0 && !all

  // `indeterminate` has no HTML attribute: it can only be set through the DOM.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = some
  }, [some, selectAllRef])

  return (
    <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center">
      <input
        ref={selectAllRef}
        type="checkbox"
        checked={all}
        disabled={posts.length === 0}
        onChange={(event) => setAll(event.target.checked)}
        aria-label={t('selectAllAria', { count: posts.length })}
        className={CHECKBOX}
      />
    </label>
  )
}

/** The checkbox of a row. A 32px click area (wrapping label): a 16px box is too small for a finger. */
export function RowCheckbox({ id, title }: { id: string; title: string }) {
  const t = useTranslations('Admin.posts.list')
  const { selected, toggle } = usePostList()
  return (
    <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        checked={selected.has(id)}
        onChange={(event) => toggle(id, event.target.checked)}
        aria-label={t('selectRowAria', { title })}
        className={CHECKBOX}
      />
    </label>
  )
}

/**
 * The action bar for the selected posts, right above the table; only shown when posts are selected. Each button says
 * how many posts it will change and only sends the posts that really change: publish only drafts, unpublish only published posts —
 * unpublishing a draft is a 422 in the backend, and a button that reports success without changing anything is lying.
 *
 * Delete is for good, so there is an in-place confirmation step like DeletePost: it states the post count, each post title, which post
 * is published and will become a 404. Focus goes to cancel: another Enter on the same spot must cancel, not delete.
 */
function BulkBar({ status }: { status: RefObject<HTMLParagraphElement | null> }) {
  const { posts, author, selected, deselect, setAll, announce, expectRemoval, selectAllRef, onSetPublished, onDelete } =
    usePostList()
  const t = useTranslations('Admin.posts.list')
  const id = useId()
  const action = useRowAction('Bulk post action')
  const [confirming, setConfirming] = useState(false)
  const [failures, setFailures] = useState<{ kind: BulkKind; items: { title: string; error: string }[] } | null>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  // Where focus must go after the next render: the button needing it only exists (or has just vanished) once the render is done.
  const focusNext = useRef<'cancel' | 'delete' | 'status' | 'select-all' | null>(null)

  const chosen = posts.filter((post) => selected.has(post.id))
  const toPublish = chosen.filter((post) => post.status !== 'PUBLISHED')
  const toUnpublish = chosen.filter((post) => post.status === 'PUBLISHED')
  const published = toUnpublish.length

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    if (target === 'cancel') cancelButton.current?.focus()
    else if (target === 'delete') deleteButton.current?.focus()
    else if (target === 'select-all') selectAllRef.current?.focus()
    // After an action: the button just pressed may have vanished along with the bar (no post is selected any more).
    else if (focusStayedIn(null)) status.current?.focus()
  })

  async function run(kind: BulkKind, ids: string[]) {
    if (action.busy() || ids.length === 0) return
    announce('')
    setFailures(null)
    // Deleting makes the row vanish; publishing or unpublishing while filtering by status makes the row leave the filter.
    expectRemoval(ids)
    let changed = false
    await action.run(
      () => (kind === 'delete' ? onDelete(ids) : onSetPublished(ids, kind === 'publish')),
      (result) => {
        if (result === null) return
        changed = result.done.length > 0
        // A post that changed (or was already like that) leaves the selection; a failed post stays to be retried.
        deselect([...result.done, ...result.skipped])
        announce(bulkSummary(kind, result, t))
        setFailures(
          result.failed.length === 0
            ? null
            : { kind, items: result.failed.map((failure) => ({ title: titleOf(posts, failure.id), error: failure.error })) },
        )
        if (kind === 'delete') setConfirming(false)
        focusNext.current = 'status'
      },
    )
    // When no post changed the server does not redraw (the action does not call updateTag): wait for nothing more.
    if (!changed) expectRemoval(false)
  }

  if (chosen.length === 0 && !confirming && failures === null && action.error === null) return null

  const promptId = `${id}-prompt`
  const countId = `${id}-count`
  const ROW_BUTTON = 'aria-disabled:cursor-wait aria-disabled:opacity-60'
  const busy = action.pending || undefined

  return (
    <div className="mb-3 space-y-3">
      {chosen.length > 0 && !confirming && (
        <div
          role="group"
          aria-labelledby={countId}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
        >
          <p id={countId} className="mr-auto text-[13px] font-medium text-slate-800">
            {t('selected', { count: chosen.length })}
          </p>
          {toPublish.length > 0 && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() =>
                void run(
                  'publish',
                  toPublish.map((post) => post.id),
                )
              }
              className={button('secondary', 'sm', ROW_BUTTON)}
            >
              {t('publishN', { count: toPublish.length })}
            </button>
          )}
          {toUnpublish.length > 0 && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() =>
                void run(
                  'unpublish',
                  toUnpublish.map((post) => post.id),
                )
              }
              className={button('secondary', 'sm', ROW_BUTTON)}
            >
              {t('unpublishN', { count: toUnpublish.length })}
            </button>
          )}
          <button
            ref={deleteButton}
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (action.busy()) return
              action.setError(null)
              focusNext.current = 'cancel'
              setConfirming(true)
            }}
            className={button('danger', 'sm', ROW_BUTTON)}
          >
            <Trash2Icon />
            {t('deleteN', { count: chosen.length })}
          </button>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (action.busy()) return
              setAll(false)
              setFailures(null)
              action.setError(null)
              focusNext.current = 'select-all'
            }}
            className={button('ghost', 'sm', ROW_BUTTON)}
          >
            {t('clearSelection')}
          </button>
        </div>
      )}

      {confirming && (
        <div
          role="group"
          aria-labelledby={promptId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || action.busy()) return
            event.preventDefault()
            action.setError(null)
            focusNext.current = 'delete'
            setConfirming(false)
          }}
          className="rounded-lg border border-red-200 bg-red-50/60 p-4"
        >
          {/* The bold question in <strong> (inline): the group's name is the whole paragraph, starting with the question. */}
          <p id={promptId} className="text-[13px] leading-5 text-red-900">
            <strong className="font-semibold">
              {t(author ? 'author.confirmQuestion' : 'confirmQuestion', { count: chosen.length })}
            </strong>{' '}
            {published > 0 && <>{t('publishedWarning', { count: published })} </>}
            {author ? t('author.consequences') : t('consequences')}
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] leading-5 text-red-900 [overflow-wrap:anywhere]">
            {chosen.map((post) => (
              <li key={post.id}>{post.title}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-disabled={busy}
              onClick={() =>
                void run(
                  'delete',
                  chosen.map((post) => post.id),
                )
              }
              className={button('dangerSolid', 'sm', ROW_BUTTON)}
            >
              <Trash2Icon />
              {action.pending ? t('deleting') : t(author ? 'author.confirmN' : 'deleteForeverN', { count: chosen.length })}
            </button>
            <button
              ref={cancelButton}
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (action.busy()) return
                action.setError(null)
                focusNext.current = 'delete'
                setConfirming(false)
              }}
              className={button('secondary', 'sm', ROW_BUTTON)}
            >
              {t('cancel')}
            </button>
          </div>
          {action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
        </div>
      )}

      {!confirming && action.error !== null && <ErrorAlert>{action.error}</ErrorAlert>}

      {failures !== null && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-6 text-red-800">
          <p className="font-medium">{t(`failedHeading.${failures.kind}`, { count: failures.items.length })}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 [overflow-wrap:anywhere]">
            {failures.items.map((failure, index) => (
              <li key={index}>{t('failedItem', { title: failure.title, error: failure.error })}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
