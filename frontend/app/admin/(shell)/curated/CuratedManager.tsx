'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { isRedirectError } from '@/components/admin/PostEditor'
import { EmptyState, ErrorAlert } from '@/components/admin/primitives'
import {
  button,
  HINT,
  ICON_BUTTON,
  INPUT,
  LABEL,
  LIST,
  META,
  postStatusLabel,
  STATUS_TEXT,
  WARN_TEXT,
} from '@/components/admin/ui'
import { useFocusAfterRemoval } from '@/components/admin/useFocusAfterRemoval'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, StarIcon, XIcon } from '@/components/icons'
import { type CuratedPost, newestFirst } from './curated'

type Outcome<T> = T | { error: string }

export type CuratedManagerProps = {
  /** The picked posts, in the current public order (any status). */
  featured: CuratedPost[]
  /** Published posts not yet picked, newest first: what "Add post" lists. */
  candidates: CuratedPost[]
  onSave: (postIds: string[]) => Promise<Outcome<CuratedPost[]>>
  onFeature: (postId: string) => Promise<Outcome<CuratedPost>>
  onUnfeature: (postId: string) => Promise<Outcome<CuratedPost>>
}

/** Number of posts the home page takes from the top of the list: POSTS_ON_HOME in app/(site)/page.tsx. */
const HOME_SLOTS = 3

function isError<T>(result: Outcome<T>): result is { error: string } {
  return typeof result === 'object' && result !== null && !Array.isArray(result) && 'error' in result
}

/**
 * The posts the home page shows: the first three PUBLISHED posts, not the first three rows. The home page asks the
 * public API, where drafts are absent, so a draft in second place takes no slot. Computed over
 * the on-screen order: while a reorder is half done, the label shows the home page AFTER saving, and the save bar
 * says plainly it is not saved yet.
 */
function homeIds(items: CuratedPost[]): Set<string> {
  return new Set(
    items
      .filter((post) => post.status === 'PUBLISHED')
      .slice(0, HOME_SLOTS)
      .map((post) => post.id),
  )
}

/**
 * The "Best posts" screen: the picked list by rank with ↑↓,
 * "Remove from Best posts", "Add post", "Save order".
 *
 * Two kinds of action, on purpose: add and remove take effect AT ONCE (feature/unfeature per post, since
 * the ordering command never unpicks a post), while ↑↓ only reorders on screen until
 * "Save order" is pressed (one command that replaces the whole rank list). The line "Unsaved order." names the
 * gap between the two.
 *
 * The layout follows the path of the task: the list, the add box right below it (adding makes the
 * list longer), then the save bar that fixes the order. Feedback (errors, status line) sits below the save bar: appearing
 * there does not push the "Save order" button away from where the pointer is.
 */
export default function CuratedManager({
  featured,
  candidates: initialCandidates,
  onSave,
  onFeature,
  onUnfeature,
}: CuratedManagerProps) {
  const t = useTranslations('Admin.curated')
  const tStatus = useTranslations('Admin.statuses')
  const id = useId()
  // State, not read from props: updateTag in the action makes the page re-render, but the new props
  // must not overwrite an order that is half sorted. Each saved change is applied from the action result.
  const [items, setItems] = useState(featured)
  const [candidates, setCandidates] = useState(initialCandidates)
  const [selected, setSelected] = useState('')
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const { containerRef, removing } = useFocusAfterRemoval(items)

  /**
   * Locks every button until the action finishes, then shows the result in place. Also catches a rejected promise:
   * a throw from an async handler reaches no error boundary, and the author would see nothing. A
   * redirect error is an expired session, the router is navigating on its own: not an error to show.
   */
  async function run<T>(action: () => Promise<Outcome<T>>, apply: (value: T) => string) {
    setError(null)
    setNotice('')
    setPending(true)
    try {
      const result = await action()
      if (isError(result)) {
        setError(result.error)
        return
      }
      setNotice(apply(result))
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Curated action failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    setItems(next)
    setDirty(true)
    setError(null)
    // Screen reader users do not see the row jump: say the new position.
    setNotice(t('movedTo', { title: next[target].title, position: target + 1 }))
  }

  function save() {
    void run(
      () => onSave(items.map((post) => post.id)),
      (saved) => {
        // The list the backend saved, not the list just sent: it includes posts picked elsewhere
        // while this screen was open. Such a post leaves the "Add post" box.
        setItems(saved)
        const chosen = new Set(saved.map((post) => post.id))
        setCandidates((current) => current.filter((post) => !chosen.has(post.id)))
        setDirty(false)
        return t('orderSaved')
      },
    )
  }

  function add() {
    if (selected === '') return
    void run(
      () => onFeature(selected),
      (added) => {
        setItems((current) => [...current.filter((post) => post.id !== added.id), added])
        setCandidates((current) => current.filter((post) => post.id !== added.id))
        setSelected('')
        return t('added', { title: added.title })
      },
    )
  }

  function remove(post: CuratedPost) {
    void run(
      () => onUnfeature(post.id),
      (removed) => {
        // Only on success: if removing fails the row is still there.
        removing(items, removed.id)
        setItems((current) => current.filter((item) => item.id !== removed.id))
        // Only a published post returns to the "Add post" box, in the right place by publish date.
        if (removed.status === 'PUBLISHED') {
          setCandidates((current) => [...current.filter((item) => item.id !== removed.id), removed].sort(newestFirst))
        }
        return t('removed', { title: removed.title })
      },
    )
  }

  const selectId = `${id}-add`
  const hintId = `${id}-add-hint`
  const onHome = homeIds(items)

  return (
    <div ref={containerRef}>
      {items.length === 0 ? (
        // Focus target when the last row has just been removed (focusTarget: data-empty-list, tabIndex -1).
        <EmptyState focusTarget icon={<StarIcon />} title={t('emptyTitle')}>
          {/* No candidate means no published post exists: "add from the box below" while that box
                        only says "no posts left" is a dead end. */}
          {candidates.length > 0 ? t('emptyBodyAdd') : t('emptyBodyPublishFirst')}
        </EmptyState>
      ) : (
        <ol aria-label={t('orderLabel')} className={LIST}>
          {items.map((post, index) => {
            const first = index === 0
            const last = index === items.length - 1
            const published = post.status === 'PUBLISHED'
            return (
              <li key={post.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                <div className="flex min-w-0 flex-1 items-baseline gap-3">
                  {/* The ordinal is for the eye; the <ol> already announces the position to screen readers. It must be the FIRST aria-hidden
                                        element of the row: the status dot and the button icons are also
                                        aria-hidden, and come after it. Fixed column, right-aligned number: 9 and 10 line up. */}
                  <span aria-hidden="true" className="w-6 shrink-0 text-right text-sm tabular-nums text-slate-500">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <span data-title className="block text-[15px] font-medium break-words text-slate-900">
                      {post.title}
                    </span>
                    {/* In words, not only colour: how the first three posts differ from the rest. */}
                    {onHome.has(post.id) && <span className={`block ${META}`}>{t('onHome')}</span>}
                    {!published && (
                      <span className={`flex items-center gap-1.5 ${WARN_TEXT}`}>
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                        {t('notShown', { status: postStatusLabel(post.status, tStatus) })}
                      </span>
                    )}
                  </div>
                </div>
                {/* On phones the buttons wrap to their own line, indented by the number column (w-6 + gap-3) to
                                    line up with the title; from sm they sit at the end of the row. */}
                <div className="flex shrink-0 items-center gap-1 pl-9 sm:pl-0">
                  {/* aria-disabled at the first/last position instead of disabled: the button that just moved a post to the top
                                        keeps focus, which does not fall back to <body> midway through a keyboard reorder. */}
                  <button
                    type="button"
                    disabled={pending}
                    aria-disabled={first ? true : undefined}
                    onClick={() => move(index, -1)}
                    title={t('moveUp')}
                    className={ICON_BUTTON}
                  >
                    <ArrowUpIcon />
                    <span className="sr-only">{t('moveUpLabel', { title: post.title })}</span>
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    aria-disabled={last ? true : undefined}
                    onClick={() => move(index, 1)}
                    title={t('moveDown')}
                    className={ICON_BUTTON}
                  >
                    <ArrowDownIcon />
                    <span className="sr-only">{t('moveDownLabel', { title: post.title })}</span>
                  </button>
                  {/* Set apart from the ↑↓ pair: ↑↓ wait for "Save order", while remove takes effect at once. */}
                  <button
                    data-remove-for={post.id}
                    type="button"
                    disabled={pending}
                    onClick={() => remove(post)}
                    title={t('remove')}
                    className={`${ICON_BUTTON} ml-2`}
                  >
                    <XIcon />
                    <span className="sr-only">{t('removeLabel', { title: post.title })}</span>
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {/* The picker does not need the full page width: a long title is cut in the closed box, full when open. */}
      <div className="mt-6 max-w-xl">
        {candidates.length === 0 ? (
          <p className={META}>{t('noCandidates')}</p>
        ) : (
          <>
            <label htmlFor={selectId} className={LABEL}>
              {t('addLabel')}
            </label>
            {/* flex-wrap with a fixed basis: from about 375px the box and the button share a row, narrower and
                            the button wraps instead of squeezing the picker. */}
            <div className="flex flex-wrap items-center gap-2">
              <select
                id={selectId}
                value={selected}
                disabled={pending}
                aria-describedby={hintId}
                onChange={(event) => setSelected(event.target.value)}
                className={`${INPUT} min-w-0 grow basis-60`}
              >
                <option value="">{t('pickPlaceholder')}</option>
                {candidates.map((post) => (
                  <option key={post.id} value={post.id}>
                    {post.title}
                  </option>
                ))}
              </select>
              <button type="button" disabled={pending || selected === ''} onClick={add} className={button('secondary')}>
                <PlusIcon />
                {t('add')}
              </button>
            </div>
            <p id={hintId} className={HINT}>
              {t('addHint')}
            </p>
          </>
        )}
      </div>

      {/* The save bar is always the same frame, only the colour changes: a frame appearing when the order changes would push the whole
                bar below the pointer. The amber colour does not stand alone, the line "Unsaved order." says it.
                When nothing changed, that spot reminds of the screen's easiest mistake, right beside the button it is about; when
                the list is empty, it says why the button is dimmed. */}
      <div
        className={`mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 transition-colors duration-150 motion-reduce:transition-none sm:px-5 ${
          dirty ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
        }`}
      >
        <button type="button" disabled={pending || items.length === 0} onClick={save} className={button('primary')}>
          {t('save')}
        </button>
        {dirty ? (
          <p className={WARN_TEXT}>{t('unsaved')}</p>
        ) : (
          <p className={META}>{items.length === 0 ? t('nothingToSort') : t('saveReminder')}</p>
        )}
      </div>

      {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
      {/* Always present: a live region must exist before its content changes for it to be read aloud. */}
      <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
        {notice}
      </p>
    </div>
  )
}
