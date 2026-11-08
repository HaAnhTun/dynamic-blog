'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { postMfa, recoveryCodesOf, secretOf, type EnrollmentSecret, type MfaReply } from '@/lib/mfa-client'
import { ErrorAlert } from '../primitives'
import { button, FOCUS_RING, H2, HINT, INPUT, LABEL } from '../ui'
import RecoveryCodes from './RecoveryCodes'
import SecretKey from './SecretKey'

/** What the first call (begin) needs from the person before it can start. */
export type EnrollField = 'enrollmentCode' | 'code' | 'currentPassword'

export type FailedReply = Extract<MfaReply, { ok: false }>

type Phase = 'prepare' | 'secret' | 'codes'

/**
 * Setting up an authenticator, as one component with three steps and no state outside it (nothing is written to storage or to the
 * URL): (1) the inputs that `begin` needs, if any, (2) the secret and the first code, (3) the ten recovery codes.
 *
 * It serves three hosts, which differ only in the two endpoints and in the inputs of step 1:
 *   - the forced enrollment of an administrator at sign-in (`/admin/login/enroll`): the operator's enrollment code, when it is asked;
 *   - an author who turns two-step verification on in Security: no input (an author has no password);
 *   - "Replace authenticator" in Security: a code of the current authenticator or a recovery code, and the password if there is one.
 *
 * The first call is never made by merely opening a page: it needs a press of the button, because it replaces the pending secret
 * on the server. A 403 `ENROLLMENT_CODE_INVALID` adds the enrollment-code field even when the page was not told to ask for it
 * (`?code=1` is only a hint). The secret is dropped from state when the recovery codes appear.
 */
export default function EnrollFlow({
  beginUrl,
  confirmUrl,
  fields,
  lead,
  doneLabel,
  onDone,
  onCancel,
  onRefused,
  restartHref,
}: {
  beginUrl: string
  confirmUrl: string
  /** The inputs of step 1 (may be empty: the step is then only the button). */
  fields: readonly EnrollField[]
  /** A sentence above the inputs of step 1. */
  lead?: string
  /** The label of the button that leaves step 3. */
  doneLabel: string
  onDone: () => void
  /** Leave before the codes (the Security page: Cancel). Absent on the sign-in page, where there is nothing to go back to. */
  onCancel?: () => void
  /**
   * Told about every refusal, so that the host can react (offer "sign in again", leave for the sign-in). When a host listens, it owns
   * the "sign in again" message (a banner with the button): the flow then does not repeat that sentence in place.
   */
  onRefused?: (reply: FailedReply) => void
  /** Where the sign-in starts over, offered when the challenge has expired. */
  restartHref?: string
}) {
  const t = useTranslations('Admin')
  const [phase, setPhase] = useState<Phase>('prepare')
  const [active, setActive] = useState<readonly EnrollField[]>(fields)
  const [values, setValues] = useState<Record<EnrollField, string>>({ enrollmentCode: '', code: '', currentPassword: '' })
  const [secret, setSecret] = useState<EnrollmentSecret | null>(null)
  const [first, setFirst] = useState('')
  const [codes, setCodes] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const ids = { enrollmentCode: useId(), code: useId(), currentPassword: useId(), first: useId() }

  // Focus follows the step. Not on the first render: the first input of step 1 has its own autofocus.
  const shown = useRef(phase)
  useEffect(() => {
    if (shown.current !== phase) {
      shown.current = phase
      if (phase === 'secret') heading.current?.focus()
    }
  }, [phase])

  function refuse(reply: FailedReply) {
    if (reply.code === 'ENROLLMENT_CODE_INVALID')
      setActive((current) => (current.includes('enrollmentCode') ? current : [...current, 'enrollmentCode']))
    if (reply.code === 'MFA_CHALLENGE_INVALID') setExpired(true)
    setError(reply.reauthenticate && onRefused !== undefined ? null : (reply.error ?? t('login.network')))
    onRefused?.(reply)
  }

  function required(name: EnrollField): string {
    return name === 'enrollmentCode'
      ? t('login.enroll.codeRequired')
      : name === 'code'
        ? t('security.codeRequired')
        : t('security.password.currentRequired')
  }

  async function begin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const body: Record<string, string> = {}
    for (const name of active) {
      const value = values[name].trim()
      if (value === '') {
        setError(required(name))
        return
      }
      body[name] = value
    }
    setBusy(true)
    const reply = await postMfa(beginUrl, body)
    setBusy(false)
    if (!reply.ok) return refuse(reply)
    const received = secretOf(reply.body)
    if (received === null) return setError(t('login.failed'))
    setSecret(received)
    setPhase('secret')
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const code = first.trim()
    if (code === '') return setError(t('security.codeRequired'))
    setBusy(true)
    const reply = await postMfa(confirmUrl, { code })
    setBusy(false)
    if (!reply.ok) return refuse(reply)
    const received = recoveryCodesOf(reply.body)
    if (received === null) return setError(t('login.failed'))
    // The secret is not needed any more, and must not stay in the page once the codes are shown.
    setSecret(null)
    setFirst('')
    setCodes(received)
    setPhase('codes')
  }

  const problem = error !== null && (
    <div className="mt-4 space-y-2">
      <ErrorAlert>{error}</ErrorAlert>
      {expired && restartHref !== undefined && (
        <p>
          <Link href={restartHref} className="text-sm font-medium text-slate-900 underline underline-offset-4">
            {t('login.mfa.back')}
          </Link>
        </p>
      )}
    </div>
  )

  if (phase === 'codes') return <RecoveryCodes codes={codes} doneLabel={doneLabel} onDone={onDone} />

  if (phase === 'secret' && secret !== null) {
    return (
      <section>
        <h2 ref={heading} tabIndex={-1} className={`${H2} rounded-sm ${FOCUS_RING}`}>
          {t('login.enroll.secretTitle')}
        </h2>
        <div className="mt-2">
          <SecretKey secret={secret} />
        </div>
        <form method="post" action={confirmUrl} onSubmit={confirm} noValidate className="mt-4">
          <label htmlFor={ids.first} className={LABEL}>
            {t('login.enroll.firstCode')}
          </label>
          <input
            id={ids.first}
            name="code"
            value={first}
            onChange={(event) => setFirst(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            className={INPUT}
          />
          {problem}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={button('primary', 'md', 'min-h-10')}>
              {busy ? t('login.enroll.confirming') : t('login.enroll.confirm')}
            </button>
            {onCancel !== undefined && (
              <button type="button" onClick={onCancel} className={button('ghost', 'md')}>
                {t('security.cancel')}
              </button>
            )}
          </div>
        </form>
      </section>
    )
  }

  return (
    <form method="post" action={beginUrl} onSubmit={begin} noValidate className="space-y-4">
      {lead !== undefined && <p className="text-sm leading-6 text-slate-600">{lead}</p>}
      {active.includes('enrollmentCode') && (
        <div>
          <label htmlFor={ids.enrollmentCode} className={LABEL}>
            {t('login.enroll.enrollmentCode')}
          </label>
          <input
            id={ids.enrollmentCode}
            name="enrollmentCode"
            value={values.enrollmentCode}
            onChange={(event) => setValues((current) => ({ ...current, enrollmentCode: event.target.value }))}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-describedby={`${ids.enrollmentCode}-hint`}
            className={INPUT}
          />
          <p id={`${ids.enrollmentCode}-hint`} className={HINT}>
            {t('login.enroll.enrollmentCodeHint')}
          </p>
        </div>
      )}
      {active.includes('code') && (
        <div>
          <label htmlFor={ids.code} className={LABEL}>
            {t('security.currentCode')}
          </label>
          <input
            id={ids.code}
            name="code"
            value={values.code}
            onChange={(event) => setValues((current) => ({ ...current, code: event.target.value }))}
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={40}
            autoFocus
            className={INPUT}
          />
        </div>
      )}
      {active.includes('currentPassword') && (
        <div>
          <label htmlFor={ids.currentPassword} className={LABEL}>
            {t('security.password.current')}
          </label>
          <input
            id={ids.currentPassword}
            name="currentPassword"
            type="password"
            value={values.currentPassword}
            onChange={(event) => setValues((current) => ({ ...current, currentPassword: event.target.value }))}
            autoComplete="current-password"
            className={INPUT}
          />
        </div>
      )}
      {problem}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={button('primary', 'md', 'min-h-10')}>
          {busy ? t('login.enroll.starting') : t('login.enroll.start')}
        </button>
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel} className={button('ghost', 'md')}>
            {t('security.cancel')}
          </button>
        )}
      </div>
    </form>
  )
}
