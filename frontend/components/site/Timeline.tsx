import { useTranslations } from 'next-intl'
import type { ComponentType } from 'react'
import { BriefcaseIcon, GraduationCapIcon, type IconProps } from '@/components/icons'
import type { Timeline as TimelineContent, TimelineKind } from '@/lib/site-content-types'
import { Container } from './Container'
import { EntryLogo, HighlightList, OrgName, TechPills, joinFacts, textOf } from './entry-parts'
import { BAND } from './reader/reader-layout'
import { SectionHeading } from './SectionHeading'

/**
 * A glyph by the same `kind` field: a mark so the eye skimming the column can tell education from
 * experience without reading the label. It sits on the kind label, not on the h3 title, and is
 * aria-hidden: the text label beside it already says exactly that.
 */
const KIND_ICONS: Record<TimelineKind, ComponentType<IconProps>> = {
  education: GraduationCapIcon,
  experience: BriefcaseIcon,
}

export function Timeline({
  data,
  bare = false,
}: {
  data: TimelineContent
  /** No Container and no vertical padding: the page places the section in a grid cell of a band it owns. */
  bare?: boolean
}) {
  const t = useTranslations('Site.home.timeline')
  const content = (
    <>
      {/* `experienceSummary` is the lead precisely because the entries have no dates:
          it is the content file's answer to "how much experience", given once in prose
          instead of as a span of years nobody can verify. */}
      <SectionHeading id="chang-duong" title={t('title')} lead={data.experienceSummary} />

      {/* <ol>, not <ul>: the entries are in a deliberate order in the data file. */}
      <ol className="mt-6 divide-y divide-neutral-200 sm:mt-8 sm:space-y-8 sm:divide-y-0 sm:border-l sm:border-neutral-200 sm:pl-6 dark:divide-neutral-800 sm:dark:border-neutral-800">
        {data.entries.map((entry) => {
          const KindIcon = KIND_ICONS[entry.kind]
          // `org` and `period` are null on an entry the owner left them out of, on purpose: a fabricated date is the worst thing
          // the content could carry. A blank value is the same absence as a null, so it renders as nothing: no 'N/A', no
          // separator and no empty element holding a margin open. The company or school links to its address when it has one.
          const org = textOf(entry.org)
          const period = textOf(entry.period)
          const place = joinFacts([entry.location, entry.department])
          const summary = textOf(entry.summary)
          return (
            <li key={`${entry.kind}-${entry.title}`} className="py-6 first:pt-0 last:pb-0 sm:py-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {/* `flex` (not inline-flex): the label is still its own block, exactly one
                      line of small text tall, so the gap to the title below does not change. The 14px icon follows the
                      label's color. */}
                  <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
                    <KindIcon size={14} />
                    {/* The message keys are the two `kind` values. */}
                    {t(entry.kind)}
                  </p>

                  <h3 className="mt-1 text-lg font-medium [overflow-wrap:anywhere]">{entry.title}</h3>
                </div>
                <EntryLogo src={entry.logo} className="h-9 w-9" />
              </div>

              {(org !== '' || period !== '') && (
                <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                  {org !== '' && <OrgName name={org} url={entry.url} />}
                  {org !== '' && period !== '' && ' · '}
                  {period}
                </p>
              )}
              {place !== '' && <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{place}</p>}

              {summary !== '' && <p className="mt-2 max-w-2xl text-neutral-700 dark:text-neutral-300">{summary}</p>}
              <HighlightList items={entry.highlights} className="mt-3" collapse />
              <TechPills items={entry.tech} className="mt-3" />
            </li>
          )
        })}
      </ol>
    </>
  )

  if (bare) return <section aria-labelledby="chang-duong">{content}</section>
  return (
    <Container as="section" labelledBy="chang-duong" className={BAND}>
      {content}
    </Container>
  )
}
