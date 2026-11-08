import type { Metadata } from 'next'
import { Link } from '@/i18n/navigation'
import { notFound } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import { BrowseFrame } from '@/components/site/BrowseFrame'
import { INLINE_LINK, TITLE_LINK } from '@/components/site/SectionHeading'
import { CaseStudiesGroup } from '@/components/site/reader/CaseStudiesGroup'
import { EYEBROW } from '@/components/site/reader/rail-parts'
import {
  CASE_GRID,
  CASE_RAIL,
  CASE_RAIL_STICKY,
  MEASURE,
  MEASURE_LEAD,
  MEASURE_SMALL,
} from '@/components/site/reader/reader-layout'
import { routing } from '@/i18n/routing'
import { postLinkLocale } from '@/lib/post-language'
import { fetchAllPublishedPosts } from '@/lib/published-posts'
import type { PostSummary } from '@/lib/types'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { getSiteContent } from '@/lib/site-content'
import { type CaseStudy, findCaseStudy } from '@/lib/site-content-types'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * `dynamicParams` is left at its default (`true`) rather than set to `false`: for an unknown slug
 * the `notFound()` just below already returns the correct 404, so turning it off would only move where the same
 * answer is produced.
 */
export async function generateStaticParams() {
  const perLocale = await Promise.all(
    routing.locales.map(async (locale) => {
      const { caseStudies } = await getSiteContent(locale)
      return caseStudies.map((study) => ({ locale, slug: study.slug }))
    }),
  )
  return perLocale.flat()
}

export async function generateMetadata(props: PageProps<'/[locale]/case-studies/[slug]'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.caseStudies' })
  const { slug } = await props.params
  const study = findCaseStudy(await getSiteContent(locale), slug)
  // Do not call notFound() here: generateMetadata runs before the page, and throwing a 404 from here loses
  // the metadata of the 404 response itself. The `notFound()` in the page is what answers the
  // request; this title only ever reaches crawlers.
  if (!study) return { title: t('notFoundTitle') }

  return pageMetadata({
    locale,
    title: study.title,
    description: study.summary,
    canonical: `/case-studies/${study.slug}`,
  })
}

/**
 * The real titles of the cited posts, taken from the API instead of being retyped into the content file.
 *
 * Retyping would create a second copy of a string the site owner can edit through the Admin UI at any
 * time, and that copy would drift at the very first edit, with no error to flag it. Here
 * the case study content keeps only the slug, and the displayed label is always the current title.
 *
 * One request for the whole page rather than one request per post: `fetchAllPublishedPosts`
 * is exactly the function the sitemap and the feed use, so the three places cannot disagree about which posts are
 * publish.
 *
 * Errors are caught, because `next build` prerenders this route and during a `docker build` the API
 * is not running. Losing the API means losing the nice labels, not the whole page: the links still go to the right target,
 * just showing the slug. This is the same handling the home page chose, for the same reason.
 */
async function postsBySlug(): Promise<Map<string, PostSummary>> {
  try {
    // Every language on purpose: a case study cites posts by slug, whatever language they are written in.
    const posts = await fetchAllPublishedPosts()
    return new Map(posts.map((post) => [post.slug, post]))
  } catch {
    return new Map()
  }
}

/**
 * The fixed anchor of every part. Fixed keys rather than ids made from the (translated, editable) titles: the anchor of a shared
 * link must not change when the heading is reworded or the page is read in the other language. The jump target stays below the
 * sticky header through the `scroll-padding-top` of `html` (globals.css), so no heading carries a `scroll-mt` of its own.
 */
const PART_ID = {
  problem: 'problem',
  constraints: 'constraints',
  solution: 'solution',
  results: 'results',
  ifRedone: 'if-redone',
  readMore: 'read-more',
} as const

/** The paragraphs of a part never run wider than 40rem (about 65 characters): the column is wider than a readable line. */
const PROSE = `mt-4 ${MEASURE} space-y-4 leading-relaxed text-neutral-700 dark:text-neutral-300`

/** One "part N" block of the case study. The h2 heading lets the page outline be read by keyboard
 *  and by screen readers, not only by eye; the id is the target of the "On this page" link. */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

function Paragraphs({ body }: { body: readonly string[] }) {
  return (
    <div className={PROSE}>
      {body.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  )
}

/**
 * The results table, and the `source` column is the reason it is a table.
 *
 * A list of numbers without a source is something anyone can write. The third column turns
 * each row into an invitation to check again, and it is a data-type constraint rather than a
 * habit: `Measurement` requires a `source`, so a bare number cannot be added.
 *
 * Wrapped in `overflow-x-auto` because a three-column table containing shell commands would be wider than the text column
 * on a phone: the table may scroll horizontally, the page may not.
 */
function Results({ results }: { results: CaseStudy['results'] }) {
  const t = useTranslations('Site.caseStudies')
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
            <th scope="col" className="py-2 pr-4 font-medium">
              {t('measurement')}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {t('value')}
            </th>
            <th scope="col" className="py-2 font-medium">
              {t('source')}
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={row.label} className="border-b border-neutral-200 dark:border-neutral-800">
              <th scope="row" className="py-2 pr-4 text-left font-normal align-top">
                {row.label}
              </th>
              <td className="py-2 pr-4 align-top font-medium">{row.value}</td>
              <td className="py-2 align-top font-mono text-xs text-neutral-600 dark:text-neutral-400">{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function CaseStudyPage(props: PageProps<'/[locale]/case-studies/[slug]'>) {
  const locale = await setPageLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.caseStudies' })
  const tA = await getTranslations({ locale, namespace: 'Site.about' })
  const { slug } = await props.params
  const study = findCaseStudy(await getSiteContent(locale), slug)
  if (!study) notFound()

  const cited = await postsBySlug()

  // One list drives both the sections and the "On this page" links, so they cannot disagree about order or anchors.
  const toc = [
    { id: PART_ID.problem, title: t('problem') },
    { id: PART_ID.constraints, title: t('constraints') },
    { id: PART_ID.solution, title: t('solution') },
    { id: PART_ID.results, title: t('results') },
    { id: PART_ID.ifRedone, title: t('ifRedone') },
    ...(study.readMore.length > 0 ? [{ id: PART_ID.readMore, title: t('readMore') }] : []),
  ]
  const titleId = 'case-study-title'
  const tocId = 'case-study-toc'
  const title = (id: string) => toc.find((item) => item.id === id)!.title

  return (
    <BrowseFrame extra={<CaseStudiesGroup locale={locale} current={study.slug} />}>
      <article aria-labelledby={titleId}>
        <h1 id={titleId} className="max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
          {study.title}
        </h1>
        <p className={`mt-4 ${MEASURE_LEAD} text-lg leading-relaxed text-neutral-600 dark:text-neutral-400`}>{study.summary}</p>

        <div className={CASE_GRID}>
          <div className="min-w-0">
            <Section id={PART_ID.problem} title={title(PART_ID.problem)}>
              <Paragraphs body={study.problem} />
            </Section>

            <Section id={PART_ID.constraints} title={title(PART_ID.constraints)}>
              <Paragraphs body={study.constraints} />
            </Section>

            <Section id={PART_ID.solution} title={title(PART_ID.solution)}>
              <Paragraphs body={study.solution} />
            </Section>

            <Section id={PART_ID.results} title={title(PART_ID.results)}>
              <Results results={study.results} />
              <p className={`mt-3 ${MEASURE_SMALL} text-sm text-neutral-500 dark:text-neutral-400`}>
                {t('lastRun', { date: study.lastVerified })}
              </p>
            </Section>

            <Section id={PART_ID.ifRedone} title={title(PART_ID.ifRedone)}>
              <Paragraphs body={study.ifRedone} />
            </Section>

            {study.readMore.length > 0 && (
              <Section id={PART_ID.readMore} title={title(PART_ID.readMore)}>
                <ul className="mt-4 space-y-2 leading-relaxed text-neutral-700 dark:text-neutral-300">
                  {study.readMore.map((item) => (
                    <li key={item.slug}>
                      <Link
                        href={`/posts/${item.slug}`}
                        locale={postLinkLocale({ language: cited.get(item.slug)?.language }, locale)}
                        className={INLINE_LINK}
                      >
                        {cited.get(item.slug)?.title ?? item.slug}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>

          {/* The right column, from `rail`: one link per part. Below it the page is short enough to scroll without. */}
          <div className={CASE_RAIL}>
            <div className={`mt-10 ${CASE_RAIL_STICKY}`}>
              <nav aria-labelledby={tocId} className="min-h-0 overflow-y-auto">
                <p id={tocId} className={EYEBROW}>
                  {tA('onThisPage')}
                </p>
                <ul className="mt-3 space-y-2 text-sm">
                  {toc.map((item) => (
                    <li key={item.id}>
                      <a href={`#${item.id}`} className={`text-neutral-700 dark:text-neutral-300 ${TITLE_LINK}`}>
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </div>
        </div>

        <nav
          aria-label={t('readNext')}
          className="mt-12 flex flex-wrap gap-x-6 gap-y-3 border-t border-neutral-200 pt-6 text-sm dark:border-neutral-800"
        >
          <Link href="/case-studies" className={INLINE_LINK}>
            {t('allCaseStudies')}
          </Link>
          <Link href="/writing" className={INLINE_LINK}>
            {t('posts')}
          </Link>
        </nav>
      </article>
    </BrowseFrame>
  )
}
