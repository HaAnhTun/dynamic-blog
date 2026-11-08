/**
 * The locales of the site and the default one. Pure data (no next-intl import) so server code, client code, tests and
 * `next.config.ts` can all read it.
 *
 * `NEXT_PUBLIC_DEFAULT_LOCALE` is a BUILD-time setting: Next inlines `NEXT_PUBLIC_*` into the bundles, and the default locale
 * decides which URLs carry no prefix, so changing it means rebuilding the frontend (README, "Default locale").
 */
export const LOCALES = ['vi', 'en'] as const

export type Locale = (typeof LOCALES)[number]

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** An empty `NEXT_PUBLIC_DEFAULT_LOCALE=` line means "not configured" (the same rule as lib/site.ts); an unknown value fails the build. */
function configuredDefault(): Locale {
  const value = process.env.NEXT_PUBLIC_DEFAULT_LOCALE?.trim() || 'vi'
  if (!isLocale(value)) {
    throw new Error(`NEXT_PUBLIC_DEFAULT_LOCALE must be one of ${LOCALES.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return value
}

export const DEFAULT_LOCALE: Locale = configuredDefault()

/** `og:locale` values (Open Graph uses language_TERRITORY). */
const OG_LOCALES: Record<Locale, string> = { vi: 'vi_VN', en: 'en_US' }

export function ogLocale(locale: Locale): string {
  return OG_LOCALES[locale]
}

/** The admin has no locale in its URLs (`/admin` is not for search engines): its language is a cookie, chosen with the switcher. */
export const ADMIN_LOCALE_COOKIE = 'admin_locale'
