// frontend/app/admin/login/mfa/MfaForm.tsx
'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useRef, useState } from 'react'
import { ErrorAlert } from '@/components/admin/primitives'
import { button, INPUT, LABEL, WARN_TEXT } from '@/components/admin/ui'
import { postMfa } from '@/lib/mfa-client'
import { adminLoginPath } from '@/lib/return-to'

/**
 * Where the code is POSTed. Must equal the folder of app/admin/login/mfa/submit/route.ts and an entry of SIGN_IN_STEP_PATHS in
 * proxy.ts (a path that is missing there needs a session, and nobody has one yet). Exported so the test asserts the same constant.
 */
export const MFA_ENDPOINT = '/admin/login/mfa/submit'

/** At or below this many recovery codes left, the page asks for new ones. */
const LOW_RECOVERY_CODES = 2

type Mode = 'app' | 'recovery'

/**
 * The second step of a sign-in: one field, a 6-digit authenticator code or (after a link press) a recovery code. The server decides
 * by shape, so both are accepted either way; the mode only changes the label and the keyboard.
 *
 * The challenge is in an httpOnly cookie that the first step set, so this form sends the code and nothing else. After a recovery
 * code the page does not leave at once: it says how many remain and points to Security, because that code was the last thing
 * between the person and a lost phone.
 */
export default function MfaForm({ next }: { next: string }) {
  const t = useTranslations('Admin.login')
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const [mode, setMode] = useState<Mode>('app')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [recoveryLeft, setRecoveryLeft] = useState<number | null>(null)

  function switchMode() {
    setMode((current) => (current === 'app' ? 'recovery' : 'app'))
    setCode('')
    setError(null)
    input.current?.focus()
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const reply = await postMfa(MFA_ENDPOINT, { code })
    setPending(false)
    if (!reply.ok) {
      setError(reply.error ?? t('network'))
      return
    }
    if (reply.body.usedRecoveryCode === true) {
      setRecoveryLeft(typeof reply.body.recoveryCodesRemaining === 'number' ? reply.body.recoveryCodesRemaining : 0)
      return
    }
    // replace, not push: the back button must not return to a step that is already satisfied.
    router.replace(next)
  }

  if (recoveryLeft !== null) {
    return (
      <div className="space-y-4" role="status">
        <p className="text-sm leading-6 text-slate-900">{t('mfa.recoveryUsed')}</p>
        <p className="text-sm leading-6 text-slate-600">{t('mfa.recoveryLeft', { count: recoveryLeft })}</p>
        {recoveryLeft <= LOW_RECOVERY_CODES && <p className={WARN_TEXT}>{t('mfa.recoveryLow')}</p>}
        <p className="text-sm leading-6 text-slate-600">{t('mfa.replaceHint')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => router.replace(next)} className={button('primary', 'md', 'min-h-10')}>
            {t('mfa.continue')}
          </button>
          <Link href="/admin/security" className={button('secondary', 'md', 'min-h-10')}>
            {t('mfa.openSecurity')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <form method="post" action={MFA_ENDPOINT} onSubmit={onSubmit} className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">{mode === 'app' ? t('mfa.lead') : t('mfa.leadRecovery')}</p>
      <div>
        <label htmlFor={id} className={LABEL}>
          {mode === 'app' ? t('mfa.code') : t('mfa.recoveryLabel')}
        </label>
        <input
          ref={input}
          id={id}
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
          autoFocus
          // The authenticator code is digits and, typed across a gap, may carry a space: seven characters. A recovery code is
          // 24 characters plus the hyphens and spaces of its grouping.
          inputMode={mode === 'app' ? 'numeric' : 'text'}
          autoComplete={mode === 'app' ? 'one-time-code' : 'off'}
          spellCheck={false}
          maxLength={mode === 'app' ? 7 : 40}
          className={INPUT}
        />
      </div>
      {/* Right above the button: the next press goes past the previous error message. */}
      {error !== null && <ErrorAlert>{error}</ErrorAlert>}
      <button type="submit" disabled={pending} className={button('primary', 'md', 'w-full min-h-10')}>
        {pending ? t('mfa.submitting') : t('mfa.submit')}
      </button>
      <p className="text-center text-sm">
        <button
          type="button"
          onClick={switchMode}
          className="rounded-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-4 hover:decoration-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
        >
          {mode === 'app' ? t('mfa.useRecovery') : t('mfa.useApp')}
        </button>
      </p>
      <p className="text-center text-sm">
        <Link
          href={adminLoginPath(next)}
          className="rounded-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
        >
          {t('mfa.back')}
        </Link>
      </p>
    </form>
  )
}
