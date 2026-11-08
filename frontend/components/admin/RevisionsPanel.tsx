'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { formatDate } from '@/lib/date'
import { asLocale } from '@/lib/format'
import { formatLocalDateTime } from '@/lib/local-time'
import type { PostRevision, PostRevisionSummary } from '@/lib/types'
import type { ActionError, RevisionOutcome } from './editor-types'
import { isRedirectError } from './redirect-error'
import { button, FOCUS_RING, HINT, LABEL, META } from './ui'

export type RevisionsPanelProps = {
  /** Newest first, at most 20; null when the history could not be loaded. */
  revisions: PostRevisionSummary[] | null
  /** There are unsaved changes: do not restore (restoring rebuilds the editor, and the text being edited would be lost). */
  dirty: boolean
  /** The editor is saving, publishing or unpublishing. */
  busy: boolean
  onLoad: (revisionId: string) => Promise<RevisionOutcome>
  /** On success the action navigates (the editor reopens); it only returns on error. */
  onRestore: (revisionId: string) => Promise<ActionError>
  /** An error returned by an action: the editor shows it in the shared error box, with a login link when the session has expired. */
  report: (outcome: ActionError) => void
  /** The action promise was rejected and it was not a navigation. */
  failed: (caught: unknown) => void
}

function subscribeNever(): () => void {
  return () => {}
}

/**
 * The history section in the settings column: the versions the backend keeps by itself whenever a save changes the title, description or
 * content (at least 10 minutes apart, the 20 most recent). View a version (raw text, read-only), then restore it.
 *
 * Restore can only be pressed when there are no unsaved changes, and goes through an in-place confirmation step. The backend records
 * the current text as a version before restoring, so the confirmation sentence can say "you can still go back". On success
 * the action navigates (`?restored=`) and the editor is rebuilt with the restored post.
 *
 * The time of each version follows the writer's clock, so it only exists after hydration (lib/local-time.ts is
 * client-side): the server HTML carries the date in UTC, like every other admin date, then it is replaced by a value like "14:30,
 * 08/10/2026". The server/client snapshot of useSyncExternalStore is how React does that without an HTML mismatch.
 */
export default function RevisionsPanel({ revisions, dirty, busy, onLoad, onRestore, report, failed }: RevisionsPanelProps) {
  const t = useTranslations('Admin.revisions')
  const locale = asLocale(useLocale())
  const id = useId()
  const headingId = `${id}-heading`
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Record<string, PostRevision>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  // Only restore focus after the confirmation has been opened at least once, not when the page has just loaded.
  const asked = useRef(false)

  useEffect(() => {
    if (confirming) {
      asked.current = true
      cancel.current?.focus()
    } else if (asked.current) {
      restoreButton.current?.focus()
    }
  }, [confirming])

  function timeOf(revision: PostRevisionSummary): string {
    return (
      (hydrated ? formatLocalDateTime(revision.createdAt) : formatDate(revision.createdAt, 'medium', locale)) ??
      revision.createdAt
    )
  }

  async function toggle(revisionId: string) {
    setConfirming(false)
    if (openId === revisionId) {
      setOpenId(null)
      return
    }
    setOpenId(revisionId)
    if (loaded[revisionId] !== undefined) return
    setLoadingId(revisionId)
    try {
      const result = await onLoad(revisionId)
      if ('error' in result) {
        report(result)
        setOpenId((now) => (now === revisionId ? null : now))
        return
      }
      setLoaded((now) => ({ ...now, [revisionId]: result.revision }))
    } catch (caught) {
      if (!isRedirectError(caught)) failed(caught)
      setOpenId((now) => (now === revisionId ? null : now))
    } finally {
      setLoadingId(null)
    }
  }

  async function restore(revisionId: string) {
    setRestoring(true)
    try {
      report(await onRestore(revisionId))
    } catch (caught) {
      // Navigating counts as success: keep the button locked until the new editor takes its place, no second click allowed.
      if (isRedirectError(caught)) return
      failed(caught)
    }
    setRestoring(false)
    setConfirming(false)
  }

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={LABEL}>
        {t('heading')}
      </h3>

      {revisions === null ? (
        <p className="text-[13px] leading-5 text-slate-600">{t('loadFailed')}</p>
      ) : revisions.length === 0 ? (
        <p className="text-[13px] leading-5 text-slate-600">{t('empty')}</p>
      ) : (
        <ol className="divide-y divide-slate-200/70">
          {revisions.map((revision) => {
            const time = timeOf(revision)
            const open = openId === revision.id
            const detailId = `${id}-detail-${revision.id}`
            const full = loaded[revision.id]
            return (
              <li key={revision.id} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-slate-800">{revision.title}</p>
                    <p className={META}>
                      <time dateTime={revision.createdAt}>{time}</time>
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={open ? detailId : undefined}
                    aria-label={t('viewAria', { time })}
                    onClick={() => void toggle(revision.id)}
                    className={button('ghost', 'sm', open ? 'bg-slate-200/70 px-2 text-slate-900' : 'px-2')}
                  >
                    {t('view')}
                  </button>
                </div>

                {open && (
                  <div id={detailId} className="mt-2 rounded-md border border-slate-200 bg-white p-3">
                    {loadingId === revision.id || full === undefined ? (
                      <p className={META}>{t('loading')}</p>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-slate-900">{full.title}</p>
                        {full.excerpt !== null && full.excerpt.trim() !== '' && (
                          <p className="mt-1 text-[13px] leading-5 text-slate-600">{full.excerpt}</p>
                        )}
                        {/* Raw text, read-only, scrollable by keyboard (a named region that receives focus). */}
                        <pre
                          role="region"
                          aria-label={t('textRegionAria', { time })}
                          tabIndex={0}
                          className={`mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap text-slate-700 ${FOCUS_RING}`}
                        >
                          {full.content}
                        </pre>

                        {confirming ? (
                          // The group name is the question, the explanation is the description.
                          <div
                            role="group"
                            aria-labelledby={`${detailId}-question`}
                            aria-describedby={`${detailId}-details`}
                            className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3"
                          >
                            <p className="text-[13px] leading-5 text-amber-900">
                              <strong id={`${detailId}-question`} className="font-semibold">
                                {t('restoreQuestion', { time })}
                              </strong>{' '}
                              <span id={`${detailId}-details`}>{t('restoreDetails')}</span>
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={restoring}
                                onClick={() => void restore(revision.id)}
                                className={button('primary', 'sm')}
                              >
                                {restoring ? t('restoring') : t('restore')}
                              </button>
                              <button
                                ref={cancel}
                                type="button"
                                disabled={restoring}
                                onClick={() => setConfirming(false)}
                                className={button('secondary', 'sm')}
                              >
                                {t('cancel')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3">
                            <button
                              ref={restoreButton}
                              type="button"
                              disabled={dirty || busy}
                              aria-describedby={dirty ? `${detailId}-locked` : undefined}
                              onClick={() => setConfirming(true)}
                              className={button('secondary', 'sm')}
                            >
                              {t('restoreThis')}
                            </button>
                            {dirty && (
                              <p id={`${detailId}-locked`} className={HINT}>
                                {t('dirtyHint')}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
