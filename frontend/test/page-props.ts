import type { Locale } from '@/i18n/config'

/** The props Next hands a page under `app/[locale]` that has no dynamic segment of its own and no query. */
export function pageProps(locale: Locale = 'vi'): {
  params: Promise<{ locale: Locale }>
  searchParams: Promise<Record<string, never>>
} {
  return { params: Promise.resolve({ locale }), searchParams: Promise.resolve({}) }
}
