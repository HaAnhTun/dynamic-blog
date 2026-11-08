'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { StarIcon, Trash2Icon } from '@/components/icons'
import { ErrorAlert } from './primitives'
import { usePostList, type BulkOutcome, type ListPost } from './PostListActions'
import { button } from './ui'
import { focusStayedIn, useRowAction } from './useRowAction'

/**
 * The small button of a row: 13px text, borderless (a table of twenty rows with a hundred bordered buttons is noise),
 * 28px tall — still above the 24px minimum for fingers (WCAG 2.5.8). Faded with a wait cursor while pending.
 */
const ROW_ACTION =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[13px] font-medium text-slate-600 transition-colors duration-150 motion-reduce:transition-none hover:bg-slate-100 hover:text-slate-900 aria-disabled:cursor-wait aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand'

const ROW_DANGER = `${ROW_ACTION} text-red-700 hover:bg-red-50 hover:text-red-800`

/** Same path as the bulk bar: one id, the right translated sentence and the right cache. */
function outcomeFor(id: string, result: Exclude<BulkOutcome, { error: string }>): 'done' | 'skipped' | string {
  if (result.done.includes(id)) return 'done'
  if (result.skipped.includes(id)) return 'skipped'
  return result.failed.find((failure) => failure.id === id)?.error ?? 'skipped'
}

/**
 * Actions right on a row of the post list: preview, ZIP download, publish or unpublish, toggle
 * featured, delete — so there is no need to open the editor just to do one thing. Every accessible name carries the post title
 * in ONE sr-only span (Chrome inserts whitespace around each sr-only span, so splitting the name into several
 * spans breaks the name): twenty delete buttons with the same name are twenty buttons that cannot be told apart.
 *
 * Publish/unpublish and delete go through exactly the bulk actions (with one id), featured goes through the action of the
 * featured posts screen. The result goes to the list's shared notification line (PostListActions); errors sit right under the row.
 *
 * Focus: publish/unpublish and featured are ONE button that changes its text (or `aria-pressed`) with the new status, so
 * focus stays there when the server redraws. A row that moves (sorting by recently edited) makes the browser drop focus: it is put
 * back on that very button. A row that vanishes (deleted, or leaving the filter being viewed): PostListActions moves focus to the
 * notification line.
 */
export default function PostRowActions({ post }: { post: ListPost }) {
  const t = useTranslations('Admin.posts.row')
  const { author, onSetPublished, onDelete, onFeature, onUnfeature, announce, expectRemoval } = usePostList()
  const id = useId()
  const action = useRowAction('Post row action')
  const [confirming, setConfirming] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const publishButton = useRef<HTMLButtonElement>(null)
  const featureButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  // The button needing focus after the next render (remember the KIND of button, like TopicManager: the button exists once the render is done).
  const focusNext = useRef<'delete' | 'cancel' | null>(null)
  // The button pressed whose status the server will redraw as new; see the status effect below.
  const awaiting = useRef<'publish' | 'feature' | null>(null)

  const published = post.status === 'PUBLISHED'
  const quoted = `“${post.title}”`

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    ;(target === 'delete' ? deleteButton : cancelButton).current?.focus()
  })

  // The new status arrives from the server: the same button, new text. Only when focus has fallen back to <body> (the row just moved);
  // someone who Tabbed elsewhere while waiting is left alone.
  useEffect(() => {
    const target = awaiting.current
    if (target === null) return
    awaiting.current = null
    if (focusStayedIn(null)) (target === 'publish' ? publishButton : featureButton).current?.focus()
  }, [post.status, post.featured])

  /** Runs an action that may make the row leave the page or move; `false` from `apply` means "nothing changed". */
  async function perform(
    kind: 'publish' | 'feature' | 'delete',
    call: () => Promise<BulkOutcome | { id: string } | { error: string }>,
    apply: (result: BulkOutcome | { id: string }) => boolean,
  ) {
    if (action.busy()) return
    announce('')
    expectRemoval([post.id])
    if (kind !== 'delete') awaiting.current = kind
    let changed = false
    await action.run(call, (result) => {
      if (result !== null) changed = apply(result)
    })
    if (!changed) {
      expectRemoval(false)
      awaiting.current = null
    }
  }

  function togglePublished() {
    void perform(
      'publish',
      () => onSetPublished([post.id], !published),
      (result) => {
        if (!('done' in result)) return false
        const outcome = outcomeFor(post.id, result)
        if (outcome === 'done') announce(t(published ? 'announceUnpublished' : 'announcePublished', { title: quoted }))
        else if (outcome === 'skipped') announce(t(published ? 'skippedUnpublished' : 'skippedPublished', { title: quoted }))
        else action.setError(outcome)
        return outcome === 'done'
      },
    )
  }

  function toggleFeatured() {
    if (onFeature === undefined || onUnfeature === undefined) return
    void perform(
      'feature',
      () => (post.featured ? onUnfeature(post.id) : onFeature(post.id)),
      () => {
        announce(t(post.featured ? 'announceUnfeatured' : 'announceFeatured', { title: quoted }))
        return true
      },
    )
  }

  function remove() {
    void perform(
      'delete',
      () => onDelete([post.id]),
      (result) => {
        if (!('done' in result)) return false
        const outcome = outcomeFor(post.id, result)
        if (outcome === 'done' || outcome === 'skipped') {
          announce(t(outcome === 'done' ? 'announceDeleted' : 'announceDeletedElsewhere', { title: quoted }))
          // The row is about to vanish when the server redraws (refresh after it was deleted elsewhere): do not redraw the buttons.
          setDeleted(true)
          return true
        }
        action.setError(outcome)
        // While pending the delete button keeps focus (aria-disabled); on failure focus goes to cancel, Shift+Tab is retry.
        focusNext.current = 'cancel'
        return false
      },
    )
  }

  function closeConfirm() {
    if (action.busy()) return
    action.setError(null)
    focusNext.current = 'delete'
    setConfirming(false)
  }

  if (deleted) return null

  const busy = action.pending || undefined
  const promptId = `${id}-prompt`

  return (
    <div className="mt-1.5">
      {!confirming && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {/* prefetch off: twenty preview links on a page are twenty prefetches of a loading skeleton. */}
          <Link href={`/admin/posts/${encodeURIComponent(post.id)}/preview`} prefetch={false} className={ROW_ACTION}>
            {/* Whitespace OUTSIDE the span, and the rest of the name in ONE sr-only span. */}
            {t('preview')} <span className="sr-only">{quoted}</span>
          </Link>
          {/* A plain <a> tag, `download`: the route returns an attachment, not a page to navigate to. */}
          <a href={`/admin/posts/${encodeURIComponent(post.id)}/export`} download className={ROW_ACTION}>
            {t('download')} <span className="sr-only">{quoted}</span>
          </a>
          <button ref={publishButton} type="button" aria-disabled={busy} onClick={togglePublished} className={ROW_ACTION}>
            {published ? t('unpublish') : t('publish')} <span className="sr-only">{quoted}</span>
          </button>
          {onFeature !== undefined && onUnfeature !== undefined && (
            <button
              ref={featureButton}
              type="button"
              aria-pressed={post.featured}
              aria-disabled={busy}
              onClick={toggleFeatured}
              title={post.featured ? t('featuredTitleOn') : t('featuredTitleOff')}
              className={`${ROW_ACTION} ${post.featured ? 'text-amber-800' : ''}`}
            >
              <StarIcon size={14} className={post.featured ? 'fill-current text-amber-600' : 'text-slate-400'} />
              {t('featured')} <span className="sr-only">{quoted}</span>
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
            className={ROW_DANGER}
          >
            {t('delete')} <span className="sr-only">{t('deleteSr', { title: quoted })}</span>
          </button>
        </div>
      )}

      {confirming && (
        <div
          role="group"
          aria-labelledby={promptId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            closeConfirm()
          }}
          className="mt-1 rounded-lg border border-red-200 bg-red-50/60 p-3 sm:p-4"
        >
          {/* The bold question sits in <strong> (inline): the group's name is the whole paragraph, starting with the question. */}
          <p id={promptId} className="text-[13px] leading-5 text-red-900 [overflow-wrap:anywhere]">
            <strong className="font-semibold">{t('confirmQuestion', { title: quoted })}</strong>{' '}
            {published && <>{t('publishedWarning')} </>}
            {author ? t('author.consequences') : t('consequences')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-disabled={busy}
              onClick={remove}
              className={button('dangerSolid', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
            >
              <Trash2Icon />
              {action.pending ? t('deleting') : author ? t('author.confirm') : t('deleteForever')}
            </button>
            <button
              ref={cancelButton}
              type="button"
              aria-disabled={busy}
              onClick={closeConfirm}
              className={button('secondary', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
            >
              {t('cancel')}
            </button>
          </div>
          {action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
        </div>
      )}

      {/* Publish/unpublish or featured failed: error sentence right under the row, focus stays on the button just pressed for a retry. */}
      {!confirming && action.error !== null && <ErrorAlert className="mt-2">{action.error}</ErrorAlert>}
    </div>
  )
}
