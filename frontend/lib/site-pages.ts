import { navItems } from '@/components/site/nav-items'
import type { Translator } from '@/i18n/translator'

/**
 * The static pages that have a one-sentence description: the page's own metadata and the quick search panel both read it
 * through `pageDescription`, so the two places do not drift apart. Pages whose description is composed from content (About, Gallery,
 * Featured posts) are built from the same site content (`profile.galleryLead`).
 */
export const SITE_PAGE_PATHS = [
  '/writing',
  '/start-here',
  '/case-studies',
  '/about',
  '/topics',
  '/archive',
  '/series',
  '/gallery',
  '/newsletter',
] as const

export type SitePagePath = (typeof SITE_PAGE_PATHS)[number]

/** The message key (in `Site.pageDescriptions`) of each page. The metadata of /about is the question the page answers, same content. */
const DESCRIPTION_KEYS = {
  '/writing': 'writing',
  '/start-here': 'startHere',
  '/case-studies': 'caseStudies',
  '/about': 'about',
  '/topics': 'topics',
  '/archive': 'archive',
  '/series': 'series',
  '/gallery': 'gallery',
  '/newsletter': 'newsletter',
} as const satisfies Record<SitePagePath, string>

/** The site content a description needs; the caller reads it (server) or receives it as props (client). */
export type SitePagesContext = { siteName: string; galleryLead: string | null }

/** `t` is the translator of the namespace `Site.pageDescriptions`. */
export function pageDescription(path: SitePagePath, t: Translator, ctx: SitePagesContext): string {
  if (path === '/gallery' && ctx.galleryLead) return ctx.galleryLead
  return t(DESCRIPTION_KEYS[path], { name: ctx.siteName })
}

export type SitePage = { href: SitePagePath; title: string; description: string }

/** Outside the nav bar: the indexes of the Writing section, the gallery and the newsletter (quick navigation). */
const EXTRA_PAGES = [
  { href: '/topics', titleKey: 'titles.topics' },
  { href: '/archive', titleKey: 'titles.archive' },
  { href: '/series', titleKey: 'titles.series' },
  { href: '/gallery', titleKey: 'titles.gallery' },
  { href: '/newsletter', titleKey: 'titles.newsletter' },
] as const satisfies ReadonlyArray<{ href: SitePagePath; titleKey: string }>

function isSitePagePath(href: string): href is SitePagePath {
  return (SITE_PAGE_PATHS as readonly string[]).includes(href)
}

/**
 * The four items of `navItems` (the single source, in that order), then the secondary pages.
 * `tNav` is the translator of `Site.nav`, `tDesc` of `Site.pageDescriptions`.
 */
export function sitePages(tNav: Translator, tDesc: Translator, ctx: SitePagesContext): readonly SitePage[] {
  return [
    ...navItems.flatMap((item) =>
      isSitePagePath(item.href)
        ? [{ href: item.href, title: tNav(item.labelKey), description: pageDescription(item.href, tDesc, ctx) }]
        : [],
    ),
    ...EXTRA_PAGES.map((page) => ({
      href: page.href,
      title: tDesc(page.titleKey),
      description: pageDescription(page.href, tDesc, ctx),
    })),
  ]
}
