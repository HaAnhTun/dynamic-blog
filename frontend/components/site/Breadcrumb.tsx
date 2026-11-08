import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Translator } from '@/i18n/translator'
import { FolderIcon, LayersIcon } from '@/components/icons'
import type { Category } from '@/lib/types'
import type { JsonLdLink } from './JsonLd'
import { META_ICON } from './ReadingMeta'
import { FOCUS, TAP_TARGET, TRANSITION } from './SectionHeading'

/**
 * The steps above a post: the Writing root, then the category if any.
 *
 * One function for both the visible breadcrumb and the post page's `BreadcrumbJsonLd`: structured data
 * must describe exactly what the page shows, and two lists built by two expressions are two lists
 * that will drift apart one day. The post page adds itself at the end when building JSON-LD; the visible version stops at
 * the category, because the h1 right below is already the post title.
 *
 * The Writing label rather than "Home": the header treats Writing as the owner of /posts, and the home page
 * is already reached through the site name in the header.
 *
 * `t` is the translator of the `Site.breadcrumb` namespace.
 */
export function breadcrumbTrail(category: Category | null, t: Translator): JsonLdLink[] {
  const trail: JsonLdLink[] = [{ name: t('writing'), url: '/writing' }]
  if (category) {
    trail.push({ name: category.name, url: `/categories/${encodeURIComponent(category.slug)}` })
  }
  return trail
}

/**
 * The steps above a series: the Writing root, then Series, because the header treats Series as one way of viewing
 * Writing. The same convention as `breadcrumbTrail`: one function for the visible version and for
 * `BreadcrumbJsonLd`, and the series page adds itself at the end when building JSON-LD.
 * `t` is the translator of the `Site.breadcrumb` namespace.
 */
export function seriesBreadcrumbTrail(t: Translator): JsonLdLink[] {
  return [
    { name: t('writing'), url: '/writing' },
    { name: t('series'), url: '/series' },
  ]
}

/**
 * The eyebrow text is only 16px tall: TAP_TARGET widens the touch area (to 36px), and 44px on a phone, still clear of the h1 and the
 * meta row below (their gap is 20px, the area reaches 14px below the text).
 */
const LINK = `inline-flex items-center gap-1.5 ${FOCUS} ${TRANSITION} ${TAP_TARGET} max-sm:after:-inset-y-3.5 hover:text-brand`

/**
 * The "/" between two steps is the `::before` of the later step, not text: a real "/" in the DOM becomes
 * a junk entry in the list for a screen reader. Written out verbatim so Tailwind sees it.
 */
const SEPARATOR = "before:mr-2 before:text-neutral-300 before:content-['/'] dark:before:text-neutral-700"

/**
 * The trail at the top of the post page: a `<nav>` labelled as the breadcrumb, containing one `<ol>`.
 *
 * The category moved here from the meta row, so this is the only category link of the post
 * page. The Folder icon separates it from a tag with the same name (an architecture topic is both a category and a tag), and it is
 * aria-hidden so the link name is still only the category name.
 *
 * Eyebrow style (small, uppercase, gray) like the Series label on the series page: this is where the post stands,
 * not content, and it must not compete for the eye with the h1 right below.
 */
export function Breadcrumb({ category }: { category: Category | null }) {
  const t = useTranslations('Site.breadcrumb')
  return <Trail trail={breadcrumbTrail(category, t)} Icon={FolderIcon} />
}

/**
 * The trail at the top of a series page: "Writing / [Layers] Series", the same eyebrow style as the post page.
 * It replaces the old Series label and the old "all series" back link: Series is now a link to /series,
 * and the Layers icon keeps the "this is a series" hint the old label carried.
 */
export function SeriesBreadcrumb() {
  const t = useTranslations('Site.breadcrumb')
  return <Trail trail={seriesBreadcrumbTrail(t)} Icon={LayersIcon} />
}

/** The icon before every step except Writing (the first step): Folder for a category, Layers for Series. */
function Trail({ trail, Icon }: { trail: JsonLdLink[]; Icon: typeof FolderIcon }) {
  const t = useTranslations('Site.breadcrumb')
  return (
    <nav aria-label={t('label')}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
        {trail.map((link, index) => (
          <li key={link.url} className={index > 0 ? `flex items-center ${SEPARATOR}` : 'flex items-center'}>
            <Link href={link.url} className={LINK}>
              {index > 0 ? <Icon size={14} className={META_ICON} /> : null}
              {link.name}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  )
}
