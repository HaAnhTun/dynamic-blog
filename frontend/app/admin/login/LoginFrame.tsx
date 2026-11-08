import { useTranslations } from 'next-intl'
import Link from 'next/link'
import type { ReactNode } from 'react'
import AdminLanguageSwitcher from '@/components/admin/AdminLanguageSwitcher'
import { BACK_LINK, H1, LEAD } from '@/components/admin/ui'
import { ChevronLeftIcon } from '@/components/icons'

/**
 * The frame the admin sign-in pages share (`/admin/login`, `/admin/login/mfa`, `/admin/login/enroll`): none of them sits inside the
 * shell, so none has a sidebar to say whose blog this is. A narrow centred column: the site name, the heading, then `children` (the card),
 * a way back to the blog and the admin language switcher. See app/admin/login/page.tsx for why these pages are self-contained.
 *
 * Synchronous on purpose: the pages read the site name and the translations, and the tests render a page by calling it.
 */
export default function LoginFrame({
  siteName,
  title,
  lead,
  children,
}: {
  siteName: string
  title: string
  lead?: string
  children: ReactNode
}) {
  const t = useTranslations('Admin.login')
  return (
    // Same wrapper as the shell (app/admin/(shell)/layout.tsx): admin has a single theme, light.
    // Without it, in the dark theme this page follows the site's #0a0a0a background while still using
    // light-theme colour classes: the bg-slate-900 button sinks into the background (1.11:1) and the
    // red-700 error text drops to 3.06:1 (visual QA).
    <div data-admin className="min-h-screen bg-slate-50 text-slate-900 [color-scheme:light]">
      {/* A narrow centred column: site name, heading, then the card holding the form. py-12 keeps
          breathing room when the screen is shorter than the content (phone in landscape): the block
          grows longer instead of overflowing. */}
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
        <div className="text-center">
          {/* The page sits outside the shell, so no sidebar says whose blog this is. */}
          <p className="text-sm font-medium text-slate-600">{siteName}</p>
          <h1 className={`${H1} mt-2`}>{title}</h1>
          {lead !== undefined && <p className={LEAD}>{lead}</p>}
        </div>
        {children}
        {/* A way out for people who landed here from an old link: if not signing in, go read the blog. */}
        <p className="mt-6 text-center">
          <Link href="/" className={BACK_LINK}>
            <ChevronLeftIcon />
            {t('backToBlog')}
          </Link>
        </p>
        <AdminLanguageSwitcher className="mt-4 flex justify-center" />
      </main>
    </div>
  )
}
