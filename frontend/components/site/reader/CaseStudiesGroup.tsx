import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/config'
import { getSiteContent } from '@/lib/site-content'
import { FOCUS_RING, TRANSITION } from '../SectionHeading'
import { ACTIVE, EYEBROW, LINK, LIST, TEXT } from './rail-parts'

/**
 * The page's own sidebar group on the two case-study pages (spec 4.2), passed to `BrowseFrame` as `extra`: the eyebrow, a row
 * for the list ("All case studies") and one row per study.
 *
 * It is rendered even with the single shipped study: on these pages the Explore group has no current row, so this group is the
 * only thing that says where the reader is. The current row is `ACTIVE` (still a link, like the header's current item) with
 * `aria-current="page"`; on a detail page the list row is `aria-current="true"` (the section the study belongs to). Titles are
 * one truncated line with the full title in `data-tip` for the tooltip host (`RailTipHost`).
 *
 * `BrowseFrame` renders `extra` once per sidebar copy (phone and desktop), so this group carries no `id`: the list is named
 * with `aria-label` instead of `aria-labelledby`. Class constants come from `rail-parts`; no frame track is defined here.
 *
 * `current` is the slug of the study on the page, or undefined on the list page.
 */
export async function CaseStudiesGroup({ locale, current }: { locale: Locale; current?: string }) {
  const [nav, t, { caseStudies }] = await Promise.all([
    getTranslations({ locale, namespace: 'Site.nav' }),
    getTranslations({ locale, namespace: 'Site.caseStudies' }),
    getSiteContent(locale),
  ])
  if (caseStudies.length === 0) return null

  const title = nav('caseStudies')
  const onList = current === undefined
  return (
    <div className="min-w-0">
      <p className={EYEBROW}>
        <span className="min-w-0 break-words">{title}</span>
      </p>
      <ul aria-label={title} className={`mt-1 ${LIST}`}>
        <li className="min-w-0">
          <Link
            href="/case-studies"
            aria-current={onList ? 'page' : 'true'}
            className={onList ? `${ACTIVE} ${FOCUS_RING} ${TRANSITION}` : LINK}
          >
            <span className={TEXT}>{t('allCaseStudies')}</span>
          </Link>
        </li>
        {caseStudies.map((study) => {
          const isCurrent = study.slug === current
          return (
            <li key={study.slug} className="min-w-0">
              <Link
                href={`/case-studies/${study.slug}`}
                aria-current={isCurrent ? 'page' : undefined}
                className={isCurrent ? `${ACTIVE} ${FOCUS_RING} ${TRANSITION}` : LINK}
                data-tip={study.title}
              >
                <span className={TEXT} data-tip-text="">
                  {study.title}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
