import type { ReactNode, Ref } from 'react'
import { useLocale } from 'next-intl'
import { BrandIcon } from '@/components/BrandIcon'
import { localizedPath, safeReturnTo } from '@/lib/return-to'

/**
 * The entry point for signing in with GitHub: the button in the header, the /profile page
 * when signed out, and the invitation to comment.
 *
 * - A plain `<a>`, never `<Link>`: Next's router prefetches every `<Link>` it sees on
 *   screen, which would begin an OAuth round on its own (the same reason as app/random/route.ts). `rel="nofollow"`
 *   for crawlers; robots.txt already blocks /api.
 * - `returnTo` always goes through `safeReturnTo` before being encoded: the start route sanitizes it again, but
 *   a link on a page must never carry a foreign target on its own.
 * - The GitHub mark (simple-icons, components/BrandIcon.tsx) is only for the eye, the same color as the text, not the brand
 *   color; the accessible name is always text ("Sign in with GitHub"), it does not fake the GitHub interface.
 */

/**
 * The URL of the start route, with the return target sanitized and encoded. `returnTo` is a path without a locale; with
 * `locale` the reader comes back to the page in the language they were reading (`/en/posts/a`).
 */
export function githubStartHref(returnTo: string | null | undefined, locale?: string): string {
  const target = locale === undefined || !returnTo ? returnTo : localizedPath(returnTo, locale)
  return `/api/auth/github/start?returnTo=${encodeURIComponent(safeReturnTo(target))}`
}

export function GitHubLoginLink({
  returnTo,
  locale: localeOverride,
  children,
  className,
  ref,
  'aria-label': ariaLabel,
  onPointerDown,
  onFocus,
}: {
  /** The page to return to after signing in: a relative path of the site without a locale, possibly with a query and `#`. */
  returnTo: string
  /** The language of the page to return to when it differs from the page's own locale (a post of the other language). */
  locale?: string
  children: ReactNode
  className?: string
  ref?: Ref<HTMLAnchorElement>
  /** For the icon-only form on a narrow screen, when the text inside is hidden. */
  'aria-label'?: string
  /** Right before the link is pressed (mouse, touch) or activated by keyboard: update `returnTo`. */
  onPointerDown?: () => void
  onFocus?: () => void
}) {
  const pageLocale = useLocale()
  const locale = localeOverride ?? pageLocale
  return (
    <a
      ref={ref}
      href={githubStartHref(returnTo, locale)}
      rel="nofollow"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      className={className}
    >
      <BrandIcon name="github" />
      {children}
    </a>
  )
}
