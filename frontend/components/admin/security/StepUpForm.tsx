'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { postMfa } from '@/lib/mfa-client'
import { ErrorAlert } from '../primitives'
import { button, INPUT, LABEL } from '../ui'
import type { FailedReply } from './EnrollFlow'

/**
 * A change of the two-step verification that needs only a proof and no secret of its own: "Generate new recovery codes" (a code, and the
 * password of an account that has one) and "Turn off" (a code). The code is an authenticator code or a recovery code: a person who
 * lost the phone has nothing else.
 *
 * It posts to one of the Security route handlers (lib/admin-security-bff.ts), shows the sentence the handler wrote, and hands the
 * answer to the host. A refusal is also told to the host (`onRefused`), which owns the "sign in again" banner.
 */
export default function StepUpForm({
  url,
  withPassword,
  lead,
  submitLabel,
  workingLabel,
  danger = false,
  onSuccess,
  onCancel,
  onRefused,
}: {
  url: string
  /** The account has a password: it is asked too. */
  withPassword: boolean
  lead?: string
  submitLabel: string
  workingLabel: string
  /** A change that costs something (turning two-step verification off): the button is red. */
  danger?: boolean
  onSuccess: (body: Record<string, unknown>) => void
  onCancel: () => void
  onRefused?: (reply: FailedReply) => void
}) {
  const t = useTranslations('Admin.security')
  const codeId = useId()
  const passwordId = useId()
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (code.trim() === '') return setError(t('codeRequired'))
    if (withPassword && password === '') return setError(t('password.currentRequired'))
    setBusy(true)
    const reply = await postMfa(url, withPassword ? { code: code.trim(), currentPassword: password } : { code: code.trim() })
    setBusy(false)
    if (!reply.ok) {
      setError(reply.reauthenticate && onRefused !== undefined ? null : (reply.error ?? t('errors.unreachable')))
      onRefused?.(reply)
      return
    }
    setPassword('')
    onSuccess(reply.body)
  }

  return (
    <form method="post" action={url} onSubmit={submit} noValidate className="space-y-4">
      {lead !== undefined && <p className="text-sm leading-6 text-slate-600">{lead}</p>}
      <div>
        <label htmlFor={codeId} className={LABEL}>
          {t('currentCode')}
        </label>
        <input
          id={codeId}
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={40}
          autoFocus
          className={INPUT}
        />
      </div>
      {withPassword && (
        <div>
          <label htmlFor={passwordId} className={LABEL}>
            {t('password.current')}
          </label>
          <input
            id={passwordId}
            name="currentPassword"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            className={INPUT}
          />
        </div>
      )}
      {error !== null && <ErrorAlert>{error}</ErrorAlert>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={button(danger ? 'dangerSolid' : 'primary', 'md', 'min-h-10')}>
          {busy ? workingLabel : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className={button('ghost', 'md')}>
          {t('cancel')}
        </button>
      </div>
    </form>
  )
}
