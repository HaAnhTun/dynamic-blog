import { useTranslations } from 'next-intl'
import { CircleAlertIcon } from '@/components/icons'
import { EmptyState, PageHeader } from './primitives'
import { PAGE } from './ui'

type Reason = 'post' | 'account'

/**
 * The 403 also used by AUTHOR pages: a post by another author, or a token that still carries an old role. Inside the
 * admin shell: error.tsx (its retry button) does not help, and going back to the login page only to be rejected again is a loop.
 */
export default function NoAccess({
  title,
  reason,
  back = false,
}: {
  title: string
  reason: Reason
  /** Page without a sidebar (editor, preview): adds a way back to the post list. */
  back?: boolean
}) {
  const t = useTranslations('Admin.common.noAccess')
  return (
    <div className={PAGE}>
      <PageHeader title={title} back={back ? { href: '/admin', label: t('back') } : undefined} />
      <EmptyState icon={<CircleAlertIcon />} title={t(`${reason}.title`)}>
        {t(`${reason}.body`)}
      </EmptyState>
    </div>
  )
}
