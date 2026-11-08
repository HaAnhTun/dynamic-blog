/**
 * The shape of the per-owner site content (what used to live in `content/profile.ts`, `case-studies.ts` and
 * `blogroll.ts`). The backend validates the same shapes (`com.blog.sitecontent.schema`); the packaged defaults in
 * `content/defaults/<locale>/<key>.json` are checked against them by a backend test. Plain data, safe to import from
 * client code. Text fields are plain text: render them as React text, never as HTML.
 */

export const SITE_CONTENT_KEYS = [
  'site',
  'profile',
  'about',
  'skills',
  'now',
  'timeline',
  'contact',
  'blogroll',
  'case_studies',
] as const

export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number]

/** The site as a whole: the brand shown in the header, footer, titles and feeds. */
export interface SiteData {
  /** The site name, used wherever the site is named (title template, header, footer, feeds, admin shell). */
  name: string
  /** One short line after the name on the home page title and in the share image; may be empty. */
  tagline: string
  /** A positioning sentence: meta description, footer, feed description; may be empty. */
  positioning: string
}

export interface Hero {
  greeting: string
  headline: string
  subline: string
}

export interface Profile {
  /** The person: author name in JSON-LD, the about card. */
  name: string
  location: string
  role: string
  seeking: string | null
  /** `/media/<uuid>.jpg|png` (an uploaded image) or `null`. */
  avatar: string | null
  /** The lead sentence under the gallery title, or `null`. */
  galleryLead: string | null
  hero: Hero
}

export interface AboutSection {
  /** Lowercase letters, digits and hyphens; unique in the list. */
  id: string
  title: string
  /** One element per paragraph. */
  body: string[]
}

/** The most characters of `About.body`; the backend refuses a longer one. */
export const ABOUT_BODY_MAX = 20000

export interface About {
  intro: string
  sections: AboutSection[]
  /**
   * The body of the About page as Markdown with the same article blocks as a post (`lib/blocks`). Absent or empty means none; rendered
   * through `renderMarkdown`, never as HTML. At most `ABOUT_BODY_MAX` characters.
   */
  body?: string
  /**
   * The photo of the About page: `/media/<uuid>.jpg|png|webp` (an image stored by the profile import) or absent/`null` for none. The
   * hero shows it before `profile.avatar`. It comes only from an import, so the admin editor keeps it and can remove it, not set it.
   */
  photo?: string | null
}

export type SkillLevel = 'used-in-project' | 'worked-with' | 'learning'

/** The display order of the legend, from deepest to shallowest. */
export const skillLevelOrder: readonly SkillLevel[] = ['used-in-project', 'worked-with', 'learning']

export interface Skill {
  name: string
  /** When left out, the `defaultLevel` of the group is used. */
  level?: SkillLevel
  note?: string
}

export interface SkillGroup {
  id: string
  title: string
  defaultLevel: SkillLevel
  items: Skill[]
}

export function resolveSkillLevel(group: SkillGroup, skill: Skill): SkillLevel {
  return skill.level ?? group.defaultLevel
}

export interface NowItem {
  text: string
  /** `href` is an https URL or a path of this site that starts with a single slash. */
  evidence?: { href: string; label: string }
}

export interface Now {
  /** YYYY-MM-DD. */
  lastUpdated: string
  intro: string
  items: NowItem[]
}

export type TimelineKind = 'education' | 'experience'

/** The limits of the optional fields of a timeline entry; the backend refuses more (`com.blog.sitecontent.schema`). */
export const TIMELINE_LIMITS = {
  summary: 600,
  location: 80,
  department: 80,
  highlights: 12,
  highlight: 300,
  tech: 30,
  techItem: 40,
} as const

/**
 * One card of the journey: an experience (company, role) or a degree (school, degree). The fields after `summary` are optional and
 * an older stored entry without them stays valid: absent, `null`, an empty string and an empty list all mean "not set".
 */
export interface TimelineEntry {
  kind: TimelineKind
  /** The role of an experience or the degree of an education entry. */
  title: string
  /** The company or the school. */
  org: string | null
  /** Free text, for example `09/2023 - Present`. */
  period: string | null
  /** The short blurb under the heading. */
  summary: string
  /** An `https://` page of the company or the school; the name links to it. */
  url?: string | null
  location?: string | null
  department?: string | null
  /** Bullet points of what was done. */
  highlights?: string[]
  /** Technology pills. */
  tech?: string[]
  /** `/media/<uuid>.jpg|png`: a logo stored by the profile import; the admin editor keeps or removes it, it cannot set one. */
  logo?: string | null
}

export interface Timeline {
  experienceSummary: string
  entries: TimelineEntry[]
}

export interface SocialLink {
  label: string
  /** `https://` or `mailto:`. */
  url: string
}

export interface Contact {
  email: string | null
  /** An `https://` URL or `null`. */
  github: string | null
  blurb: string
  social: SocialLink[]
}

export interface BlogrollEntry {
  name: string
  url: string
  note?: string
}

/** One measurement. `source` (a command, `file:line` or a commit) is what separates it from a boast; it is required. */
export interface Measurement {
  label: string
  value: string
  source: string
}

export interface CaseStudy {
  /** Lowercase letters, digits and hyphens; the URL is `/case-studies/<slug>`. */
  slug: string
  title: string
  summary: string
  problem: string[]
  constraints: string[]
  solution: string[]
  results: Measurement[]
  ifRedone: string[]
  readMore: { slug: string }[]
  /** YYYY-MM-DD. */
  lastVerified: string
}

/** What a page receives: every key resolved (database row, default-locale row or packaged default). */
export interface SiteContent {
  site: SiteData
  profile: Profile
  about: About
  skills: SkillGroup[]
  now: Now
  timeline: Timeline
  contact: Contact
  blogroll: BlogrollEntry[]
  caseStudies: CaseStudy[]
}

/** The stored (JSON) payload of each key. `skills`, `blogroll` and `case_studies` wrap their list in an object. */
export interface SiteContentPayloads {
  site: SiteData
  profile: Profile
  about: About
  skills: { groups: SkillGroup[] }
  now: Now
  timeline: Timeline
  contact: Contact
  blogroll: { entries: BlogrollEntry[] }
  case_studies: { items: CaseStudy[] }
}

export function toSiteContent(payloads: SiteContentPayloads): SiteContent {
  return {
    site: payloads.site,
    profile: payloads.profile,
    about: payloads.about,
    skills: payloads.skills.groups,
    now: payloads.now,
    timeline: payloads.timeline,
    contact: payloads.contact,
    blogroll: payloads.blogroll.entries,
    caseStudies: payloads.case_studies.items,
  }
}

export function findCaseStudy(content: Pick<SiteContent, 'caseStudies'>, slug: string): CaseStudy | undefined {
  return content.caseStudies.find((study) => study.slug === slug)
}
