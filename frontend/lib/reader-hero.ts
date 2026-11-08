import type { Adjacent, SeriesNeighbours } from '@/components/site/PostNav'
import type { Profile as SiteProfile } from './site-content-types'
import type { LeftRailModel } from './reader-rail'
import { profileHref } from './profile'
import type { Post, PostSummary, SeriesRef } from './types'

/**
 * The pure decisions of the post hero (the block above the article: series badge, author row, Next button), kept out of the
 * components so they can be tested without rendering: who the author is and how to show them, which series label to print, which
 * post "Next" leads to. Nothing here fetches or reads a request.
 */

/** The author row of the hero: display name, the picture to draw (or none) and where the name leads (or nowhere). */
export type HeroAuthor = {
  name: string
  /**
   * `image`: a path or URL filled in by the site owner (profile avatar), drawn as a plain 32px image.
   * `github`: a GitHub picture, drawn through `Avatar` (host check, initial-letter fallback when the picture is missing or fails).
   * null: no picture at all: a fake face is worse than none, so the site owner without any picture shows the name alone.
   */
  avatar: { kind: 'image' | 'github'; src: string } | null
  /** The profile path (`/about` for the site owner, `/u/<slug>` for anyone else); null leaves the name as plain text. */
  href: string | null
}

/** The series label of the meta line; `badge` is null when the series could not be loaded and only the post's own reference is known. */
export type HeroSeries = { title: string; slug: string; badge: { current: number; total: number } | null }

/** Where "Next" leads: the next part of the series, or the next post by time. null: nothing to lead to, the button is not drawn. */
export type NextReading = { kind: 'part' | 'post'; post: PostSummary } | null

/** The same origin the author box and Avatar accept; any other host is not drawn. */
const GITHUB_AVATAR_ORIGIN = 'https://avatars.githubusercontent.com/'

/**
 * The "after" side of PostNav, as one value. A post in a series that has a neighbouring part follows the parts only: the next
 * part, or null at the last one, WITHOUT falling back to time (the two ways of going are not mixed). Only a post with no usable
 * series neighbour (not in a series, or the only published part) falls back to the next post by time (`adjacent.next`, the NEWER one).
 */
export function nextReading(input: { series: SeriesNeighbours | null; adjacent: Adjacent }): NextReading {
  const { series, adjacent } = input
  if (series && (series.previous || series.next)) return series.next ? { kind: 'part', post: series.next } : null
  return adjacent.next ? { kind: 'post', post: adjacent.next } : null
}

/**
 * Who to show in the author row. Another author (not the site owner): their display name, their GitHub picture through Avatar
 * (an empty `src` when the backend has none, which Avatar draws as an initial-letter circle, the same as the author box), and
 * their profile link when they have a slug. The site owner, or an old backend that sends no author: the profile name, `/about`,
 * and the first picture that exists (profile avatar, then the GitHub picture of the linked account), else no picture.
 */
export function authorIdentity(author: Post['author'], profile: SiteProfile): HeroAuthor {
  if (author && !author.siteOwner) {
    return {
      name: author.displayName,
      avatar: { kind: 'github', src: author.avatarUrl ?? '' },
      href: profileHref(author),
    }
  }
  const github = author?.avatarUrl?.startsWith(GITHUB_AVATAR_ORIGIN) ? author.avatarUrl : null
  return {
    name: profile.name,
    avatar: profile.avatar ? { kind: 'image', src: profile.avatar } : github ? { kind: 'github', src: github } : null,
    href: '/about',
  }
}

/**
 * The series shown in the meta line. From the left rail model when the series loaded (title, slug and the position among the
 * published parts, never the stored `position`); else the post's own reference without a badge; else none.
 */
export function heroSeries(primary: LeftRailModel['primary'], postSeries: SeriesRef | null | undefined): HeroSeries | null {
  if (primary?.kind === 'series') {
    return { title: primary.title, slug: primary.slug, badge: { current: primary.current, total: primary.total } }
  }
  return postSeries ? { title: postSeries.title, slug: postSeries.slug, badge: null } : null
}

/** "03 / 07": both numbers padded to two digits, a wider number stays whole. */
export function partBadge(current: number, total: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(current)} / ${pad(total)}`
}
