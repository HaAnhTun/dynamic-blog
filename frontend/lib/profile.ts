import type { Translator } from '@/i18n/translator'

/**
 * The public profile of a person: identity, path and link to the profile.
 *
 * A pure module, not `server-only`: CommentItem (client) and the /u/[slug] page (server) build links by the same
 * rule, so a comment and the author box never point to two different places for the same person.
 */

/** The shape of the `profileSlug` the backend issues: lower case letters and digits, hyphens only in the middle. */
const PROFILE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PROFILE_SLUG_MAX = 64

export function isProfileSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PROFILE_SLUG_MAX && PROFILE_SLUG.test(value)
}

/** Profile path. A valid slug has only URL-safe characters, so it needs no encoding. */
export function profilePath(slug: string): string {
  return `/u/${slug}`
}

/**
 * Where a person's name and avatar lead: the site owner to /about (the full profile page already exists), anyone else to
 * /u/<slug>. null means no link: no writer (a comment that is hidden or deleted), a locked person (null slug),
 * an old backend that does not send `profileSlug` yet (then nobody has a link, the site owner included), or a malformed slug.
 */
export function profileHref(author: { siteOwner: boolean; profileSlug?: string | null } | null | undefined): string | null {
  if (!author || !isProfileSlug(author.profileSlug)) return null
  return author.siteOwner ? '/about' : profilePath(author.profileSlug)
}

/**
 * The joined month (vi: month 10/2026), in UTC like lib/date.ts (the printed date must not change with the server's time zone).
 * null when unreadable, the same contract as `formatDate`.
 */
export function formatJoinedMonth(iso: string | null | undefined, t: Translator): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return t('joinedMonth', { month: String(date.getUTCMonth() + 1), year: String(date.getUTCFullYear()) })
}
