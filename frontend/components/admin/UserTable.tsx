'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { Avatar } from '@/components/site/Avatar'
import { formatDate } from '@/lib/date'
import { asLocale } from '@/lib/format'
import type { AdminUser, UserRole, UserStatus } from '@/lib/types'
import { MfaResetPanel } from './MfaResetPanel'
import { ErrorAlert, ToneBadge } from './primitives'
import { RoleChangePanel } from './RoleChangePanel'
import { StaleListNotice } from './StaleListNotice'
import { roleLabel, userStatusLook } from './statuses'
import { button, FOCUS_RING, META, STATUS_TEXT } from './ui'
import { focusStayedIn, useRowAction } from './useRowAction'

type Outcome = AdminUser | { error: string }

/** The reset of an author's two-step verification: done, or the sentence why not. */
type ResetOutcome = { done: true } | { error: string }

export type UserTableProps = {
  /** One page of the list, as the backend returns it (newest first). */
  users: AdminUser[]
  /** Table caption (sr-only): the filter, the search box and the current page. */
  caption: string
  /**
   * Id of the logged-in person (the token's `sub` claim): that row has no buttons, and carries the "you" label.
   * For drawing only — the backend itself refuses an admin suspending themselves, or demoting the last active
   * admin. null when it cannot be read.
   */
  selfId: string | null
  /**
   * Status the list is filtered by; null means any status. The actions here can change status
   * and role, so these two filters let a row leave the list (see StaleListNotice); the search box does not.
   */
  statusFilter: UserStatus | null
  /** Role the list is filtered by; null means any role. */
  roleFilter: UserRole | null
  onSuspend: (id: string) => Promise<Outcome>
  onUnsuspend: (id: string) => Promise<Outcome>
  /** `code` is the administrator's own code, sent for the changes that need one (lib/role-step-up.ts). */
  onChangeRole: (id: string, role: UserRole, code?: string) => Promise<Outcome>
  /** An administrator resets an AUTHOR's two-step verification with the administrator's own code. */
  onResetMfa: (id: string, code: string) => Promise<ResetOutcome>
}

/** Column count: the confirmation row and the error row span the full table width. */
const COLUMNS = 6

const ROW_BUTTON = button('ghost', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')
const ROW_DANGER = button(
  'ghost',
  'sm',
  'text-red-700 hover:bg-red-50 hover:text-red-800 aria-disabled:cursor-wait aria-disabled:opacity-60',
)

type Notice = { kind: 'suspended' | 'unsuspended' | 'roleChanged' | 'mfaReset'; handle: string; role?: string }

/** How an account is referred to in buttons and questions: "@login" like on GitHub, or the display name when there is none. */
function handleOf(user: AdminUser): string {
  return user.githubLogin !== null ? `@${user.githubLogin}` : user.displayName
}

/**
 * The table of the Users page: who has an account, role, status,
 * join date, last login; suspend / unsuspend readers and change roles right on the row.
 *
 * The row of the logged-in person never has buttons. Suspend / unsuspend only on USER-role rows;
 * the change-role button on every other row, through RoleChangePanel (retype the login to confirm). Suspending logs
 * that person out, so it must go through an in-place confirmation step; unsuspending does not. The action result is applied straight
 * to the row (state from props, like CommentModeration): the action does not updateTag, the page does not re-render;
 * a row that leaves the filter makes StaleListNotice offer a reload; changing the filter or page rebuilds this component
 * (`key` is the list URL).
 */
export default function UserTable({
  users,
  caption,
  selfId,
  statusFilter,
  roleFilter,
  onSuspend,
  onUnsuspend,
  onChangeRole,
  onResetMfa,
}: UserTableProps) {
  const t = useTranslations('Admin.users.table')
  const [rows, setRows] = useState(users)
  const [notice, setNotice] = useState<Notice | null>(null)
  const table = useRef<HTMLTableElement>(null)
  // After the reload-list button: if focus fell back to <body> together with that button, move it to the table (see CommentModeration).
  const refocusTable = useRef(false)
  // A fresh list from the server with the same `key` (pressing the tab already open): the new data wins. See
  // CommentModeration: the actions do not make the page re-render, so an in-place change is not overwritten by the old copy.
  const [source, setSource] = useState(users)
  if (users !== source) {
    setSource(users)
    setRows(users)
  }

  useEffect(() => {
    if (!refocusTable.current) return
    refocusTable.current = false
    if (focusStayedIn(null)) table.current?.focus()
  }, [source])

  function replace(updated: AdminUser) {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)))
  }

  // Rows currently shown that have left the filter: suspended under the active tab, unsuspended under the suspended tab, role changed
  // while filtering by role.
  const left = rows.filter(
    (row) => (statusFilter !== null && row.status !== statusFilter) || (roleFilter !== null && row.role !== roleFilter),
  ).length

  const th = 'py-2.5 text-[13px] font-medium text-slate-500'

  return (
    <>
      <table ref={table} tabIndex={-1} className={`w-full table-fixed border-collapse text-left text-sm ${FOCUS_RING}`}>
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-slate-200">
          <tr>
            {/* Less important columns hide progressively as the screen narrows; what they say goes on a secondary line under the name. */}
            <th scope="col" className={`${th} pr-4`}>
              {t('user')}
            </th>
            <th scope="col" className={`${th} hidden w-24 pr-4 sm:table-cell`}>
              {t('role')}
            </th>
            <th scope="col" className={`${th} hidden w-36 pr-4 sm:table-cell`}>
              {t('status')}
            </th>
            <th scope="col" className={`${th} hidden w-32 pr-4 md:table-cell`}>
              {t('joined')}
            </th>
            <th scope="col" className={`${th} hidden w-40 pr-4 xl:table-cell`}>
              {t('lastLogin')}
            </th>
            <th scope="col" className={`${th} w-28 text-right`}>
              {t('actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((user, index) => (
            <UserRow
              key={user.id}
              user={user}
              self={selfId !== null && user.id === selfId}
              first={index === 0}
              onSuspend={onSuspend}
              onUnsuspend={onUnsuspend}
              onChangeRole={onChangeRole}
              onResetMfa={onResetMfa}
              onChanged={replace}
              announce={setNotice}
            />
          ))}
        </tbody>
      </table>
      {/* Always present: a live region must exist before its content changes for the change to be announced. */}
      <p role="status" className={`mt-3 ${STATUS_TEXT}`}>
        {notice !== null &&
          t.rich(`notice.${notice.kind}`, {
            handle: notice.handle,
            role: notice.role ?? '',
            bdi: (chunks) => <bdi>{chunks}</bdi>,
          })}
      </p>
      {left > 0 && (
        <StaleListNotice
          count={left}
          unit="user"
          onReload={() => {
            refocusTable.current = true
          }}
        />
      )}
    </>
  )
}

/** The confirmation panel currently open under a row: suspend, change role, or reset two-step verification. */
type Panel = 'suspend' | 'role' | 'mfa'

/** Where focus must go after the next render of the row; null leaves it alone. */
type FocusTarget = 'suspend' | 'unsuspend' | 'cancel' | 'role' | 'mfa' | null

function UserRow({
  user,
  self,
  first,
  onSuspend,
  onUnsuspend,
  onChangeRole,
  onResetMfa,
  onChanged,
  announce,
}: Pick<UserTableProps, 'onSuspend' | 'onUnsuspend' | 'onChangeRole' | 'onResetMfa'> & {
  user: AdminUser
  self: boolean
  first: boolean
  onChanged: (user: AdminUser) => void
  announce: (notice: Notice | null) => void
}) {
  const t = useTranslations('Admin.users.table')
  const tStatuses = useTranslations('Admin.statuses')
  const id = useId()
  const [panel, setPanel] = useState<Panel | null>(null)
  // One lock for the whole row: cannot suspend while a role change is in progress, and vice versa.
  const action = useRowAction('User account change')
  const suspendButton = useRef<HTMLButtonElement>(null)
  const unsuspendButton = useRef<HTMLButtonElement>(null)
  const roleButton = useRef<HTMLButtonElement>(null)
  const mfaButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const confirmGroup = useRef<HTMLDivElement>(null)
  const roleGroup = useRef<HTMLDivElement>(null)
  const mfaGroup = useRef<HTMLDivElement>(null)
  // Remember the KIND of target, not the element: the button to focus only exists after the next render (see CommentModeration).
  const focusNext = useRef<FocusTarget>(null)

  useEffect(() => {
    const target = focusNext.current
    if (target === null) return
    focusNext.current = null
    const element = {
      suspend: suspendButton,
      unsuspend: unsuspendButton,
      cancel: cancelButton,
      role: roleButton,
      mfa: mfaButton,
    }[target].current
    element?.focus()
  }, [user.status, user.role, panel])

  const handle = handleOf(user)
  const look = userStatusLook(user.status, tStatuses)
  const promptId = `${id}-prompt`
  const reader = user.role === 'USER'

  function open(next: Panel) {
    if (action.busy()) return
    action.setError(null)
    // Suspend: focus goes to cancel (see the button). Change role and reset: the panel focuses its own first control.
    focusNext.current = next === 'suspend' ? 'cancel' : null
    setPanel(next)
  }

  /** Cancel: focus returns to the exact button that opened the panel. */
  function close() {
    if (action.busy()) return
    action.setError(null)
    focusNext.current = panel === 'role' ? 'role' : panel === 'mfa' ? 'mfa' : 'suspend'
    setPanel(null)
  }

  function suspend() {
    announce(null)
    void action.run(
      () => onSuspend(user.id),
      (updated) => {
        if (updated === null) return
        // The button replacing suspend is the undo button, unsuspend; the row's label becomes the suspended label.
        if (focusStayedIn(confirmGroup.current)) focusNext.current = 'unsuspend'
        setPanel(null)
        onChanged(updated)
        announce({ kind: 'suspended', handle })
      },
    )
  }

  function changeRole(role: UserRole, code?: string) {
    announce(null)
    void action.run(
      () => onChangeRole(user.id, role, code),
      (updated) => {
        if (updated === null) return
        if (focusStayedIn(roleGroup.current)) focusNext.current = 'role'
        setPanel(null)
        onChanged(updated)
        announce({ kind: 'roleChanged', handle, role: roleLabel(updated.role, tStatuses) })
      },
    )
  }

  function resetMfa(code: string) {
    announce(null)
    void action.run(
      () => onResetMfa(user.id, code),
      (done) => {
        if (done === null) return
        if (focusStayedIn(mfaGroup.current)) focusNext.current = 'mfa'
        setPanel(null)
        announce({ kind: 'mfaReset', handle })
      },
    )
  }

  function unsuspend(origin: HTMLButtonElement) {
    announce(null)
    void action.run(
      () => onUnsuspend(user.id),
      (updated) => {
        if (updated === null) return
        if (updated.status !== user.status && focusStayedIn(origin)) focusNext.current = 'suspend'
        onChanged(updated)
        announce({ kind: 'unsuspended', handle })
      },
    )
  }

  const busy = action.pending || undefined

  return (
    <>
      <tr
        className={`align-top transition-colors duration-150 motion-reduce:transition-none hover:bg-slate-50/70 ${
          first ? '' : 'border-t border-slate-100'
        }`}
      >
        <td className="py-3.5 pr-4">
          <div className="flex items-start gap-3">
            <Avatar name={user.displayName} src={user.avatarUrl} size={32} />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2">
                {/* <bdi>: a right-to-left name does not reorder the text around it. */}
                <bdi className="font-medium text-slate-900 [overflow-wrap:anywhere]">{user.displayName}</bdi>
                {self && (
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 text-[12px] leading-5 font-medium text-slate-600">
                    {t('you')}
                  </span>
                )}
              </p>
              {/* An account with only a password and no GitHub login: never "@null". */}
              {user.githubLogin !== null && <p className={`${META} [overflow-wrap:anywhere]`}>@{user.githubLogin}</p>}
              <RowMeta user={user} />
            </div>
          </div>
        </td>
        <td className="hidden py-3.5 pr-4 text-slate-700 sm:table-cell">{roleLabel(user.role, tStatuses)}</td>
        <td className="hidden py-3.5 pr-4 sm:table-cell">
          <ToneBadge label={look.label} tone={look.tone} />
        </td>
        <td className="hidden py-3.5 pr-4 text-slate-600 md:table-cell">
          <UserDate iso={user.createdAt} />
        </td>
        <td className="hidden py-3.5 pr-4 text-slate-600 xl:table-cell">
          <LastLogin iso={user.lastLoginAt} />
        </td>
        <td className="py-3 text-right">
          {!self && panel === null && (
            // Narrow column (w-28): the two buttons stack, so they do not widen the table on a phone.
            <div className="flex flex-col items-end gap-1">
              {reader && user.status === 'ACTIVE' && (
                <button
                  ref={suspendButton}
                  type="button"
                  aria-disabled={busy}
                  onClick={() => open('suspend')}
                  className={ROW_DANGER}
                >
                  {/* Whitespace OUTSIDE the span, the rest of the name in ONE sr-only span (Chrome inserts
                      whitespace around each sr-only span). */}
                  {t('suspend')} <span className="sr-only">{handle}</span>
                </button>
              )}
              {reader && user.status === 'SUSPENDED' && (
                <button
                  ref={unsuspendButton}
                  type="button"
                  aria-disabled={busy}
                  onClick={(event) => unsuspend(event.currentTarget)}
                  className={ROW_BUTTON}
                >
                  {t('unsuspend')} <span className="sr-only">{handle}</span>
                </button>
              )}
              <button ref={roleButton} type="button" aria-disabled={busy} onClick={() => open('role')} className={ROW_BUTTON}>
                {t('changeRole')} <span className="sr-only">{handle}</span>
              </button>
              {/* Only an author can have lost a device that an administrator may reset: an administrator's own is the server owner's. */}
              {user.role === 'AUTHOR' && (
                <button ref={mfaButton} type="button" aria-disabled={busy} onClick={() => open('mfa')} className={ROW_BUTTON}>
                  {t('resetMfa')} <span className="sr-only">{handle}</span>
                </button>
              )}
            </div>
          )}
        </td>
      </tr>

      {panel === 'role' && (
        <tr>
          <td colSpan={COLUMNS} className="pb-4">
            <RoleChangePanel
              ref={roleGroup}
              user={user}
              handle={handle}
              pending={action.pending}
              error={action.error}
              onConfirm={changeRole}
              onCancel={close}
            />
          </td>
        </tr>
      )}

      {panel === 'mfa' && (
        <tr>
          <td colSpan={COLUMNS} className="pb-4">
            <MfaResetPanel
              ref={mfaGroup}
              handle={handle}
              pending={action.pending}
              error={action.error}
              onConfirm={resetMfa}
              onCancel={close}
            />
          </td>
        </tr>
      )}

      {panel === 'suspend' && (
        <tr>
          <td colSpan={COLUMNS} className="pb-4">
            <div
              ref={confirmGroup}
              role="group"
              aria-labelledby={promptId}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                close()
              }}
              className="rounded-lg border border-red-200 bg-red-50/60 p-4"
            >
              <p id={promptId} className="text-[13px] leading-5 text-red-900">
                {t.rich('confirmSuspend', {
                  handle,
                  strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                  bdi: (chunks) => <bdi>{chunks}</bdi>,
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {/* Focus the cancel button first: a second Enter on the same spot must cancel, not suspend. */}
                <button
                  type="button"
                  aria-disabled={busy}
                  onClick={suspend}
                  className={button('dangerSolid', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
                >
                  {action.pending ? t('suspending') : t('suspend')}
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
          </td>
        </tr>
      )}

      {/* Unsuspend failed: error sentence right under the row, focus stays on the button just pressed for a retry. */}
      {panel === null && action.error !== null && (
        <tr>
          <td colSpan={COLUMNS} className="pb-4">
            <ErrorAlert>{action.error}</ErrorAlert>
          </td>
        </tr>
      )}
    </>
  )
}

/** What the columns hidden on narrow screens would show (role, status below sm; joined below md; login below xl). */
function RowMeta({ user }: { user: AdminUser }) {
  const t = useTranslations('Admin.users.table')
  const tStatuses = useTranslations('Admin.statuses')
  const look = userStatusLook(user.status, tStatuses)
  return (
    <p className={`${META} mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 xl:hidden`}>
      <span className="sm:hidden">{roleLabel(user.role, tStatuses)}</span>
      <ToneBadge label={look.label} tone={look.tone} className="sm:hidden" />
      <span className="md:hidden">{t.rich('joinedOn', { date: () => <UserDate iso={user.createdAt} /> })}</span>
      <span>
        {user.lastLoginAt === null ? (
          <LastLogin iso={null} />
        ) : (
          t.rich('lastLoginOn', { date: () => <LastLogin iso={user.lastLoginAt} /> })
        )}
      </span>
    </p>
  )
}

/** Date in UTC (lib/date.ts), like every date of the site; an unreadable value prints nothing. */
function UserDate({ iso }: { iso: string }) {
  const locale = asLocale(useLocale())
  const text = formatDate(iso, 'medium', locale)
  return text === null ? null : <time dateTime={iso}>{text}</time>
}

/** `lastLoginAt` only records GitHub logins: a password-only account is always null. */
function LastLogin({ iso }: { iso: string | null }) {
  const t = useTranslations('Admin.users.table')
  return iso === null ? <span className="text-slate-500">{t('neverLoggedIn')}</span> : <UserDate iso={iso} />
}
