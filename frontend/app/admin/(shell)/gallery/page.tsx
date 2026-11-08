import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import GalleryManager from '@/components/admin/GalleryManager'
import { MediaQuotaMeter } from '@/components/admin/MediaQuotaMeter'
import { PageHeader } from '@/components/admin/primitives'
import { PAGE, TEXT_LINK } from '@/components/admin/ui'
import { SessionExpiredError, getMediaUsage, listAdminGallery } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { GalleryPhotoAdmin, MediaUsage } from '@/lib/types'
import { removePhoto, saveOrder, savePhoto, uploadPhoto } from './actions'

/**
 * The storage used by photos, or null when it cannot be read — an old backend without the endpoint (404
 * ENDPOINT_NOT_FOUND), a transient error, or a malformed response body (the JSON is not checked at run time). The gauge is
 * a secondary part of the page: when it disappears, the photo page is still usable. Never throws, so the Promise.all below
 * only fails because of the photo list — including an expired session, which the list call meets at the same moment.
 */
async function mediaUsage(): Promise<MediaUsage | null> {
  try {
    const usage = await getMediaUsage()
    const numbers = [usage?.usedBytes, usage?.maxBytes, usage?.count]
    return numbers.every((value) => typeof value === 'number' && Number.isFinite(value)) ? usage : null
  } catch (error) {
    // 404 means the backend is not updated yet: known, not an incident. Any other error leaves one log line.
    if (!(error instanceof ApiError && error.status === 404)) {
      console.warn(`[admin gallery] Could not read the media usage (${error instanceof Error ? error.message : String(error)}).`)
    }
    return null
  }
}

export default async function GalleryAdminPage() {
  const t = await getTranslations('Admin.gallery')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />

  let photos: GalleryPhotoAdmin[]
  let usage: MediaUsage | null
  try {
    // All of them, no pagination: saving the order needs the permutation of EVERY photo. The usage is read in
    // parallel: two independent requests, in sequence the page is as slow as the sum of both.
    ;[photos, usage] = await Promise.all([listAdminGallery(), mediaUsage()])
  } catch (error) {
    // Only an expired session goes to the login page; a 403 sent there is a loop.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    throw error
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title={t('title')}
        description={t.rich('description', {
          link: (chunks) => (
            <Link href="/gallery" className={TEXT_LINK}>
              {chunks}
            </Link>
          ),
        })}
      />
      {usage !== null && <MediaQuotaMeter usage={usage} />}
      <GalleryManager photos={photos} onUpload={uploadPhoto} onSave={savePhoto} onDelete={removePhoto} onReorder={saveOrder} />
    </div>
  )
}
