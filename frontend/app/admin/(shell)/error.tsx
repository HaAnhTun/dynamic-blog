'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { button, H1, LEAD, META, PAGE } from '@/components/admin/ui'
import { CircleAlertIcon } from '@/components/icons'

/**
 * Error while building an admin page: the backend does not answer, or answers with an error that is
 * not "session expired" (an expired session is already redirected to login by each page, and 403 has
 * its own local message). Before this file such an error fell through to the public site's
 * app/error.tsx, outside the admin frame, with no sidebar.
 *
 * It lives inside (shell) so the sidebar stays: the user can go to another section at once. `retry`
 * rather than `reset`: retry refreshes server data and then re-renders (Next 16 error-boundary.js),
 * while reset only re-renders the very payload that broke. The `digest` code is the only thing that
 * ties this screen to the server log; the original server error message never reaches the browser
 * in production.
 */
export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations('Admin.shell.error')
  const pathname = usePathname()
  useEffect(() => {
    console.error('Admin page failed to render', error)
  }, [error])
  // Next's boundary only clears the error when the pathname changes, and the segment key ignores the query: an error
  // at /admin?q=… followed by a click on a link to /admin changes the URL but the error screen stays. At /admin itself, only "Try again".
  const onPostList = pathname === '/admin'

  return (
    <div className={PAGE}>
      <div className="max-w-xl">
        <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
          <CircleAlertIcon size={20} />
        </span>
        <h1 className={H1}>{t('title')}</h1>
        <p className={LEAD}>{t('body')}</p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => retry()} className={button('primary')}>
            {t('retry')}
          </button>
          {!onPostList && (
            <Link href="/admin" className={button('secondary')}>
              {t('toPosts')}
            </Link>
          )}
        </div>
        {error.digest !== undefined && <p className={`${META} mt-6`}>{t('digest', { digest: error.digest })}</p>}
      </div>
    </div>
  )
}
