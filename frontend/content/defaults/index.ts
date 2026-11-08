import type { Locale } from '@/i18n/config'
import {
  SITE_CONTENT_KEYS,
  toSiteContent,
  type SiteContent,
  type SiteContentKey,
  type SiteContentPayloads,
} from '@/lib/site-content-types'
import enAbout from './en/about.json'
import enBlogroll from './en/blogroll.json'
import enCaseStudies from './en/case_studies.json'
import enContact from './en/contact.json'
import enNow from './en/now.json'
import enProfile from './en/profile.json'
import enSite from './en/site.json'
import enSkills from './en/skills.json'
import enTimeline from './en/timeline.json'
import viAbout from './vi/about.json'
import viBlogroll from './vi/blogroll.json'
import viCaseStudies from './vi/case_studies.json'
import viContact from './vi/contact.json'
import viNow from './vi/now.json'
import viProfile from './vi/profile.json'
import viSite from './vi/site.json'
import viSkills from './vi/skills.json'
import viTimeline from './vi/timeline.json'

/**
 * The neutral packaged defaults: no name, employer or link of any real owner. They are what a fresh install shows, what the
 * site falls back to when the backend is down or a key has no row, and what the build uses with no backend at all.
 */
const DEFAULTS: Record<Locale, SiteContentPayloads> = {
  en: {
    site: enSite,
    profile: enProfile,
    about: enAbout,
    skills: enSkills,
    now: enNow,
    timeline: enTimeline,
    contact: enContact,
    blogroll: enBlogroll,
    case_studies: enCaseStudies,
  } as SiteContentPayloads,
  vi: {
    site: viSite,
    profile: viProfile,
    about: viAbout,
    skills: viSkills,
    now: viNow,
    timeline: viTimeline,
    contact: viContact,
    blogroll: viBlogroll,
    case_studies: viCaseStudies,
  } as SiteContentPayloads,
}

/** The stored payload of one key, as packaged. */
export function defaultPayload<K extends SiteContentKey>(locale: Locale, key: K): SiteContentPayloads[K] {
  return DEFAULTS[locale][key]
}

export function defaultPayloads(locale: Locale): SiteContentPayloads {
  return DEFAULTS[locale]
}

export function defaultSiteContent(locale: Locale): SiteContent {
  return toSiteContent(DEFAULTS[locale])
}

export { SITE_CONTENT_KEYS }
