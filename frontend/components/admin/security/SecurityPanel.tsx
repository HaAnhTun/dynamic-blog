'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { GitHubLoginLink } from '@/components/site/GitHubLoginLink'
import type { AdminRole } from '@/lib/admin-role'
import { adminLoginPath } from '@/lib/return-to'
import type { MfaStatus } from '@/lib/types'
import { button } from '../ui'
import type { FailedReply } from './EnrollFlow'
import MfaSection from './MfaSection'
import PasswordForm from './PasswordForm'
import SignOutEverywhere from './SignOutEverywhere'

/** The page the sign-in returns to after "sign in again". */
const SECURITY_PATH = '/admin/security'

/**
 * The Security page: two-step verification, the password, and "Sign out everywhere". It holds the one thing the three share: the
 * "sign in again" banner. Every change needs a sign-in within the last ten minutes; when the backend says it is too old, the
 * section keeps what the person typed and the banner offers the sign-in that returns here. An account with a password signs in with it;
 * a GitHub account (an author) signs in with GitHub again.
 *
 * A session that is gone altogether goes to the sign-in.
 */
export default function SecurityPanel({ status, role }: { status: MfaStatus; role: AdminRole | null }) {
  const t = useTranslations('Admin.security')
  const router = useRouter()
  const [reauthenticate, setReauthenticate] = useState(false)

  function refused(reply: FailedReply) {
    if (reply.reauthenticate) setReauthenticate(true)
    if (reply.sessionExpired) router.replace('/admin/login')
  }

  return (
    <div className="max-w-2xl space-y-6">
      {reauthenticate && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm leading-6 text-amber-900">{t('reauth')}</p>
          {status.hasPassword ? (
            <Link href={adminLoginPath(SECURITY_PATH)} className={button('primary', 'md', 'shrink-0')}>
              {t('reauthAction')}
            </Link>
          ) : (
            <GitHubLoginLink returnTo={SECURITY_PATH} className={button('primary', 'md', 'shrink-0')}>
              {t('reauthAction')}
            </GitHubLoginLink>
          )}
        </div>
      )}
      <MfaSection status={status} role={role} onRefused={refused} />
      <PasswordForm status={status} onRefused={refused} />
      <SignOutEverywhere />
    </div>
  )
}
