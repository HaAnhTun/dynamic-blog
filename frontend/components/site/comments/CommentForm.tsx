'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { COMMENT_MAX_LENGTH, COMMENT_MIN_LENGTH, checkCommentContent, type CommentCheck } from '@/lib/comment-content'
import { asLocale, lowerCase } from '@/lib/format'
import type { Translator } from '@/i18n/translator'
import { FOCUS_RING, TRANSITION } from '../SectionHeading'

/**
 * The box for writing one comment: root comments, replies and edits all use it.
 *
 * - A visible `<label>`, the counter "N/2000" connected through `aria-describedby`. N is the length AFTER sanitizing,
 *   by code point (lib/comment-content.ts, a mirror of `UserText.clean` on the backend): exactly the number the
 *   backend will measure, so the submit button only locks when the content is certain to get a 400 — empty, under 2, over 2000,
 *   or only invisible characters.
 * - A locked submit button comes with a sentence saying why, next to the counter and also in `aria-describedby` (the minimum-2-characters
 *   message; WCAG 3.3.2): a `disabled` button leaves the Tab order, so keyboard users and
 *   screen reader users can never reach it to find out. It exists even when the box is still empty: entering the box you hear the
 *   requirement, before typing.
 * - What is submitted is the sanitized version: the very string the counter just measured, and the very string the backend will store (sanitizing
 *   twice gives the same result).
 * - Submitting: the "sending…" label, `aria-disabled` rather than `disabled` (the button holding focus is not kicked
 *   back to <body>), the textarea read-only (text typed while waiting would be lost when the form clears the text). A second press is dropped
 *   by a ref, without waiting for state.
 * - Error: a sentence chosen by the caller, in `role="alert"`, and the text is kept so it can be fixed and resubmitted.
 * - `onCancel` (reply, edit): the cancel button and the Escape key. While submitting it cannot be cancelled: the request's
 *   result still needs a place to show.
 * - Ctrl+Enter (⌘+Enter on Mac) in the box submits, through the form's `requestSubmit()`: exactly the path
 *   of the submit button, so invalid text and a second submit while waiting are still stopped by `submit()` like a press.
 */

export type SubmitResult = { ok: true } | { ok: false; message: string }

/** The primary button, the same style as the search button of the search page: 40px on a phone (touch target), 36px from sm. */
const PRIMARY = `inline-flex h-11 items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-4 text-sm font-medium text-white enabled:hover:border-brand enabled:hover:bg-brand disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-wait aria-disabled:opacity-70 sm:h-9 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:enabled:hover:border-brand dark:enabled:hover:bg-brand dark:enabled:hover:text-white ${TRANSITION} ${FOCUS_RING}`

/** A secondary button with a border (cancel, retry, load more comments). */
export const SECONDARY = `inline-flex h-11 items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-brand hover:text-brand aria-disabled:cursor-wait aria-disabled:opacity-70 sm:h-9 dark:border-neutral-700 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

/**
 * `text-base`: below 16px Safari on iPhone zooms the page by itself when the box gets focus. `aria-[invalid=true]`
 * is written in the arbitrary form: Tailwind 4 has no built-in `aria-invalid` variant (only busy, checked, disabled…).
 */
const TEXTAREA =
  'mt-2 block w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 read-only:bg-neutral-50 aria-[invalid=true]:border-red-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:read-only:bg-neutral-950 dark:aria-[invalid=true]:border-red-400'

/**
 * Why it cannot be submitted yet, when it is not over 2000 characters (over, the red counter already speaks): under 2 characters — even
 * when the box is empty — or long enough but only non-breaking whitespace (NBSP…). Null when it can be submitted.
 */
function requirementOf(check: CommentCheck, over: boolean, t: Translator): string | null {
  if (check.valid || over) return null
  return check.length < COMMENT_MIN_LENGTH ? t('minLength', { min: COMMENT_MIN_LENGTH }) : t('needsVisibleText')
}

/** The submit shortcut, declared on the writing box (`aria-keyshortcuts`) so screen readers can read it. */
const SUBMIT_SHORTCUTS = 'Control+Enter Meta+Enter'

/**
 * Ctrl+Enter or ⌘+Enter is the submit command. Not when:
 * - Alt is also held: AltGr on Windows is reported as Ctrl+Alt, and Alt+Enter belongs to the operating system;
 * - an input method is composing (Telex, VNI): Enter commits the composition. Safari reports keyCode 229 instead of
 *   `isComposing` on the committing key (like the "/" key of Header);
 * - the key is repeating: holding a key is not another submit.
 * Shift is not blocked: Ctrl+Shift+Enter is still "submit".
 */
function isSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return false
  return !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
}

export function CommentForm({
  label,
  submitLabel,
  pendingLabel,
  initialText = '',
  onSubmit,
  onCancel,
  autoFocus = false,
  clearOnSuccess = false,
  rows = 4,
}: {
  /** The text of the `<label>`: "your comment", "your reply", "edit comment" (site language). */
  label: string
  submitLabel: string
  pendingLabel?: string
  initialText?: string
  /** Receives the sanitized version. Never throws: every outcome is a `SubmitResult`. */
  onSubmit: (text: string) => Promise<SubmitResult>
  onCancel?: () => void
  /** A form opened because the reader pressed something (reply, edit): focus goes to the textarea. The root form does not. */
  autoFocus?: boolean
  /** The root form: clears the text after submitting. Replies and edits close the form right away, so they do not need it. */
  clearOnSuccess?: boolean
  rows?: number
}) {
  const t = useTranslations('Site.comments.form')
  const id = useId()
  const counterId = `${id}-dem`
  const requirementId = `${id}-yeu-cau`
  const errorId = `${id}-loi`
  const locale = asLocale(useLocale())
  const [text, setText] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Block double submits: state only changes on the next render, a ref changes immediately (double click).
  const pending = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const field = textarea.current
    if (!autoFocus || field === null) return
    field.focus()
    // Edit: the cursor goes to the end of the old text, not the start.
    field.setSelectionRange(field.value.length, field.value.length)
  }, [autoFocus])

  const check = checkCommentContent(text)
  const over = check.length > COMMENT_MAX_LENGTH
  const requirement = requirementOf(check, over, t)
  const describedBy = [counterId, requirement !== null ? requirementId : null, error !== null ? errorId : null]
    .filter((part) => part !== null)
    .join(' ')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    const current = checkCommentContent(text)
    if (!current.valid) return
    pending.current = true
    setBusy(true)
    setError(null)
    let result: SubmitResult
    try {
      result = await onSubmit(current.text)
    } finally {
      pending.current = false
      setBusy(false)
    }
    if (!result.ok) setError(result.message)
    else if (clearOnSuccess) setText('')
  }

  function cancel() {
    if (pending.current || onCancel === undefined) return
    onCancel()
  }

  return (
    <form
      noValidate
      // Never a GET, whatever happens before the script runs. In practice this form is not in the server HTML at all (it needs a signed-in
      // session, known only in the browser), and its box has no `name`, so a native submit would carry nothing.
      method="post"
      onSubmit={(event) => {
        void submit(event)
      }}
      onKeyDown={(event) => {
        // Escape while an input method is composing (Telex, VNI on macOS) cancels the composition, not
        // the whole form and all the text already written.
        if (event.key !== 'Escape' || onCancel === undefined || event.nativeEvent.isComposing) return
        event.preventDefault()
        cancel()
      }}
    >
      <label htmlFor={id} className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {label}
      </label>
      <textarea
        ref={textarea}
        id={id}
        rows={rows}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // On the box itself, not on the form: Ctrl+Enter on the cancel button still belongs to that button. preventDefault even when
          // the text is not valid (submit() skips that attempt): the shortcut never types a new line.
          if (!isSubmitShortcut(event)) return
          event.preventDefault()
          event.currentTarget.form?.requestSubmit()
        }}
        readOnly={busy}
        aria-invalid={over || undefined}
        aria-describedby={describedBy}
        aria-keyshortcuts={SUBMIT_SHORTCUTS}
        className={TEXTAREA}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <p
            id={counterId}
            className={`tabular-nums ${over ? 'font-medium text-red-700 dark:text-red-300' : 'text-neutral-500 dark:text-neutral-400'}`}
          >
            {check.length}/{COMMENT_MAX_LENGTH}
          </p>
          {requirement !== null ? (
            <p id={requirementId} className="text-neutral-500 dark:text-neutral-400">
              {requirement}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The shortcut hint, small, next to the button it replaces. Only on devices with a mouse (pointer: fine), where a keyboard
              is almost certain to exist; on a phone it only takes room. Not in aria-describedby: the box already
              declares `aria-keyshortcuts`, and the description of the box is the counter and the requirement. */}
          <p className="hidden text-xs text-neutral-500 pointer-fine:block dark:text-neutral-400">
            {t.rich('shortcutHint', {
              action: lowerCase(submitLabel, locale),
              kbd: (chunks) => <kbd>{chunks}</kbd>,
            })}
          </p>
          <button type="submit" disabled={!check.valid} aria-disabled={busy || undefined} className={PRIMARY}>
            {busy ? (pendingLabel ?? t('pending')) : submitLabel}
          </button>
          {onCancel !== undefined ? (
            <button type="button" onClick={cancel} aria-disabled={busy || undefined} className={SECONDARY}>
              {t('cancel')}
            </button>
          ) : null}
        </div>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </form>
  )
}
