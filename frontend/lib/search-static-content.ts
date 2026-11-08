import { createTranslator } from 'next-intl'
import { defaultSiteContent } from '@/content/defaults'
import type { Translator } from '@/i18n/translator'
import vi from '@/messages/vi.json'
import { sitePages } from './site-pages'

/** The committed static content is the Vietnamese text of the pages (the backend indexes the site's default language). */
function viTranslator(namespace: string): Translator {
  return createTranslator({ locale: 'vi', messages: vi as never, namespace: namespace as never }) as unknown as Translator
}

/**
 * The search content only the frontend knows: static pages, case studies and the site owner's identity.
 * The backend searches these types too (both engines), but the backend image cannot see `frontend/`, so the JSON version
 * of this function's output is committed at `backend/src/main/resources/search/static-content.json`. The source remains the packaged
 * defaults and the catalogs: `npm run search:export` rewrites the JSON, and the test of the same name fails when the JSON drifts from the source.
 */
export type StaticSearchContent = {
  version: 1
  owner: { name: string; href: string }
  pages: Array<{ slug: string; href: string; title: string; description: string }>
  caseStudies: Array<{ slug: string; href: string; title: string; summary: string; body: string }>
}

export const STATIC_CONTENT_PATH = '../backend/src/main/resources/search/static-content.json'

/**
 * Built from the PACKAGED defaults, not from a running backend: this feeds `npm run search:export`, which has no backend.
 */
export function buildStaticSearchContent(): StaticSearchContent {
  const { site, profile, caseStudies } = defaultSiteContent('vi')
  return {
    version: 1,
    owner: { name: profile.name, href: '/about' },
    pages: sitePages(viTranslator('Site.nav'), viTranslator('Site.pageDescriptions'), {
      siteName: site.name,
      galleryLead: profile.galleryLead,
    }).map((page) => ({
      slug: page.href.replace(/^\//, ''),
      href: page.href,
      title: page.title,
      description: page.description,
    })),
    caseStudies: caseStudies.map((study) => ({
      slug: study.slug,
      href: `/case-studies/${study.slug}`,
      title: study.title,
      summary: study.summary,
      // The body lets Meilisearch search all five parts; Postgres matches only the title and summary.
      body: [
        ...study.problem,
        ...study.constraints,
        ...study.solution,
        ...study.results.map((result) => `${result.label}: ${result.value}`),
        ...study.ifRedone,
      ].join('\n'),
    })),
  }
}

/** Stable JSON (indent 2, trailing newline): comparable byte by byte with the committed file. */
export function serializeStaticSearchContent(content: StaticSearchContent = buildStaticSearchContent()): string {
  return `${JSON.stringify(content, null, 2)}\n`
}
