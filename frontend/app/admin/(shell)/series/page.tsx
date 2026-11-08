import { getTranslations } from 'next-intl/server'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import AdminOnly from '@/components/admin/AdminOnly'
import SeriesForm from '@/components/admin/SeriesForm'
import { EmptyState, PageHeader } from '@/components/admin/primitives'
import { CARD, H2, LIST, META, PAGE, SECTION_DESC, TEXT_LINK, WARN_TEXT, button } from '@/components/admin/ui'
import { ChevronRightIcon, LayersIcon, PlusIcon } from '@/components/icons'
import { SessionExpiredError, listAdminSeries } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { Translator } from '@/i18n/translator'
import type { SeriesAdmin } from '@/lib/types'
import { addSeries } from './actions'

/** "3 posts · 1 published"; the published count only when it differs from the total, since "2 posts · 2 published" says it twice. */
function countLine(series: SeriesAdmin, t: Translator): string {
  const total = series.posts.length
  if (total === 0) return t('countNone')
  const published = series.posts.filter((post) => post.status === 'PUBLISHED').length
  return published === total ? t('countAll', { total }) : t('countPartlyPublished', { total, published })
}

/**
 * A link covering the whole row: `after:absolute after:inset-0` spreads the click area over the whole <li> (which carries `relative`),
 * so clicking the secondary line or the blank space also reaches the edit page. The focus ring is drawn on that overlay, inset,
 * because LIST clips anything overflowing the rounded corner.
 */
const ROW_LINK =
  'block text-[15px] font-medium break-words text-slate-900 outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-brand'

function SeriesRow({ series }: { series: SeriesAdmin }) {
  const t = useTranslations('Admin.series')
  // The public page only shows a series with at least one published post: say so, so nobody
  // looks for a just-created series on /series and thinks it is broken.
  const hidden = !series.posts.some((post) => post.status === 'PUBLISHED')
  return (
    <li className="group relative flex items-center gap-3 px-4 py-3 transition-colors duration-150 motion-reduce:transition-none hover:bg-slate-50 sm:gap-4 sm:px-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <Link href={`/admin/series/${encodeURIComponent(series.id)}`} className={ROW_LINK}>
            {/* The spoken name sits entirely in ONE span, the visible name is aria-hidden. Splitting into
                            sr-only "Edit series “" + name + sr-only "”" breaks in a real browser: sr-only is
                            position:absolute so the span becomes a block, and Chrome (and Playwright) insert whitespace
                            around each block, giving "Edit series “ Name ”" (measured with Chrome). */}
            <span className="sr-only">{t('editAria', { title: series.title })}</span>
            <span aria-hidden="true">{series.title}</span>
          </Link>
          <p className={`mt-0.5 ${META}`}>
            {/* break-words, not break-all: the slug breaks at hyphens like ordinary text, splitting mid-word
                            only when one segment is longer than a whole line. */}
            {countLine(series, t)} · <span className="font-mono text-xs break-words">/series/{series.slug}</span>
          </p>
        </div>
        {hidden && (
          <p className={`flex items-center gap-1.5 sm:shrink-0 ${WARN_TEXT}`}>
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
            {t('hiddenOnSite')}
          </p>
        )}
      </div>
      <ChevronRightIcon className="text-slate-500 transition-colors duration-150 motion-reduce:transition-none group-hover:text-slate-900" />
    </li>
  )
}

export default async function SeriesListPage() {
  const t = await getTranslations('Admin.series')
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />

  let all: SeriesAdmin[]
  try {
    all = await listAdminSeries()
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
            <Link href="/series" className={TEXT_LINK}>
              {chunks}
            </Link>
          ),
        })}
        actions={
          // An anchor link, not a button: the create form is at the bottom of the page, and the only "Create series" button is the
          // form's submit button. After anchoring, the next Tab goes straight into the "Series name" field.
          <a href="#tao-series" className={button('secondary')}>
            <PlusIcon />
            {t('create')}
          </a>
        }
      />

      {all.length === 0 ? (
        <EmptyState icon={<LayersIcon />} title={t('emptyTitle')}>
          {t('emptyBody')}
        </EmptyState>
      ) : (
        <ul aria-label={t('listLabel')} className={LIST}>
          {all.map((series) => (
            <SeriesRow key={series.id} series={series} />
          ))}
        </ul>
      )}

      <section aria-labelledby="tao-series" className={`mt-10 p-5 sm:p-6 ${CARD}`}>
        {/* scroll-mt: the "Create series" anchor at the top of the page stops slightly above the heading, so the card edge shows. */}
        <h2 id="tao-series" className={`scroll-mt-24 ${H2}`}>
          {t('createHeading')}
        </h2>
        <p className={SECTION_DESC}>{t('createHint')}</p>
        <div className="mt-5 max-w-xl">
          <SeriesForm series={null} onSubmit={addSeries} />
        </div>
      </section>
    </div>
  )
}
