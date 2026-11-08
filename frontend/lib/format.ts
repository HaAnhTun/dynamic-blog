import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config'

/**
 * Locale-aware Intl factories. Pure (no React, no next-intl) so server code, client code and plain helpers share them.
 * Intl objects are expensive to build, so each one is cached by locale plus a stable key of its options.
 */

const BCP47: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' }

const cache = new Map<string, unknown>()

function cached<T>(kind: string, locale: Locale, options: object | undefined, build: (tag: string) => T): T {
  // Sorted keys so `{a, b}` and `{b, a}` share one entry.
  const optionsKey = options ? JSON.stringify(Object.entries(options).sort(([a], [b]) => (a < b ? -1 : 1))) : ''
  const key = `${kind}|${locale}|${optionsKey}`
  let value = cache.get(key) as T | undefined
  if (value === undefined) {
    value = build(BCP47[locale])
    cache.set(key, value)
  }
  return value
}

export function numberFormat(locale: Locale, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached('number', locale, options, (tag) => new Intl.NumberFormat(tag, options))
}

export function dateFormat(locale: Locale, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached('date', locale, options, (tag) => new Intl.DateTimeFormat(tag, options))
}

export function relativeTimeFormat(locale: Locale, options?: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return cached('relative', locale, options, (tag) => new Intl.RelativeTimeFormat(tag, options))
}

/** Alphabetical order of the locale: by character code an accented capital sorts after every ASCII letter. */
export function collator(locale: Locale): Intl.Collator {
  return cached('collator', locale, undefined, (tag) => new Intl.Collator(tag))
}

export function lowerCase(text: string, locale: Locale): string {
  return text.toLocaleLowerCase(BCP47[locale])
}

export function upperCase(text: string, locale: Locale): string {
  return text.toLocaleUpperCase(BCP47[locale])
}

/** Grapheme splitter, or null where `Intl.Segmenter` is missing. */
export function graphemeSegmenter(locale: Locale): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== 'function') return null
  return cached('segmenter', locale, undefined, (tag) => new Intl.Segmenter(tag, { granularity: 'grapheme' }))
}

/** `useLocale()` and `getLocale()` return a plain string: narrow it to a supported locale, falling back to the default. */
export function asLocale(value: string): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE
}
