import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import { PageHeader } from '@/components/admin/primitives'
import { PAGE, TEXT_LINK } from '@/components/admin/ui'
import { SessionExpiredError } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { PostSummary } from '@/lib/types'
import { everyAdminPost } from '../every-admin-post'
import CuratedManager from './CuratedManager'
import { feature, saveCuratedOrder, unfeature } from './actions'
import { curatedOrder, newestFirst, toCurated } from './curated'

export default async function CuratedPage() {
  const t = await getTranslations('Admin.curated')
  // Before the call: the post list stays open to AUTHOR (their own posts only), so asking the backend would draw a ranking
  // screen where every button is rejected.
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />

  let posts: PostSummary[]
  try {
    // This screen needs both sides: picked posts (drafts included) and published posts not yet picked.
    posts = await everyAdminPost()
  } catch (error) {
    // Only an expired session goes to the login page; a 403 sent there is a loop.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    throw error
  }

  // A stable sort over a list arriving by creation date descending: two drafts without a rank keep the
  // order the backend finally used (createdAt DESC).
  const featured = posts
    .filter((post) => post.featured)
    .map(toCurated)
    .sort(curatedOrder)
  // Published posts only: picking a draft would give a rank to something nobody sees.
  const candidates = posts
    .filter((post) => !post.featured && post.status === 'PUBLISHED')
    .map(toCurated)
    .sort(newestFirst)

  return (
    // The (shell) layout no longer sets width or margin for the page: each page wraps itself in PAGE.
    <div className={PAGE}>
      {/* No button at the top of the page: the main job, "Save order", sits in the save bar right below the list,
                next to the "Unsaved order." reminder it answers. */}
      <PageHeader
        title={t('title')}
        description={t.rich('description', {
          link: (chunks) => (
            <Link href="/start-here" className={TEXT_LINK}>
              {chunks}
            </Link>
          ),
        })}
      />
      <CuratedManager
        featured={featured}
        candidates={candidates}
        onSave={saveCuratedOrder}
        onFeature={feature}
        onUnfeature={unfeature}
      />
    </div>
  )
}
