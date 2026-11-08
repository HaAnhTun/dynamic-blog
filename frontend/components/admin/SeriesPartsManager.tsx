'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import type { Translator } from '@/i18n/translator'
import { ArrowDownIcon, ArrowUpIcon, LayersIcon, PlusIcon, XIcon } from '@/components/icons'
import { isRedirectError } from './PostEditor'
import { EmptyState, ErrorAlert } from './primitives'
import { HINT, ICON_BUTTON, INPUT, LABEL, LIST, META, STATUS_TEXT, WARN_TEXT, button, postStatusLabel } from './ui'
import { useFocusAfterRemoval } from './useFocusAfterRemoval'

/**
 * One post on the series parts screen: enough to show, order and send the id, nothing more. This list
 * goes to the browser (props, action results), and a full PostSummary has a description, tags and cover image nobody
 * uses here.
 */
export type SeriesPart = {
  id: string
  title: string
  status: string
  /** Name of ANOTHER series the post belongs to, or null. On save the post is moved to this series. */
  otherSeries: string | null
}

/** Result of the save action: the parts the backend saved, in order, or an error to show in place. */
export type PartsOutcome = SeriesPart[] | { error: string }

export type SeriesPartsManagerProps = {
  /** The current parts, by position. */
  parts: SeriesPart[]
  /** Every post not yet in this series (any status): what the add-post box lists. */
  candidates: SeriesPart[]
  onSave: (postIds: string[]) => Promise<PartsOutcome>
}

/** `SeriesPostsRequest.postIds` in the backend is `@Size(max = 100)`. Blocking here keeps the
 *  101st save from coming back as a "list has changed" sentence for the wrong reason. */
const MAX_PARTS = 100

/** Label of an unpublished part (shared table in ui.ts); null when published, since there is nothing to remind. */
function statusLabel(part: SeriesPart, tStatus: Translator): string | null {
  return part.status === 'PUBLISHED' ? null : postStatusLabel(part.status, tStatus)
}

/** Text of one option in the add-post box: the title, then what to know before adding. */
function optionLabel(part: SeriesPart, t: Translator, tStatus: Translator): string {
  const status = statusLabel(part, tStatus)
  return [
    part.title,
    status === null ? null : `(${status.toLowerCase()})`,
    part.otherSeries === null ? null : t('optionOtherSeries', { name: part.otherSeries }),
  ]
    .filter((piece) => piece !== null)
    .join(' ')
}

function isError(result: PartsOutcome): result is { error: string } {
  return !Array.isArray(result)
}

/**
 * The parts of a series: the list in reading order with ↑↓✕, the add-post box, the save-order
 * button.
 *
 * EVERY change (add, remove, swap) stays on screen until the save-order button is pressed, unlike the featured posts
 * screen: series membership has a single write path, PUT replaces the whole list, so
 * one save sends exactly the list being seen. The "unsaved changes" line names the gap between the two,
 * and the save bar turns amber at the same time: even a glance tells the screen differs from the saved data.
 * Saving an unchanged list is still useful: it renumbers 1..n, filling the position holes that a post
 * moved to another series leaves behind.
 */
export default function SeriesPartsManager({ parts, candidates: initialCandidates, onSave }: SeriesPartsManagerProps) {
  const t = useTranslations('Admin.series.parts')
  const tStatus = useTranslations('Admin.statuses')
  const id = useId()
  // State, not read from props: updateTag in the action makes the page re-render, but the new props
  // must not overwrite a list that is half sorted. A successful save applies its own result.
  const [items, setItems] = useState(parts)
  const [candidates, setCandidates] = useState(initialCandidates)
  const [selected, setSelected] = useState('')
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const { containerRef, removing } = useFocusAfterRemoval(items)

  /** A change in place: no server call yet, only tells screen readers what just happened. */
  function change(nextItems: SeriesPart[], nextCandidates: SeriesPart[], message: string) {
    setItems(nextItems)
    setCandidates(nextCandidates)
    setDirty(true)
    setError(null)
    setNotice(message)
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    // Screen-reader users cannot see the row jump: announce the new position.
    change(next, candidates, t('movedTo', { title: next[target].title, position: target + 1 }))
  }

  function remove(part: SeriesPart) {
    // Back to the top of the add-post box with its full label: a mistaken removal can be added back at once, and a post
    // just taken from another series is still in that series until the next save.
    removing(items, part.id)
    change(
      items.filter((item) => item.id !== part.id),
      [part, ...candidates.filter((item) => item.id !== part.id)],
      t('removed', { title: part.title }),
    )
  }

  function add() {
    const part = candidates.find((item) => item.id === selected)
    if (part === undefined || items.length >= MAX_PARTS) return
    setSelected('')
    change(
      [...items.filter((item) => item.id !== part.id), part],
      candidates.filter((item) => item.id !== part.id),
      t('added', { title: part.title }),
    )
  }

  /**
   * Locks every button until the action finishes, then shows the result in place. Catches rejected promises too: throwing
   * from an async handler reaches no error boundary, and the author would see nothing. A redirect error
   * is an expired session, the router is navigating by itself: not an error to show.
   */
  async function save() {
    setError(null)
    setNotice('')
    setPending(true)
    try {
      const result = await onSave(items.map((item) => item.id))
      if (isError(result)) {
        setError(result.error)
        return
      }
      // The list the backend saved, not the list just sent: posts just moved here now
      // belong to this series, so their old series label disappears.
      setItems(result)
      const saved = new Set(result.map((item) => item.id))
      setCandidates((current) => current.filter((item) => !saved.has(item.id)))
      setDirty(false)
      setNotice(t('orderSaved'))
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Series parts action failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  const selectId = `${id}-add`
  const hintId = `${id}-add-hint`
  const full = items.length >= MAX_PARTS

  // Same mold as the featured posts screen (CuratedManager): list, add box, save bar, then the error
  // and the status line. The two admin ordered lists look and behave as one.
  return (
    <div ref={containerRef}>
      {items.length === 0 ? (
        // Focus target when the last part was just removed (focusTarget: data-empty-list, tabIndex -1).
        <EmptyState focusTarget icon={<LayersIcon />} title={t('emptyTitle')}>
          {/* No candidates means the blog has no posts at all: "add from the box below" when that box only says
              "no posts left" would be a dead end. */}
          {candidates.length > 0 ? t('emptyBodyAdd') : t('emptyBodyWriteFirst')}
        </EmptyState>
      ) : (
        <ol aria-label={t('orderLabel')} className={LIST}>
          {items.map((part, index) => {
            const first = index === 0
            const last = index === items.length - 1
            const status = statusLabel(part, tStatus)
            return (
              <li key={part.id} className="flex items-baseline gap-3 px-4 py-3 sm:px-5">
                {/* The ordinal number is for sighted users; <ol> already announces the position to screen readers. It must be the FIRST
                    aria-hidden element of the row: the status dot and the button icon are also aria-hidden,
                    and come after it. A fixed column, right-aligned numbers: 9 and 10 line up. */}
                <span aria-hidden="true" className="w-6 shrink-0 text-right text-sm tabular-nums text-slate-500">
                  {index + 1}
                </span>
                {/* Phone: the button group wraps below the title, aligned with it; from sm it goes to the end of the
                    row. Three 32px buttons next to the title at 320px leave only about 100px for text. */}
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <span data-title className="block text-[15px] font-medium break-words text-slate-900">
                      {part.title}
                    </span>
                    {status !== null && (
                      <span className={`flex items-center gap-1.5 ${WARN_TEXT}`}>
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                        {t('notShown', { status })}
                      </span>
                    )}
                    {part.otherSeries !== null && (
                      <span className={`block ${WARN_TEXT}`}>{t('otherSeriesNote', { name: part.otherSeries })}</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {/* aria-disabled at the first/last position instead of disabled: the button that just moved a part to the top still keeps
                        focus, not falling back to <body> midway while reordering by keyboard. */}
                    <button
                      type="button"
                      disabled={pending}
                      aria-disabled={first ? true : undefined}
                      onClick={() => move(index, -1)}
                      title={t('moveUp')}
                      className={ICON_BUTTON}
                    >
                      <ArrowUpIcon />
                      <span className="sr-only">{t('moveUpLabel', { title: part.title })}</span>
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
                      <span className="sr-only">{t('moveDownLabel', { title: part.title })}</span>
                    </button>
                    {/* Separated from the ↑↓ pair by a gap: missing the down button by a click does not become removing the post. */}
                    <button
                      data-remove-for={part.id}
                      type="button"
                      disabled={pending}
                      onClick={() => remove(part)}
                      title={t('remove')}
                      className={`${ICON_BUTTON} ml-2`}
                    >
                      <XIcon />
                      <span className="sr-only">{t('removeLabel', { title: part.title })}</span>
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {/* Right under the list: an added post appears at the end, exactly where the eye is looking. The select box does not
          need to span the column: a long title is cut off in the closed box, shown in full when opened. */}
      <div className="mt-6 max-w-xl">
        {candidates.length === 0 ? (
          <p className={META}>{t('noCandidates')}</p>
        ) : (
          <>
            <label htmlFor={selectId} className={LABEL}>
              {t('addLabel')}
            </label>
            {/* flex-wrap with a fixed basis: from about 375px the box and button share a row, narrower than that the button
                wraps instead of squeezing the select. min-w-0: the natural width of a <select> is its
                longest option, and a long title would push the whole row to overflow sideways. */}
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
                {candidates.map((part) => (
                  <option key={part.id} value={part.id}>
                    {optionLabel(part, t, tStatus)}
                  </option>
                ))}
              </select>
              <button type="button" disabled={pending || selected === '' || full} onClick={add} className={button('secondary')}>
                <PlusIcon />
                {t('add')}
              </button>
            </div>
            <p id={hintId} className={HINT}>
              {full ? t('fullHint', { max: MAX_PARTS }) : t('addHint')}
            </p>
          </>
        )}
      </div>

      {/* The save bar is always the same frame, only the color changes: a frame appearing when the list changes would push the whole
          bar below the cursor. The amber color does not stand alone, the unsaved-changes line says it
          too. When nothing has changed, that spot reminds of the screen's easiest mistake, right next to the button it is about:
          adding a post is not yet putting the post into the series. */}
      <div
        className={`mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3 transition-colors duration-150 motion-reduce:transition-none sm:px-5 ${
          dirty ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
        }`}
      >
        <button type="button" disabled={pending} onClick={() => void save()} className={button('primary')}>
          {t('save')}
        </button>
        {dirty ? <p className={WARN_TEXT}>{t('unsaved')}</p> : <p className={META}>{t('saveReminder')}</p>}
      </div>

      {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
      {/* Always present: a live region must exist before its content changes for the change to be announced. */}
      <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
        {notice}
      </p>
    </div>
  )
}
