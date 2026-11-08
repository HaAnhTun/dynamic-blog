import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { isRedirectError } from './PostEditor'

/** Result of a Server Action on a row: the new record, null (deleted, 204), or an error sentence. */
export type RowOutcome<T> = T | null | { error: string }

function isFailure<T>(outcome: RowOutcome<T>): outcome is { error: string } {
  return typeof outcome === 'object' && outcome !== null && 'error' in outcome
}

/**
 * An operation on ONE row of an admin table (hide a comment, suspend an account…), shared by
 * CommentModeration and UserTable:
 *
 * - A second click while pending is dropped, even if it arrives before React re-renders: locked by a ref, not
 *   by state. `busy()` lets the row's other handlers (open/cancel confirmation) ask the same lock.
 * - `pending` feeds `aria-disabled`, not `disabled`: a button holding focus that becomes disabled drops focus
 *   to <body>, and the keyboard user has to Tab again from the top of the page.
 * - The action returns `{ error }` → that sentence goes into `error`. The action is rejected (network down midway) → the "cannot
 *   connect" sentence, and the original error goes to the console: throwing from an async handler reaches no error boundary. A
 *   redirect error (expired session, runAdminAction calls redirect) means the router is navigating by itself: not shown.
 */
export function useRowAction(label: string) {
  const t = useTranslations('Errors.admin')
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run<T>(action: () => Promise<RowOutcome<T>>, onSuccess: (result: T | null) => void): Promise<void> {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try {
      const outcome = await action()
      if (isFailure(outcome)) setError(outcome.error)
      else onSuccess(outcome)
    } catch (caught) {
      if (!isRedirectError(caught)) {
        console.error(`${label} failed`, caught)
        setError(t('unreachable'))
      }
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return { pending, error, setError, run, busy: () => lock.current }
}

/**
 * Focus is still where the user just clicked (`origin` contains it; `aria-disabled` kept it there while pending),
 * or has fallen back to <body> because that button vanished. Only then may focus be moved to the new place: someone who Tabbed
 * to something else while waiting is not pulled back.
 */
export function focusStayedIn(origin: Element | null): boolean {
  const active = document.activeElement
  return active === null || active === document.body || (origin !== null && origin.contains(active))
}
