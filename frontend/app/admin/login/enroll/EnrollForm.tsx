// frontend/app/admin/login/enroll/EnrollForm.tsx
'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import EnrollFlow from '@/components/admin/security/EnrollFlow'
import { adminLoginPath } from '@/lib/return-to'

/**
 * The two endpoints of the forced enrollment. Each must equal the folder of its route.ts under app/admin/login/enroll/ and an entry
 * of SIGN_IN_STEP_PATHS in proxy.ts. Exported so the test asserts the same constants.
 */
export const ENROLL_BEGIN_ENDPOINT = '/admin/login/enroll/begin'
export const ENROLL_CONFIRM_ENDPOINT = '/admin/login/enroll/confirm'

/**
 * The forced enrollment of an administrator, after the first factor. `askEnrollmentCode` is the `?code=1` hint of the backend's
 * 202 (the operator's enrollment code is asked first); the flow also asks when the backend refuses a begin without one.
 */
export default function EnrollForm({ next, askEnrollmentCode }: { next: string; askEnrollmentCode: boolean }) {
  const t = useTranslations('Admin.login.enroll')
  const router = useRouter()
  return (
    <EnrollFlow
      beginUrl={ENROLL_BEGIN_ENDPOINT}
      confirmUrl={ENROLL_CONFIRM_ENDPOINT}
      fields={askEnrollmentCode ? ['enrollmentCode'] : []}
      doneLabel={t('continue')}
      // replace, not push: the back button must not return to an enrollment that is already done.
      onDone={() => router.replace(next)}
      restartHref={adminLoginPath(next)}
    />
  )
}
