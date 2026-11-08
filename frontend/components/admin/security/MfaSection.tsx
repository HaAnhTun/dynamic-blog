'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { AdminRole } from '@/lib/admin-role'
import { recoveryCodesOf } from '@/lib/mfa-client'
import type { MfaStatus } from '@/lib/types'
import { ToneBadge } from '../primitives'
import { button, CARD, H2, SECTION_DESC, STATUS_TEXT, WARN_TEXT } from '../ui'
import { ENDPOINTS } from './endpoints'
import EnrollFlow, { type EnrollField, type FailedReply } from './EnrollFlow'
import RecoveryCodes from './RecoveryCodes'
import StepUpForm from './StepUpForm'

/** At or below this many recovery codes left, the card asks for new ones. */
const LOW_RECOVERY_CODES = 2

type Action = 'turnOn' | 'replace' | 'regenerate' | 'turnOff'
type Notice = 'turnedOn' | 'replaced' | 'turnedOff' | 'regenerated'

/**
 * The two-step verification card of the Security page: whether it is on, how many recovery codes are left, and what can be done.
 *
 * - An administrator: always on. Generate new recovery codes, Replace authenticator; no Turn off, and a sentence says why.
 * - An author with it off: Turn on (the same setup as the forced enrollment, with no enrollment code: the author is signed in).
 * - An author with it on: the same three, plus Turn off.
 *
 * Every change needs a sign-in within the last ten minutes; a refusal for that reason reaches the panel (`onRefused`), which shows
 * the "sign in again" banner. After a change the server data is read again (`router.refresh()`), because the account's
 * sessions were replaced and the status changed.
 */
export default function MfaSection({
  status,
  role,
  onRefused,
}: {
  status: MfaStatus
  role: AdminRole | null
  onRefused: (reply: FailedReply) => void
}) {
  const t = useTranslations('Admin.security')
  const router = useRouter()
  const [action, setAction] = useState<Action | null>(null)
  const [codes, setCodes] = useState<readonly string[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const isAdmin = role === 'ADMIN'
  const low = status.enrolled && status.recoveryCodesRemaining <= LOW_RECOVERY_CODES
  const stepUpFields: EnrollField[] = status.hasPassword ? ['code', 'currentPassword'] : ['code']

  function finish(done: Notice) {
    setAction(null)
    setCodes(null)
    setNotice(done)
    router.refresh()
  }

  function open(next: Action) {
    setNotice(null)
    setAction(next)
  }

  return (
    <section aria-labelledby="security-mfa" className={`${CARD} p-5 sm:p-6`}>
      <h2 id="security-mfa" className={H2}>
        {t('mfaTitle')}
      </h2>
      <p className="mt-3">
        <ToneBadge
          label={status.enrolled ? t('status.on') : t('status.off')}
          tone={status.enrolled ? 'text-emerald-700' : 'text-amber-700'}
        />
      </p>
      {!status.enrolled && !isAdmin && <p className={SECTION_DESC}>{t('offHint')}</p>}
      {status.enrolled && (
        <p className={`mt-2 ${low ? WARN_TEXT : STATUS_TEXT}`}>
          {t('recoveryLeft', { count: status.recoveryCodesRemaining })}
          {low && ` ${t('recoveryLowHint')}`}
        </p>
      )}
      {isAdmin && <p className={SECTION_DESC}>{t('adminRequired')}</p>}
      {/* Always present, so that the change is announced. */}
      <p role="status" className={`mt-3 min-h-6 ${STATUS_TEXT}`}>
        {notice !== null ? t(`notice.${notice}`) : ''}
      </p>

      {action === null && (
        <div className="mt-2 flex flex-wrap gap-2">
          {status.enrolled ? (
            <>
              <button type="button" onClick={() => open('regenerate')} className={button('secondary', 'md')}>
                {t('regenerate')}
              </button>
              <button type="button" onClick={() => open('replace')} className={button('secondary', 'md')}>
                {t('replace')}
              </button>
              {!isAdmin && (
                <button type="button" onClick={() => open('turnOff')} className={button('danger', 'md')}>
                  {t('turnOff')}
                </button>
              )}
            </>
          ) : (
            !isAdmin && (
              <button type="button" onClick={() => open('turnOn')} className={button('primary', 'md')}>
                {t('turnOn')}
              </button>
            )
          )}
        </div>
      )}

      {action !== null && (
        <div className="mt-4 border-t border-slate-200 pt-5">
          {action === 'turnOn' && (
            <EnrollFlow
              beginUrl={ENDPOINTS.enrollBegin}
              confirmUrl={ENDPOINTS.enrollConfirm}
              fields={status.hasPassword ? ['currentPassword'] : []}
              doneLabel={t('done')}
              onDone={() => finish('turnedOn')}
              onCancel={() => setAction(null)}
              onRefused={onRefused}
            />
          )}
          {action === 'replace' && (
            <EnrollFlow
              beginUrl={ENDPOINTS.replaceBegin}
              confirmUrl={ENDPOINTS.replaceConfirm}
              fields={stepUpFields}
              lead={t('replaceLead')}
              doneLabel={t('done')}
              onDone={() => finish('replaced')}
              onCancel={() => setAction(null)}
              onRefused={onRefused}
            />
          )}
          {action === 'regenerate' &&
            (codes === null ? (
              <StepUpForm
                url={ENDPOINTS.recoveryCodes}
                withPassword={status.hasPassword}
                lead={t('regenerateLead')}
                submitLabel={t('regenerate')}
                workingLabel={t('working')}
                onSuccess={(body) => setCodes(recoveryCodesOf(body))}
                onCancel={() => setAction(null)}
                onRefused={onRefused}
              />
            ) : (
              <RecoveryCodes codes={codes} doneLabel={t('done')} onDone={() => finish('regenerated')} />
            ))}
          {action === 'turnOff' && (
            <StepUpForm
              url={ENDPOINTS.disable}
              withPassword={false}
              lead={t('turnOffLead')}
              submitLabel={t('turnOffConfirm')}
              workingLabel={t('working')}
              danger
              onSuccess={() => finish('turnedOff')}
              onCancel={() => setAction(null)}
              onRefused={onRefused}
            />
          )}
        </div>
      )}
    </section>
  )
}
