'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { clearClientSessionData } from '@/lib/client-session-data'
import { postMfa } from '@/lib/mfa-client'
import { ErrorAlert } from '../primitives'
import { button, CARD, H2, SECTION_DESC } from '../ui'
import { ENDPOINTS } from './endpoints'

/**
 * "Sign out everywhere": ends every session of the account, this one included, through the existing `revoke-all` (lib/admin-security-bff.ts
 * clears the cookies). One meaning only: no "everywhere else" variant. It asks first, in place, because it ends the session that is
 * pressing the button; it needs no recent sign-in (ending sessions is never the dangerous direction).
 *
 * Like the Sign out button, it empties what the browser keeps for the writer (the editor's drafts, recent searches; they follow the
 * writer, not the machine) and goes to the sign-in.
 */
export default function SignOutEverywhere() {
  const t = useTranslations('Admin.security')
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setError(null)
    setBusy(true)
    const reply = await postMfa(ENDPOINTS.signOutEverywhere, {})
    if (!reply.ok) {
      setBusy(false)
      setError(reply.error ?? t('errors.unreachable'))
      return
    }
    clearClientSessionData()
    router.replace(typeof reply.body.next === 'string' ? reply.body.next : '/admin/login')
  }

  return (
    <section aria-labelledby="security-sign-out" className={`${CARD} p-5 sm:p-6`}>
      <h2 id="security-sign-out" className={H2}>
        {t('signOutEverywhere')}
      </h2>
      <p className={SECTION_DESC}>{t('signOutLead')}</p>
      {error !== null && <ErrorAlert className="mt-4">{error}</ErrorAlert>}
      {asking ? (
        <div role="group" aria-label={t('signOutConfirm')} className="mt-4 flex flex-wrap items-center gap-2">
          <p className="mr-2 text-sm font-medium text-slate-900">{t('signOutConfirm')}</p>
          <button type="button" disabled={busy} onClick={confirm} className={button('dangerSolid', 'md')}>
            {busy ? t('working') : t('signOutEverywhere')}
          </button>
          <button type="button" disabled={busy} onClick={() => setAsking(false)} className={button('ghost', 'md')}>
            {t('cancel')}
          </button>
        </div>
      ) : (
        <div className="mt-4">
          <button type="button" onClick={() => setAsking(true)} className={button('danger', 'md')}>
            {t('signOutEverywhere')}
          </button>
        </div>
      )}
    </section>
  )
}
