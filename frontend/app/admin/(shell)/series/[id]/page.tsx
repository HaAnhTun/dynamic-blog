import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import SeriesForm from '@/components/admin/SeriesForm'
import SeriesPartsManager from '@/components/admin/SeriesPartsManager'
import { PageHeader } from '@/components/admin/primitives'
import { CARD, H2, PAGE, SECTION_DESC, button } from '@/components/admin/ui'
import { ArrowUpRightIcon } from '@/components/icons'
import { SessionExpiredError, getAdminSeries } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { PostSummary, SeriesAdmin } from '@/lib/types'
import { everyAdminPost } from '../../every-admin-post'
import { removeSeries, saveSeries, saveSeriesParts } from '../actions'
import { candidatesFor, isSeriesId, toPart } from '../series'
import DeleteSeries from './DeleteSeries'

export default async function EditSeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('Admin.series.edit')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />
  const { id } = await params
  if (!isSeriesId(id)) notFound()

  let series: SeriesAdmin
  let posts: PostSummary[]
  try {
    ;[series, posts] = await Promise.all([getAdminSeries(id), everyAdminPost()])
  } catch (error) {
    // Only an expired session goes to the login page; a 403 sent there is a loop.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    // admin-api throws ApiError(404), not NotFoundError: check by status.
    if (error instanceof ApiError && error.status === 404) notFound()
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    throw error
  }

  // The same way of packaging the id as the post edit page: client components hold no id.
  async function onSave(form: FormData) {
    'use server'
    return saveSeries(id, form)
  }
  async function onSaveParts(postIds: string[]) {
    'use server'
    return saveSeriesParts(id, postIds)
  }
  async function onDelete() {
    'use server'
    return removeSeries(id)
  }

  // /series/{slug} is a 404 until the series has a published part: do not link there.
  const isPublic = series.posts.some((post) => post.status === 'PUBLISHED')

  return (
    <div className={PAGE}>
      <PageHeader
        back={{ href: '/admin/series', label: t('allSeries') }}
        title={t('title')}
        // The h1 title is the same for every series; this sentence says which series is being edited. Saving a new name makes
        // updateTag in the action re-render the page, so the sentence changes along.
        description={t('description', { title: series.title })}
        actions={
          isPublic ? (
            // A new tab, like every "View on blog" of the admin: the order of the parts being arranged (unsaved) must not
            // be lost just to look at the public page.
            <Link
              href={`/series/${encodeURIComponent(series.slug)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('viewOnBlogTitle')}
              className={button('secondary')}
            >
              {t('viewOnBlog')}
              <ArrowUpRightIcon />
            </Link>
          ) : undefined
        }
      />

      {/* Two columns from xl: the parts are the main job so wide; information and delete in the side column. Not from lg: at
                1024px, minus the 15rem sidebar and the 20rem side column, the parts list is left with only ~344px (measured). Below xl
                stacked in exactly DOM order: "Parts", "Info", "Delete". */}
      <div className="flex flex-col gap-10 xl:flex-row xl:items-start">
        <section aria-labelledby="cac-phan" className="min-w-0 xl:flex-1">
          <h2 id="cac-phan" className={H2}>
            {t('partsHeading')}
          </h2>
          <p className={SECTION_DESC}>{t('partsHint')}</p>
          <div className="mt-5">
            <SeriesPartsManager parts={series.posts.map(toPart)} candidates={candidatesFor(series, posts)} onSave={onSaveParts} />
          </div>
        </section>

        <div className="space-y-10 xl:w-80 xl:shrink-0">
          <section aria-labelledby="thong-tin" className={`p-5 sm:p-6 ${CARD}`}>
            <h2 id="thong-tin" className={H2}>
              {t('infoHeading')}
            </h2>
            <div className="mt-5">
              <SeriesForm
                series={{ title: series.title, slug: series.slug, description: series.description }}
                onSubmit={onSave}
              />
            </div>
          </section>

          <DeleteSeries title={series.title} postCount={series.posts.length} onDelete={onDelete} />
        </div>
      </div>
    </div>
  )
}
