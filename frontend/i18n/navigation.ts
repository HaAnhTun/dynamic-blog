import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

/**
 * Locale-aware replacements of `next/link` and `next/navigation`: `Link` and `getPathname` add the `/<locale>` prefix for a
 * non-default locale, `usePathname` returns the path WITHOUT the prefix (so `isCurrentSection` and the like keep working).
 * Public pages use these; `/admin`, `/api` and `/media` have no locale in the URL and keep `next/link`.
 */
export const { Link, redirect, permanentRedirect, usePathname, useRouter, getPathname } = createNavigation(routing)
