// frontend/app/admin/login/enroll/page.tsx
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { CARD } from '@/components/admin/ui'
import { MFA_CHALLENGE_COOKIE } from '@/lib/auth-cookies'
import { firstParam } from '@/lib/first-param'
import { adminLoginPath, safeAdminNext } from '@/lib/return-to'
import { getDefaultSiteContent } from '@/lib/site-content'
import LoginFrame from '../LoginFrame'
import EnrollForm from './EnrollForm'

export async function generateMetadata() {
  const t = await getTranslations('Admin.login.enroll')
  return { title: t('title') }
}

/**
 * The forced enrollment: an administrator has no authenticator yet, so the sign-in cannot finish without setting one up. Like the
 * code page it exists only with a challenge cookie. `?code=1` is the hint that the operator's enrollment code is asked first; it only
 * chooses which step to draw, the backend decides (a wrong hint is corrected by the first refusal).
 */
export default async function EnrollPage(props: PageProps<'/admin/login/enroll'>) {
  const { next: rawNext, code } = await props.searchParams
  const next = safeAdminNext(firstParam(rawNext))
  if (!(await cookies()).get(MFA_CHALLENGE_COOKIE)?.value) redirect(adminLoginPath(next))

  const t = await getTranslations('Admin.login.enroll')
  const { site } = await getDefaultSiteContent()
  return (
    <LoginFrame siteName={site.name} title={t('title')} lead={t('lead')}>
      <div className={`${CARD} mt-8 p-6 sm:p-8`}>
        <EnrollForm next={next} askEnrollmentCode={firstParam(code) === '1'} />
      </div>
    </LoginFrame>
  )
}
