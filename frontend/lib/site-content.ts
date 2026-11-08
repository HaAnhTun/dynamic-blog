import 'server-only'
import { cache } from 'react'
import { defaultPayloads } from '@/content/defaults'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { getJson } from './fetch-json'
import {
  SITE_CONTENT_KEYS,
  toSiteContent,
  type SiteContent,
  type SiteContentKey,
  type SiteContentPayloads,
} from './site-content-types'

/** The cache tag of every site content read. An admin save (server action) calls `updateTag(SITE_CONTENT_TAG)`. */
export const SITE_CONTENT_TAG = 'site-content'

type PublicSiteContent = {
  locale: string
  defaultLocale: string
  locales: string[]
  /** The stored payload of each key that has a row for this locale or for the default locale. */
  sections: Partial<Record<SiteContentKey, unknown>>
}

/**
 * The last good answer of the backend per locale, kept in this process. When the backend is unreachable at the next
 * revalidation the page keeps the owner's content instead of dropping to the packaged defaults; the defaults are only
 * used when nothing was ever read (a build without a backend, a fresh process with the backend down).
 */
const lastGood = new Map<Locale, Partial<Record<SiteContentKey, unknown>>>()

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolve(locale: Locale, sections: Partial<Record<SiteContentKey, unknown>>): SiteContent {
  const payloads = { ...defaultPayloads(locale) } as Record<SiteContentKey, unknown>
  for (const key of SITE_CONTENT_KEYS) {
    const value = sections[key]
    if (isObject(value)) payloads[key] = value
  }
  return toSiteContent(payloads as unknown as SiteContentPayloads)
}

/**
 * The site content for one locale: for each key the database row of that locale, else the row of the default locale
 * (the backend decides), else the neutral packaged default. Never throws: the site must render with an empty database,
 * a down backend and no backend at build time. Memoized per request.
 */
export const getSiteContent = cache(async (locale: Locale): Promise<SiteContent> => {
  try {
    const { data } = await getJson<PublicSiteContent>(`/api/v1/site-content?locale=${locale}`, {
      next: { revalidate: 300, tags: [SITE_CONTENT_TAG] },
    })
    lastGood.set(locale, data.sections ?? {})
    return resolve(locale, data.sections ?? {})
  } catch {
    return resolve(locale, lastGood.get(locale) ?? {})
  }
})

/** For code with no page locale (admin shell, login, root metadata): the site content in the default locale. */
export function getDefaultSiteContent(): Promise<SiteContent> {
  return getSiteContent(DEFAULT_LOCALE)
}
