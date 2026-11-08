'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { ErrorAlert, ToneBadge } from '@/components/admin/primitives'
import { button, CARD, FOCUS_RING, META, STATUS_TEXT } from '@/components/admin/ui'
import { focusStayedIn, useRowAction } from '@/components/admin/useRowAction'
import { Trash2Icon } from '@/components/icons'
import type { Locale } from '@/i18n/config'
import { asLocale, dateFormat } from '@/lib/format'
import type { ContactMessage } from '@/lib/types'

export type ContactInboxProps = {
  /** One page of the inbox, as the backend returns it (newest first). */
  messages: ContactMessage[]
  /** null means done. */
  onMarkRead: (id: string) => Promise<{ error: string } | null>
  /** null means deleted. */
  onDelete: (id: string) => Promise<{ error: string } | null>
}

type Notice = { kind: 'read' | 'delete'; name: string }

const BUSY = 'aria-disabled:cursor-wait aria-disabled:opacity-60'

/**
 * Date and time of arrival, in UTC like every date of the admin (lib/date.ts): the server renders this, and a time of day in the
 * server's zone would differ from machine to machine. The zone is printed, so "09:30" is never ambiguous.
 */
function receivedAt(iso: string, locale: Locale): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return dateFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)
}

/**
 * The address as a mailto target. Encoded, because the local part may hold `?` or `&`, which a mail client would read as
 * the start of another header (`?cc=`); the `@` stays literal.
 */
export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email).replace('%40', '@')}`
}

/**
 * The inbox: one card per message, newest first. Everything the visitor typed is rendered as plain React text
 * (never HTML or Markdown), with their line breaks kept: `<script>` in a message is just text.
 *
 * The result of each action is applied to the card at once (state, initialised from props); the action also revalidates the
 * page, and the new list then replaces this state (`source`, the same "adjust state when a prop changes" pattern as
 * CommentModeration). One `role="status"` region, always present, announces each result.
 */
export default function ContactInbox({ messages, onMarkRead, onDelete }: ContactInboxProps) {
  const t = useTranslations('Admin.contact')
  const [rows, setRows] = useState(messages)
  const [source, setSource] = useState(messages)
  const [notice, setNotice] = useState<Notice | null>(null)
  const status = useRef<HTMLParagraphElement>(null)
  if (messages !== source) {
    setSource(messages)
    setRows(messages)
  }

  return (
    <>
      <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id}>
            <MessageCard
              message={row}
              status={status}
              announce={setNotice}
              onMarkRead={onMarkRead}
              onDelete={onDelete}
              onRead={(id) =>
                setRows((current) =>
                  current.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)),
                )
              }
              onRemoved={(id) => setRows((current) => current.filter((item) => item.id !== id))}
            />
          </li>
        ))}
      </ul>
      {/* Always present: a live region must exist before its content changes for the change to be announced. Focusable, so that
          it can receive focus when the card that held it has just been deleted. */}
      <p ref={status} role="status" tabIndex={-1} className={`mt-3 rounded-sm ${STATUS_TEXT} ${FOCUS_RING}`}>
        {notice !== null && t.rich(`notice.${notice.kind}`, { name: notice.name, bdi: (chunks) => <bdi>{chunks}</bdi> })}
      </p>
    </>
  )
}

function MessageCard({
  message,
  status,
  announce,
  onMarkRead,
  onDelete,
  onRead,
  onRemoved,
}: Pick<ContactInboxProps, 'onMarkRead' | 'onDelete'> & {
  message: ContactMessage
  status: RefObject<HTMLParagraphElement | null>
  announce: (notice: Notice | null) => void
  onRead: (id: string) => void
  onRemoved: (id: string) => void
}) {
  const t = useTranslations('Admin.contact')
  const locale = asLocale(useLocale())
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const action = useRowAction('Contact inbox')
  const card = useRef<HTMLElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmGroup = useRef<HTMLDivElement>(null)
  // Remember the KIND of target: the element to focus (cancel, delete) only exists after the next render.
  const focusNext = useRef<'cancel' | 'delete' | null>(null)

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    ;(target === 'cancel' ? cancelButton : deleteButton).current?.focus()
  }, [confirming])

  const unread = message.readAt === null
  const subject = message.subject !== null && message.subject.trim() !== '' ? message.subject : null
  const received = receivedAt(message.createdAt, locale)
  const target = t('target', { name: message.name })
  const promptId = `${id}-prompt`
  const busy = action.pending || undefined

  function markRead(origin: HTMLButtonElement) {
    announce(null)
    void action.run(
      () => onMarkRead(message.id),
      () => {
        // The pressed button vanishes with the unread state: focus goes to the card, so the keyboard user keeps their place.
        if (focusStayedIn(origin)) card.current?.focus()
        onRead(message.id)
        announce({ kind: 'read', name: message.name })
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
      () => onDelete(message.id),
      () => {
        // The card is about to disappear: focus goes to the status line, which stays.
        if (focusStayedIn(confirmGroup.current)) status.current?.focus()
        announce({ kind: 'delete', name: message.name })
        onRemoved(message.id)
      },
    )
  }

  return (
    <article
      ref={card}
      tabIndex={-1}
      aria-labelledby={`${id}-name`}
      className={`${CARD} p-4 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand sm:p-5 ${
        unread ? 'border-l-4 border-l-slate-900' : ''
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 id={`${id}-name`} className="text-sm font-semibold text-slate-900 [overflow-wrap:anywhere]">
            <bdi>{message.name}</bdi>
          </h3>
          <a
            href={mailtoHref(message.email)}
            className={`rounded-sm text-[13px] leading-5 text-slate-600 underline decoration-slate-300 underline-offset-4 [overflow-wrap:anywhere] hover:text-slate-900 hover:decoration-slate-900 ${FOCUS_RING}`}
          >
            {message.email}
          </a>
        </div>
        <p className={`${META} flex flex-wrap items-center gap-x-3`}>
          {unread && <ToneBadge label={t('unreadBadge')} tone="text-amber-700" />}
          {received !== null && <time dateTime={message.createdAt}>{received}</time>}
          {message.locale !== null && <span>{t('pageLanguage', { locale: message.locale.toUpperCase() })}</span>}
        </p>
      </header>

      <p className="mt-3 text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">
        {subject ?? <span className="font-normal text-slate-500">{t('noSubject')}</span>}
      </p>
      {/* Plain React text: never HTML or Markdown. `pre-wrap` keeps the visitor's line breaks. */}
      <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-slate-800 [overflow-wrap:anywhere]">{message.message}</p>

      {!confirming && (
        <div className="mt-4 flex flex-wrap gap-2">
          {unread && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={(event) => markRead(event.currentTarget)}
              className={button('secondary', 'sm', BUSY)}
            >
              {/* Whitespace OUTSIDE the sr-only span, and the rest of the name in ONE span (Chrome splits names across several). */}
              {t('markRead')} <span className="sr-only">{target}</span>
            </button>
          )}
          <button
            ref={deleteButton}
            type="button"
            aria-disabled={busy}
            onClick={openConfirm}
            className={button('danger', 'sm', BUSY)}
          >
            {t('delete')} <span className="sr-only">{target}</span>
          </button>
        </div>
      )}

      {confirming && (
        <div
          ref={confirmGroup}
          role="group"
          aria-labelledby={promptId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            cancel()
          }}
          className="mt-4 rounded-lg border border-red-200 bg-red-50/60 p-4"
        >
          <p id={promptId} className="text-[13px] leading-5 text-red-900">
            {t.rich('confirmDelete', { strong: (chunks) => <strong className="font-semibold">{chunks}</strong> })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" aria-disabled={busy} onClick={remove} className={button('dangerSolid', 'sm', BUSY)}>
              <Trash2Icon />
              {action.pending ? t('deleting') : t('delete')}
            </button>
            {/* Focused first: a second Enter on the same spot cancels, it does not delete. */}
            <button
              ref={cancelButton}
              type="button"
              aria-disabled={busy}
              onClick={cancel}
              className={button('secondary', 'sm', BUSY)}
            >
              {t('cancel')}
            </button>
          </div>
          {action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
        </div>
      )}

      {/* Mark as read failed: the sentence right under the buttons, focus stays on the button for a retry. */}
      {!confirming && action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
    </article>
  )
}
