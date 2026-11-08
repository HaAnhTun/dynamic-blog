'use client'

import { useTranslations } from 'next-intl'
import { Fragment, type Ref, useEffect, useId, useRef, useState } from 'react'
import { roleChangeNeedsCode } from '@/lib/role-step-up'
import type { AdminUser, UserRole } from '@/lib/types'
import { ErrorAlert } from './primitives'
import { roleLabel, USER_ROLE } from './statuses'
import { StepUpCodeField } from './StepUpCodeField'
import { button, CHECKBOX, INPUT, LABEL } from './ui'

/** Order of the filter box: from fewest privileges to most. */
const ROLES = Object.keys(USER_ROLE) as UserRole[]

const RANK: Record<UserRole, number> = { USER: 0, AUTHOR: 1, ADMIN: 2 }

/*
 * What each role can do (the permission matrix) and the consequence of a change are catalog messages under
 * `Admin.users.roleChange.effect`, with the ability phrase chosen by an ICU select on the target role, so no sentence is assembled
 * from translated pieces. A demotion takes effect immediately (the backend reads the role in the DB on every request carrying an
 * ADMIN/AUTHOR token). A promotion says "when signing in again": a USER token is not re-read from the DB, and the /admin
 * shell follows the role in the token.
 */

/** The name printed in HTML with whitespace collapsed; NFC so Vietnamese typed with any input method matches. One leading "@" removed. */
function clean(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().replace(/^@/, '')
}

/** The login is compared case-insensitively, like GitHub itself; the display name must match letter for letter. */
function confirms(typed: string, user: AdminUser): boolean {
  const value = clean(typed)
  if (value === '') return false
  return user.githubLogin !== null ? value.toLowerCase() === user.githubLogin.toLowerCase() : value === clean(user.displayName)
}

/**
 * The role-change confirmation step, under the UserTable row: choose the new role, read the consequence, retype the
 * login (the display name when there is none) of that person. The confirm button stays `aria-disabled` until the text matches: a forgotten admin
 * session cannot change anyone's role with one click. A change to or from ADMIN, or a reader becoming AUTHOR, also asks for the
 * administrator's own code (audit 111). The real guard is still the backend (ADMIN only, at least one admin remains, the code).
 */
export function RoleChangePanel({
  ref,
  user,
  handle,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  /** The outermost frame: the row asks it whether focus is still inside (focusStayedIn). */
  ref?: Ref<HTMLDivElement>
  user: AdminUser
  /** "@login", or the display name when there is none: how the table refers to this person. */
  handle: string
  pending: boolean
  error: string | null
  /** `code` is set only when the change asks for one. */
  onConfirm: (role: UserRole, code?: string) => void
  onCancel: () => void
}) {
  const t = useTranslations('Admin.users.roleChange')
  const tStatuses = useTranslations('Admin.statuses')
  const id = useId()
  const [chosen, setChosen] = useState<UserRole>(user.role)
  const [typed, setTyped] = useState('')
  const [code, setCode] = useState('')
  const currentRole = useRef<HTMLInputElement>(null)

  // Focus goes to the current role, not the typing box: the role must be chosen first. Focus is not moved when a choice is made (arrow
  // keys change the selection immediately, and moving focus then would be a change of context midway, WCAG 3.2.2).
  useEffect(() => {
    currentRole.current?.focus()
  }, [])

  const changed = chosen !== user.role
  const needsCode = roleChangeNeedsCode(user.role, chosen)
  const ready = changed && confirms(typed, user) && (!needsCode || code.trim() !== '')
  const promptId = `${id}-prompt`
  const effectId = `${id}-effect`
  const inputId = `${id}-confirm`
  const bdi = (chunks: React.ReactNode) => <bdi>{chunks}</bdi>

  // Each part is a whole sentence; the first one starts with the person's name.
  const effect = (): React.ReactNode[] => {
    const parts: React.ReactNode[] =
      RANK[chosen] > RANK[user.role]
        ? [
            t.rich('effect.promote', { handle, to: chosen, bdi }),
            t('effect.promoteSessions'),
            // An administrator always uses two-step verification, set up with the operator's enrollment code: a promoted author's
            // existing authenticator is removed, so the person enrolls again the way every new administrator does.
            ...(chosen === 'ADMIN' ? [t('effect.promoteEnrollsAgain')] : []),
          ]
        : [
            t.rich('effect.demote', { handle, from: user.role, to: chosen, bdi }),
            ...(chosen === 'USER' ? [t('effect.demoteKeepsPosts')] : []),
            t('effect.demoteSessions'),
          ]
    // The backend refuses to grant ADMIN or AUTHOR to a suspended account (ROLE_TARGET_SUSPENDED).
    if (user.status === 'SUSPENDED' && chosen !== 'USER') parts.push(t('effect.suspendedNote'))
    return parts
  }

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
      className="rounded-lg border border-red-200 bg-red-50/60 p-4"
    >
      <p id={promptId} className="text-[13px] leading-5 text-red-900">
        {t.rich('title', { handle, strong: (chunks) => <strong className="font-semibold">{chunks}</strong>, bdi })}
      </p>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !pending) onConfirm(chosen, needsCode ? code.trim() : undefined)
        }}
      >
        <fieldset>
          <legend className={LABEL}>{t('newRole')}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {ROLES.map((role) => (
              <label key={role} className="inline-flex items-center gap-2 text-sm text-slate-800">
                <input
                  ref={role === user.role ? currentRole : undefined}
                  type="radio"
                  name={`${id}-role`}
                  value={role}
                  checked={chosen === role}
                  onChange={() => {
                    if (!pending) setChosen(role)
                  }}
                  className={CHECKBOX}
                />
                {roleLabel(role, tStatuses)}
                {/* Whitespace OUTSIDE the span: inside the span the accessible name would run the role and the current marker together. */}
                {role === user.role && (
                  <>
                    {' '}
                    <span className="text-slate-600">{t('current')}</span>
                  </>
                )}
              </label>
            ))}
          </div>
        </fieldset>
        {/* Attached to the confirm button (aria-describedby): a screen reader reads the consequence right when reaching the button. */}
        {changed && (
          <p id={effectId} className="text-[13px] leading-5 text-red-900 [overflow-wrap:anywhere]">
            {effect().map((part, index) => (
              <Fragment key={index}>
                {index > 0 && ' '}
                {part}
              </Fragment>
            ))}
          </p>
        )}
        <div>
          <label htmlFor={inputId} className={LABEL}>
            {t.rich(user.githubLogin !== null ? 'confirmLogin' : 'confirmName', {
              handle,
              b: (chunks) => <bdi className="font-semibold">{chunks}</bdi>,
            })}
          </label>
          <input
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
            aria-describedby={changed ? effectId : undefined}
            className={button(
              'dangerSolid',
              'sm',
              pending
                ? 'aria-disabled:cursor-wait aria-disabled:opacity-60'
                : 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
            )}
          >
            {pending ? t('submitting') : changed ? t('changeTo', { role: roleLabel(chosen, tStatuses) }) : t('change')}
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
