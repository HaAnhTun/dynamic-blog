import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/admin/primitives'
import SecurityPanel from '@/components/admin/security/SecurityPanel'
import { PAGE } from '@/components/admin/ui'
import { SessionExpiredError, getMfaStatus } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import type { MfaStatus } from '@/lib/types'

export async function generateMetadata() {
  const t = await getTranslations('Admin.security')
  return { title: t('title') }
}

/**
 * Security (/admin/security): the signed-in account's two-step verification and password, for ADMIN and AUTHOR (the shell layout
 * already refuses every other role). The status comes from the backend (`GET /me/mfa`); every change goes through the route handlers
 * next to this page, because a change may hand back a new session that only a route handler can put into the cookies.
 * The role is read from the token for drawing only (the administrator has no "Turn off"); the backend is where the rules are enforced.
 */
export default async function SecurityPage() {
  const t = await getTranslations('Admin.security')
  let status: MfaStatus
  try {
    status = await getMfaStatus()
  } catch (error) {
    // Like every admin page: a dead session goes to the sign-in; any other failure is the shell's error page ("Try again").
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    throw error
  }
  const role = await adminRole()

  return (
    <div className={PAGE}>
      <PageHeader title={t('title')} description={t('lead')} />
      <SecurityPanel status={status} role={role} />
    </div>
  )
}
