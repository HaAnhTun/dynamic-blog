import { defineRouting } from 'next-intl/routing'
import { DEFAULT_LOCALE, LOCALES } from './config'

/**
 * `as-needed`: the default locale has no prefix, so every URL the site had before i18n is unchanged; the other locale lives under
 * `/<locale>/...`.
 *
 * The three `false` are deliberate (measured in the V9 spike): with the defaults next-intl redirects `/` to `/en` for an
 * English browser (a different final URL for an existing page), sets a `NEXT_LOCALE` cookie on cacheable pages, and emits
 * `Link: hreflang` headers for every page whether or not a translation exists. The language is chosen by link; hreflang
 * comes from the metadata and the sitemap, and only for pages that have the translation.
 */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'as-needed',
  localeDetection: false,
  localeCookie: false,
  alternateLinks: false,
})
