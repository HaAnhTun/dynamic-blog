import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from '@/i18n/config'
import { getPathname } from '@/i18n/navigation'
import { absoluteUrl, siteUrl } from '@/lib/site'

/**
 * The URL path of a page in a locale: the default locale has no prefix, any other one has `/<locale>`. The one URL rule of
 * the head (canonical, hreflang, RSS link), the JSON-LD, the feeds and the sitemap; it is next-intl's own `getPathname`, so the
 * addresses cannot disagree with the links the pages render. `path` may carry a query string.
 */
export function localePath(path: string, locale: Locale = DEFAULT_LOCALE): string {
  return getPathname({ href: path, locale })
}

/**
 * `hreflang` map of a page that exists in every locale: one entry per locale plus `x-default` (the default locale's URL).
 * Values are paths (`metadataBase` makes them absolute); the sitemap passes `absoluteLocaleUrl` as `addressOf` to get absolute URLs.
 */
export function languageAlternates(
  path: string,
  addressOf: (path: string, locale: Locale) => string = localePath,
): Record<string, string> {
  return {
    ...Object.fromEntries(LOCALES.map((locale) => [locale, addressOf(path, locale)])),
    'x-default': addressOf(path, DEFAULT_LOCALE),
  }
}

/**
 * Absolute URL of a page in a locale, written like the canonical tag: the default locale's home page is the bare origin (no
 * trailing "/"), as in the sitemap, every other path is the origin plus the localized path.
 */
export function absoluteLocaleUrl(path: string, locale: Locale = DEFAULT_LOCALE): string {
  const localized = localePath(path, locale)
  return localized === '/' ? siteUrl() : absoluteUrl(localized)
}

/**
 * The locale of a route's `params` for `generateMetadata`: an unknown value falls back to the default locale instead of throwing,
 * because the page (and the layout) answer 404 for it and metadata must not turn that into a different error.
 */
export async function metadataLocale(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params
  return isLocale(locale) ? locale : DEFAULT_LOCALE
}
