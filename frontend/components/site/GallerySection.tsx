import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { GalleryPhoto } from '@/lib/types'
import { Container } from './Container'
import { GalleryGrid } from './GalleryGrid'
import { GalleryLightbox } from './GalleryLightbox'
import { BAND } from './reader/reader-layout'
import { INLINE_LINK, SectionHeading, TOUCH_ROW } from './SectionHeading'

/**
 * The "Photos" section: the first few gallery photos, a 3-column grid, a way to /gallery. The same
 * component on the home page and the About page — the site owner calls it "the personal profile part", and both pages
 * read that way.
 *
 * With no photos it returns null: no stray heading, no hole. The calling page catches API errors itself and passes
 * an empty array, so an error and empty are the same result here.
 *
 * Two layouts:
 * - `band` (home and About pages, inside the site frame): a full frame band, a `Container` of the `reader` width like every
 *   other band there, the SectionHeading title with the "view all photos →" link in the heading row, and a grid of 6 columns
 *   from lg (3 below). With fewer than 6 photos the row ends early and the cells keep their size.
 * - `column` (DEPRECATED, the About page before it moves into the frame): sits inside the text column of the page, which
 *   already has margins, so no Container; the heading like the other sections of that page, and the way to /gallery below the
 *   grid. Removed by the final cleanup ticket.
 *
 * `bare` (band layout only) drops the Container and the vertical padding: the section is only the heading and the grid, so a
 * page can place it in a grid cell or inside a band it already owns.
 *
 * `headingLevel` only accepts 2: both places that use it put the section right under the h1. A literal type so a
 * new use at another level must change the component on purpose, instead of receiving a wrong-level h2.
 */
export function GallerySection({
  id,
  photos,
  layout = 'band',
  bare = false,
}: {
  /** The id of the heading, also the name of the section (`aria-labelledby`) and the `#anh` anchor. */
  id: string
  photos: GalleryPhoto[]
  headingLevel: 2
  layout?: 'band' | 'column'
  /** Band layout only: no Container wrapper and no vertical padding, so the page places the section itself. */
  bare?: boolean
}) {
  const t = useTranslations('Site.gallery')
  if (photos.length === 0) return null
  const title = t('title')
  const all = { href: '/gallery', label: t('seeAll') }

  if (layout === 'column') {
    return (
      <section aria-labelledby={id} className="mt-12">
        <h2 id={id} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        {/* `sizes` follows the text column of /about (`column`): narrower than the wide frame from lg, because the right column is the
            profile card; below lg the page is one column and the grid is as wide as the frame. */}
        <div className="mt-4">
          <GalleryLightbox photos={photos}>
            <GalleryGrid photos={photos} width="column" />
          </GalleryLightbox>
        </div>
        <p className="mt-4 text-sm">
          <Link href={all.href} className={`${INLINE_LINK} ${TOUCH_ROW}`}>
            {all.label} <span aria-hidden="true">→</span>
          </Link>
        </p>
      </section>
    )
  }

  const content = (
    <>
      <SectionHeading id={id} title={title} action={all} />
      <div className="mt-6">
        <GalleryLightbox photos={photos}>
          <GalleryGrid photos={photos} columns={6} width="band" />
        </GalleryLightbox>
      </div>
    </>
  )

  if (bare) {
    return <section aria-labelledby={id}>{content}</section>
  }

  return (
    <Container as="section" width="reader" labelledBy={id} className={BAND}>
      {content}
    </Container>
  )
}
