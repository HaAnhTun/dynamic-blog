'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Fragment, type Ref, useEffect, useId, useRef, useState } from 'react'
import { Avatar } from '@/components/site/Avatar'
import { formatDate } from '@/lib/date'
import { asLocale } from '@/lib/format'
import type { AdminAuthorApplication, AuthorApplicant, AuthorApplicationStatus } from '@/lib/types'
import { ErrorAlert, ToneBadge } from './primitives'
import { StaleListNotice } from './StaleListNotice'
import { authorApplicationStatusLook, USER_STATUS } from './statuses'
import { StepUpCodeField } from './StepUpCodeField'
import { button, INPUT, LABEL, LIST, META, STATUS_TEXT } from './ui'
import { focusStayedIn, useRowAction } from './useRowAction'

type Outcome = AdminAuthorApplication | { error: string }

export type AuthorApplicationListProps = {
  /** One page of the list, as the backend returns it (pending applications: oldest first). */
  applications: AdminAuthorApplication[]
  /** Name of the list for screen readers: the current tab and page. */
  label: string
  /** Current tab. Only pending applications have buttons; an application just decided in this tab leaves the filter (StaleListNotice). */
  status: AuthorApplicationStatus
  /** Id of the logged-in user (claim `sub`): nobody approves their own application (backend returns 403). */
  selfId: string | null
  /** `code` is the administrator's own code, sent when the approval makes a reader an author (lib/role-step-up.ts). */
  onApprove: (id: string, code?: string) => Promise<Outcome>
  onReject: (id: string) => Promise<Outcome>
}

const ROW_BUTTON = button('ghost', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')
const ROW_DANGER = button(
  'ghost',
  'sm',
  'text-red-700 hover:bg-red-50 hover:text-red-800 aria-disabled:cursor-wait aria-disabled:opacity-60',
)

type Notice = { kind: 'approved' | 'rejected'; handle: string }

/** How the applicant is referred to, as on the Users page: "@login", or the display name when there is none. */
function handleOf(applicant: AuthorApplicant): string {
  return applicant.githubLogin !== null ? `@${applicant.githubLogin}` : applicant.displayName
}

/** Same rule as RoleChangePanel: NFC, collapsed whitespace, one leading "@" removed. */
function clean(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/^@/, '')
}

/** The login is compared case-insensitively, like GitHub itself; the display name must match letter for letter. */
function confirms(typed: string, applicant: AuthorApplicant): boolean {
  const value = clean(typed)
  if (value === '') return false
  return applicant.githubLogin !== null
    ? value.toLowerCase() === applicant.githubLogin.toLowerCase()
    : value === clean(applicant.displayName)
}

/**
 * List of the Author applications page: applicant, reason (plain text), date; approve and reject buttons
 * right on the row of a pending application.
 *
 * Approving is a privilege promotion, so the login must be retyped (the display name when there is none), as when changing a role;
 * rejecting only needs in-place confirmation. The result is applied straight to the row like UserTable: the action does not updateTag,
 * the row just decided stays in place with its new label (not undoable, so no button is left), and StaleListNotice offers a reload.
 */
export default function AuthorApplicationList({
  applications,
  label,
  status,
  selfId,
  onApprove,
  onReject,
}: AuthorApplicationListProps) {
  const t = useTranslations('Admin.applications.list')
  const [rows, setRows] = useState(applications)
  const [notice, setNotice] = useState<Notice | null>(null)
  const list = useRef<HTMLUListElement>(null)
  // After the reload-list button: if focus fell back to <body> with that button, move it to the list (see UserTable).
  const refocusList = useRef(false)
  // A fresh list from the server with the same `key` (router.refresh()): the new data wins, as in UserTable.
  const [source, setSource] = useState(applications)
  if (applications !== source) {
    setSource(applications)
    setRows(applications)
  }

  useEffect(() => {
    if (!refocusList.current) return
    refocusList.current = false
    if (focusStayedIn(null)) list.current?.focus()
  }, [source])

  function replace(updated: AdminAuthorApplication) {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
  }

  const left = rows.filter((row) => row.status !== status).length

  return (
    <>
      <ul
        ref={list}
        tabIndex={-1}
        aria-label={label}
        className={`${LIST} focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand`}
      >
        {rows.map((application) => (
          <ApplicationRow
            key={application.id}
            application={application}
            self={selfId !== null && application.applicant.id === selfId}
            onApprove={onApprove}
            onReject={onReject}
            onChanged={replace}
            announce={setNotice}
          />
        ))}
      </ul>
      {/* Always present: a live region must exist before its content changes for the change to be announced. */}
      <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
        {notice !== null && t.rich(`notice.${notice.kind}`, { handle: notice.handle, bdi: (chunks) => <bdi>{chunks}</bdi> })}
      </p>
      {left > 0 && (
        <StaleListNotice
          count={left}
          unit="application"
          kept="review"
          onReload={() => {
            refocusList.current = true
          }}
        />
      )}
    </>
  )
}

/** Confirmation panel currently open under a row. */
type Panel = 'approve' | 'reject'

/** Where focus must go after the next render of the row; null leaves it alone. */
type FocusTarget = 'approve' | 'reject' | 'cancel' | 'row' | null

function ApplicationRow({
  application,
  self,
  onApprove,
  onReject,
  onChanged,
  announce,
}: Pick<AuthorApplicationListProps, 'onApprove' | 'onReject'> & {
  application: AdminAuthorApplication
  self: boolean
  onChanged: (application: AdminAuthorApplication) => void
  announce: (notice: Notice | null) => void
}) {
  const t = useTranslations('Admin.applications.list')
  const tStatuses = useTranslations('Admin.statuses')
  const id = useId()
  const [panel, setPanel] = useState<Panel | null>(null)
  const action = useRowAction('Author application decision')
  const row = useRef<HTMLLIElement>(null)
  const approveButton = useRef<HTMLButtonElement>(null)
  const rejectButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const group = useRef<HTMLDivElement>(null)
  // Remember the KIND of target, not the element: the button to focus only exists after the next render (see UserTable).
  const focusNext = useRef<FocusTarget>(null)

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    const element = { approve: approveButton, reject: rejectButton, cancel: cancelButton, row }[target].current
    element?.focus()
  }, [panel, application.status])

  const { applicant } = application
  const handle = handleOf(applicant)
  const pending = application.status === 'PENDING'
  const promptId = `${id}-prompt`
  const busy = action.pending || undefined

  function open(next: Panel) {
    if (action.busy()) return
    action.setError(null)
    // Reject: focus goes to the cancel button (see the button). Approve: ApprovePanel focuses the input itself.
    focusNext.current = next === 'reject' ? 'cancel' : null
    setPanel(next)
  }

  /** Cancel: focus returns to the exact button that opened the panel. */
  function close() {
    if (action.busy()) return
    action.setError(null)
    focusNext.current = panel
    setPanel(null)
  }

  function decide(kind: Panel, code?: string) {
    announce(null)
    void action.run(
      () => (kind === 'approve' ? onApprove(application.id, code) : onReject(application.id)),
      (updated) => {
        if (updated === null) return
        // A decided application has no buttons left: focus goes to the row itself, where its new label is.
        if (focusStayedIn(group.current)) focusNext.current = 'row'
        setPanel(null)
        onChanged(updated)
        announce({ kind: kind === 'approve' ? 'approved' : 'rejected', handle })
      },
    )
  }

  const look = authorApplicationStatusLook(application.status, tStatuses)

  return (
    <li ref={row} tabIndex={-1} className="px-4 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 outline-brand">
      <div className="flex items-start gap-3">
        <Avatar name={applicant.displayName} src={applicant.avatarUrl} size={32} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2">
            {/* <bdi>: a right-to-left name does not reorder the text around it. */}
            <bdi className="font-medium text-slate-900 [overflow-wrap:anywhere]">{applicant.displayName}</bdi>
            {self && (
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 text-[12px] leading-5 font-medium text-slate-600">
                {t('you')}
              </span>
            )}
          </p>
          <p className={`${META} flex flex-wrap gap-x-3`}>
            {/* An account with only a password and no GitHub login: never "@null". */}
            {applicant.githubLogin !== null && <span className="[overflow-wrap:anywhere]">@{applicant.githubLogin}</span>}
            <span>{t.rich('submittedOn', { date: () => <ApplicationDate iso={application.createdAt} /> })}</span>
            {application.decidedAt !== null && (
              <span>
                {t.rich(application.status === 'APPROVED' ? 'approvedOn' : 'rejectedOn', {
                  date: () => <ApplicationDate iso={application.decidedAt!} />,
                })}
              </span>
            )}
            {applicant.role !== 'USER' && <span>{t('currentRole', { role: applicant.role })}</span>}
            {applicant.status === 'SUSPENDED' && (
              <span className="text-red-700">{tStatuses(USER_STATUS.SUSPENDED.labelKey)}</span>
            )}
          </p>
          {/* Plain React text, never HTML or markdown: `<script>` in the reason is just text. */}
          {application.motivation !== null ? (
            <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-slate-800 [overflow-wrap:anywhere]">
              {application.motivation}
            </p>
          ) : (
            <p className="mt-2 text-sm leading-6 text-slate-500">{t('noReason')}</p>
          )}
        </div>
        {pending && !self && panel === null && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button ref={approveButton} type="button" aria-disabled={busy} onClick={() => open('approve')} className={ROW_BUTTON}>
              {/* Whitespace OUTSIDE the span, the rest of the name in ONE sr-only span (see UserTable). */}
              {t('approve')} <span className="sr-only">{t('ofApplicant', { handle })}</span>
            </button>
            <button ref={rejectButton} type="button" aria-disabled={busy} onClick={() => open('reject')} className={ROW_DANGER}>
              {t('reject')} <span className="sr-only">{t('ofApplicant', { handle })}</span>
            </button>
          </div>
        )}
        {!pending && <ToneBadge label={look.label} tone={look.tone} className="shrink-0" />}
      </div>

      {panel === 'approve' && (
        <ApprovePanel
          ref={group}
          applicant={applicant}
          handle={handle}
          pending={action.pending}
          error={action.error}
          onConfirm={(code) => decide('approve', code)}
          onCancel={close}
        />
      )}

      {panel === 'reject' && (
        <div
          ref={group}
          role="group"
          aria-labelledby={promptId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            close()
          }}
          className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-4"
        >
          <p id={promptId} className="text-[13px] leading-5 text-red-900">
            {t.rich('confirmReject', {
              handle,
              strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              bdi: (chunks) => <bdi>{chunks}</bdi>,
            })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* Focus the cancel button first: a second Enter on the same spot must cancel, not reject. */}
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => decide('reject')}
              className={button('dangerSolid', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
            >
              {action.pending ? t('rejecting') : t('reject')}
            </button>
            <button
              ref={cancelButton}
              type="button"
              aria-disabled={busy}
              onClick={close}
              className={button('secondary', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
            >
              {t('cancel')}
            </button>
          </div>
          {action.error !== null && <ErrorAlert className="mt-3">{action.error}</ErrorAlert>}
        </div>
      )}
    </li>
  )
}

/**
 * Approval confirmation step: read the consequence, retype the applicant's login (the display name when there is none). The confirm
 * button stays `aria-disabled` until the text matches: a forgotten admin session cannot grant author rights with one click. The real
 * guard is still the backend (ADMIN only, no self-approval, through the role-change service).
 */
function ApprovePanel({
  ref,
  applicant,
  handle,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  ref: Ref<HTMLDivElement>
  applicant: AuthorApplicant
  handle: string
  pending: boolean
  error: string | null
  /** `code` is set only when the approval makes a reader an author: the backend asks for the administrator's own code then. */
  onConfirm: (code?: string) => void
  onCancel: () => void
}) {
  const t = useTranslations('Admin.applications.list')
  const id = useId()
  const [typed, setTyped] = useState('')
  const [code, setCode] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // Nothing to preselect (unlike RoleChangePanel): go straight to the input.
  useEffect(() => {
    input.current?.focus()
  }, [])

  // Only a reader is promoted (an author or admin keeps their role): the field is for the change that really happens.
  const needsCode = applicant.role === 'USER'
  const ready = confirms(typed, applicant) && (!needsCode || code.trim() !== '')
  const promptId = `${id}-prompt`
  const effectId = `${id}-effect`
  const inputId = `${id}-confirm`
  const bdi = (chunks: React.ReactNode) => <bdi>{chunks}</bdi>

  // Consequence of an approval, said right after the applicant's name; each part is a whole sentence. The backend only promotes
  // USER; AUTHOR/ADMIN keep their role.
  const effect: React.ReactNode[] =
    applicant.role !== 'USER'
      ? [t.rich('effect.alreadyRole', { handle, role: applicant.role, bdi })]
      : [
          t.rich('effect.promote', { handle, bdi }),
          t('effect.sessions'),
          // The backend refuses to grant a role to a suspended account (ROLE_TARGET_SUSPENDED).
          ...(applicant.status === 'SUSPENDED' ? [t('effect.suspendedNote')] : []),
        ]

  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onCancel()
      }}
      className="mt-3 rounded-lg border border-red-200 bg-red-50/60 p-4"
    >
      <p id={promptId} className="text-[13px] leading-5 text-red-900">
        {t.rich('confirmApprove', { handle, strong: (chunks) => <strong className="font-semibold">{chunks}</strong>, bdi })}
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !pending) onConfirm(needsCode ? code.trim() : undefined)
        }}
      >
        {/* Attached to the confirm button (aria-describedby): a screen reader reads the consequence right when reaching the button. */}
        <p id={effectId} className="text-[13px] leading-5 text-red-900 [overflow-wrap:anywhere]">
          {effect.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && ' '}
              {part}
            </Fragment>
          ))}
        </p>
        <div>
          <label htmlFor={inputId} className={LABEL}>
            {t.rich(applicant.githubLogin !== null ? 'confirmLogin' : 'confirmName', {
              handle,
              b: (chunks) => <bdi className="font-semibold">{chunks}</bdi>,
            })}
          </label>
          <input
            ref={input}
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            readOnly={pending}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={`${INPUT} sm:max-w-xs`}
          />
        </div>
        {needsCode && <StepUpCodeField value={code} onChange={setCode} readOnly={pending} />}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            aria-disabled={!ready || pending || undefined}
            aria-describedby={effectId}
            className={button(
              'dangerSolid',
              'sm',
              pending
                ? 'aria-disabled:cursor-wait aria-disabled:opacity-60'
                : 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
            )}
          >
            {pending ? t('approving') : t('approveApplication')}
          </button>
          <button
            type="button"
            aria-disabled={pending || undefined}
            onClick={onCancel}
            className={button('secondary', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
          >
            {t('cancel')}
          </button>
        </div>
      </form>
      {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
    </div>
  )
}

/** Date in UTC (lib/date.ts), like every admin date; an unreadable value prints nothing. */
function ApplicationDate({ iso }: { iso: string }) {
  const locale = asLocale(useLocale())
  const text = formatDate(iso, 'medium', locale)
  return text === null ? null : <time dateTime={iso}>{text}</time>
}
