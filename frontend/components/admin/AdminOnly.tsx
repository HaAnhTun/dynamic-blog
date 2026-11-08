import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { EmptyState, PageHeader } from '@/components/admin/primitives'
import { PAGE, TEXT_LINK } from '@/components/admin/ui'
import { CircleAlertIcon } from '@/components/icons'

/**
 * "No access" state inside the admin shell: an AUTHOR opens an admin-only page by URL, or a token still
 * carries an old role after being demoted. No redirect: the backend already refused the data, the page only says why.
 */
export default function AdminOnly({ title }: { title: string }) {
  const t = useTranslations('Admin.common.adminOnly')
  return (
    <div className={PAGE}>
      <PageHeader title={title} />
      <EmptyState icon={<CircleAlertIcon />} title={t('title')}>
        {t('body')}{' '}
        <Link href="/admin" className={TEXT_LINK}>
          {t('toMyPosts')}
        </Link>
      </EmptyState>
    </div>
  )
}
