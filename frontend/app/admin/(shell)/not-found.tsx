import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { button, H1, LEAD, PAGE } from '@/components/admin/ui'

/**
 * `notFound()` from an admin page (a deleted or unknown post, series, topic): the message inside the admin frame, with a way back.
 * It lives in (shell) so the sidebar stays; before the shared root layout went away the public 404 rendered here instead.
 */
export default function AdminNotFound() {
  const t = useTranslations('Admin.shell.notFound')
  return (
    <div className={PAGE}>
      <div className="max-w-xl">
        <h1 className={H1}>{t('title')}</h1>
        <p className={LEAD}>{t('body')}</p>
        <div className="mt-6">
          <Link href="/admin" className={button('secondary')}>
            {t('toPosts')}
          </Link>
        </div>
      </div>
    </div>
  )
}
