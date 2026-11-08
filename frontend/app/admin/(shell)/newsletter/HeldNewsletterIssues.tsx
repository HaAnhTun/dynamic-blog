'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { type RefObject, useId, useRef, useState } from 'react'
import { ErrorAlert, ToneBadge } from '@/components/admin/primitives'
import { button, CARD, FOCUS_RING, META, STATUS_TEXT } from '@/components/admin/ui'
import { focusStayedIn, useRowAction } from '@/components/admin/useRowAction'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { isLocale } from '@/i18n/config'
import { formatDate } from '@/lib/date'
import { asLocale } from '@/lib/format'
import type { HeldNewsletterIssue } from '@/lib/types'

export type HeldNewsletterIssuesProps = {
  /** The held newsletters, oldest first, as the backend returns them. */
  issues: HeldNewsletterIssue[]
  /** The version is the one of the card (what the administrator reads): null means done. */
  onRelease: (postId: string, version: string) => Promise<{ error: string } | null>
  /** null means done. */
  onDiscard: (postId: string) => Promise<{ error: string } | null>
}

type Notice = { kind: 'released' | 'discarded'; title: string }

const BUSY = 'aria-disabled:cursor-wait aria-disabled:opacity-60'

/**
 * The newsletters that wait for an administrator: one card per post that an author published for the first time, with what
 * subscribers would read (title and excerpt as plain React text), who wrote it, and how many confirmed subscribers of its
 * language would get it. Release sends it, and only the text that is on the card (its version goes back with the click: a post that
 * changed since the page loaded is refused and the card then shows the new text); discard keeps a record and never sends it (asked twice, in place). The result of each
 * action is applied to the list at once and the action revalidates the page; one `role="status"` region announces each result.
 */
export default function HeldNewsletterIssues({ issues, onRelease, onDiscard }: HeldNewsletterIssuesProps) {
  const t = useTranslations('Admin.newsletter.held')
  const [rows, setRows] = useState(issues)
  const [source, setSource] = useState(issues)
  const [notice, setNotice] = useState<Notice | null>(null)
  const status = useRef<HTMLParagraphElement>(null)
  if (issues !== source) {
    setSource(issues)
    setRows(issues)
  }

  return (
    <>
      <ul aria-label={t('listLabel')} className="mt-3 flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.postId}>
            <IssueCard
              issue={row}
              status={status}
              announce={setNotice}
              onRelease={onRelease}
              onDiscard={onDiscard}
              onDecided={(id) => setRows((current) => current.filter((item) => item.postId !== id))}
            />
          </li>
        ))}
      </ul>
      {/* Always present: a live region must exist before its content changes for the change to be announced. */}
      <p ref={status} role="status" tabIndex={-1} className={`mt-3 rounded-sm ${STATUS_TEXT} ${FOCUS_RING}`}>
        {notice !== null && t.rich(`notice.${notice.kind}`, { title: notice.title, bdi: (chunks) => <bdi>{chunks}</bdi> })}
      </p>
    </>
  )
}

function IssueCard({
  issue,
  status,
  announce,
  onRelease,
  onDiscard,
  onDecided,
}: Pick<HeldNewsletterIssuesProps, 'onRelease' | 'onDiscard'> & {
  issue: HeldNewsletterIssue
  status: RefObject<HTMLParagraphElement | null>
  announce: (notice: Notice | null) => void
  onDecided: (postId: string) => void
}) {
  const t = useTranslations('Admin.newsletter.held')
  const locale = asLocale(useLocale())
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const action = useRowAction('Held newsletter')
  const group = useRef<HTMLDivElement>(null)
  const busy = action.pending || undefined
  const held = formatDate(issue.heldAt, 'medium', locale)
  const target = t('target', { title: issue.title })
  const language = isLocale(issue.language) ? LANGUAGE_NAMES[issue.language] : issue.language.toUpperCase()

  function decide(call: () => Promise<{ error: string } | null>, kind: Notice['kind']) {
    announce(null)
    void action.run(call, () => {
      // The card is about to disappear: focus goes to the status line, which stays.
      if (focusStayedIn(group.current)) status.current?.focus()
      announce({ kind, title: issue.title })
      onDecided(issue.postId)
    })
  }

  return (
    <article aria-labelledby={`${id}-title`} className={`${CARD} p-4 sm:p-5`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={`${id}-title`} className="min-w-0 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">
          <Link
            href={`/admin/posts/${encodeURIComponent(issue.postId)}/edit`}
            className={`rounded-sm hover:underline hover:underline-offset-4 ${FOCUS_RING}`}
          >
            <bdi>{issue.title}</bdi>
          </Link>
        </h3>
        <p className={`${META} flex flex-wrap items-center gap-x-3`}>
          {!issue.published && <ToneBadge label={t('unpublished')} tone="text-amber-700" />}
          {held !== null && <time dateTime={issue.heldAt}>{held}</time>}
        </p>
      </header>

      <p className={`mt-1 ${META}`}>
        {issue.authorName !== null ? t('by', { name: issue.authorName }) : t('noAuthor')} · {t('language', { language })} ·{' '}
        {t('recipients', { count: issue.recipients })}
      </p>
      {!issue.published && <p className="mt-2 text-[13px] leading-5 text-amber-700">{t('notPublished')}</p>}

      {/* Plain React text: never HTML or Markdown. `pre-wrap` keeps the author's line breaks. */}
      <p className="mt-3 text-sm leading-6 whitespace-pre-wrap text-slate-800 [overflow-wrap:anywhere]">
        {issue.excerpt ?? <span className="text-slate-500">{t('noExcerpt')}</span>}
      </p>

      {!confirming && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (action.busy()) return
              decide(() => onRelease(issue.postId, issue.version), 'released')
            }}
            className={button('primary', 'sm', BUSY)}
          >
            {action.pending ? t('releasing') : t('release')} <span className="sr-only">{target}</span>
          </button>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (action.busy()) return
              action.setError(null)
              setConfirming(true)
            }}
            className={button('danger', 'sm', BUSY)}
          >
            {t('discard')} <span className="sr-only">{target}</span>
          </button>
        </div>
      )}

      {confirming && (
        <div
          ref={group}
          role="group"
          aria-labelledby={`${id}-prompt`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || action.busy()) return
            event.preventDefault()
            setConfirming(false)
          }}
          className="mt-4 rounded-lg border border-red-200 bg-red-50/60 p-4"
        >
          <p id={`${id}-prompt`} className="text-[13px] leading-5 text-red-900">
            {t('confirmDiscard')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (action.busy()) return
                decide(() => onDiscard(issue.postId), 'discarded')
              }}
              className={button('dangerSolid', 'sm', BUSY)}
            >
              {action.pending ? t('discarding') : t('discard')}
            </button>
            {/* Autofocus-free on purpose: the keyboard user lands on Cancel through the order of the buttons. */}
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (action.busy()) return
                action.setError(null)
                setConfirming(false)
              }}
              className={button('secondary', 'sm', BUSY)}
            >
              {t('keep')}
            </button>
          </div>
        </div>
      )}

      {action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
    </article>
  )
}
