// frontend/app/admin/login/mfa/page.tsx
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { CARD } from '@/components/admin/ui'
import { MFA_CHALLENGE_COOKIE } from '@/lib/auth-cookies'
import { firstParam } from '@/lib/first-param'
import { adminLoginPath, safeAdminNext } from '@/lib/return-to'
import { getDefaultSiteContent } from '@/lib/site-content'
import LoginFrame from '../LoginFrame'
import MfaForm from './MfaForm'

export async function generateMetadata() {
  const t = await getTranslations('Admin.login.mfa')
  return { title: t('title') }
}

/**
 * The second step of a sign-in with a verified authenticator: type the code. It exists only with a challenge cookie, which the
 * first step (the password, or the GitHub callback) sets; without one there is no sign-in in progress and the visitor goes back to
 * the beginning. proxy.ts lets the path through without a session (SIGN_IN_STEP_PATHS). Reading the cookie makes the page dynamic.
 */
export default async function MfaPage(props: PageProps<'/admin/login/mfa'>) {
  const { next: rawNext } = await props.searchParams
  const next = safeAdminNext(firstParam(rawNext))
  if (!(await cookies()).get(MFA_CHALLENGE_COOKIE)?.value) redirect(adminLoginPath(next))

  const t = await getTranslations('Admin.login.mfa')
  const { site } = await getDefaultSiteContent()
  return (
    <LoginFrame siteName={site.name} title={t('title')}>
      <div className={`${CARD} mt-8 p-6 sm:p-8`}>
        <MfaForm next={next} />
      </div>
    </LoginFrame>
  )
}
