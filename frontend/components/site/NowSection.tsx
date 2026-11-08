import type { Now } from '@/lib/site-content-types'
import { Link } from '@/i18n/navigation'
import { Container } from './Container'
import { BAND } from './reader/reader-layout'
import { INLINE_LINK, SectionHeading } from './SectionHeading'
import type { Locale } from '@/i18n/config'
import { formatDate } from '@/lib/date'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/**
 * `lastUpdated` is a plain 'YYYY-MM-DD' string in the content file, and this section is
 * the one part of the site that is EXPECTED to go stale — so the date is rendered rather
 * than hidden, and a reader can judge the list's age for themselves.
 *
 * `timeZone: 'UTC'` is not decoration. '2026-10-04' parses as UTC midnight; formatted in
 * a zone west of UTC it is the 3rd. The suite pins TZ to Asia/Ho_Chi_Minh for exactly
 * this class of bug, and lib/date.ts makes the same call for every post date.
 *
 * The NaN branch exists because `Intl.DateTimeFormat.format` THROWS a RangeError on an
 * invalid date rather than returning a placeholder, which would take the whole homepage
 * down over a typo in a content file. Falling back to the raw string shows the author
 * what they typed, which is also the fastest way for them to spot it.
 */
function formatUpdated(lastUpdated: string, locale: Locale): string {
  // Falls back to the raw string rather than to nothing: this value comes from a content
  // file an author edits by hand, and showing them what they typed is the fastest way to
  // spot a typo. formatDate returns null for an unparseable value, which is the right
  // answer for an API timestamp and the wrong one here.
  return formatDate(lastUpdated, 'long', locale) ?? lastUpdated
}

export function NowSection({
  data,
  bare = false,
}: {
  data: Now
  /** No Container and no vertical padding: the page places the section in a grid cell of a band it owns. */
  bare?: boolean
}) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.home.now')
  const content = (
    <>
      <SectionHeading id="hien-tai" title={t('title')} lead={data.intro} />

      <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
        {/* dateTime carries the machine-readable value even when the visible text is a
            fallback, so the markup stays honest in both branches. */}
        {t.rich('updated', {
          date: formatUpdated(data.lastUpdated, locale),
          time: (chunks) => <time dateTime={data.lastUpdated}>{chunks}</time>,
        })}
      </p>

      {/* A left rule instead of list markers. `list-disc` on a flex or grid child is the
          kind of thing that renders differently per browser; a border never is. */}
      <ul className="mt-6 space-y-2 border-l border-neutral-200 pl-5 text-neutral-800 dark:border-neutral-800 dark:text-neutral-200">
        {data.items.map((item) => (
          <li key={item.text}>
            {item.text}
            {/* Evidence, only when there is any. A line "currently learning X" is a claim; a link to
                something written about X is something the reader can check alone. An item without any
                renders nothing — padding with links is proving oneself with oneself. */}
            {item.evidence && (
              <>
                {' — '}
                <Link href={item.evidence.href} className={INLINE_LINK}>
                  {item.evidence.label} →
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  )

  if (bare) return <section aria-labelledby="hien-tai">{content}</section>
  return (
    <Container as="section" labelledBy="hien-tai" className={BAND}>
      {content}
    </Container>
  )
}
