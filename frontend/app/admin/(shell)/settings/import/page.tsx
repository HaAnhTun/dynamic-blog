import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import { PageHeader } from '@/components/admin/primitives'
import ProfileImport from '@/components/admin/settings/profile-import/ProfileImport'
import { PAGE } from '@/components/admin/ui'
import { SessionExpiredError } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { getImportStatus, type ImportStatus } from '@/lib/admin-site-import'
import { ApiError } from '@/lib/api'
import { applyProfile, loadImportStatus, previewProfile, undoProfile } from './actions'

export default async function ProfileImportPage() {
  const t = await getTranslations('Admin.settings.profileImport')
  const tSettings = await getTranslations('Admin.settings')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('page.title')} />

  let status: ImportStatus
  try {
    status = await getImportStatus()
  } catch (error) {
    // Only an expired session goes to the login page; a 403 sent there is a loop.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('page.title')} />
    throw error
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        back={{ href: '/admin/settings', label: tSettings('allSettings') }}
      />
      <ProfileImport
        lastImport={status.lastImport}
        onPreview={previewProfile}
        onApply={applyProfile}
        onUndo={undoProfile}
        onStatus={loadImportStatus}
      />
    </div>
  )
}
