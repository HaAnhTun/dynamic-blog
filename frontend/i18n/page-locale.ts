import { hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { Locale } from './config'
import { routing } from './routing'

/**
 * The first line of every page under `app/[locale]`: reads the locale from the route params and tells next-intl about it, which
 * a statically rendered page needs. Segments render in parallel, so the layout's own `setRequestLocale` is not enough: without
 * this a prerendered page that renders a locale-aware component (`Link`, `useTranslations`) falls back to reading the request
 * headers, and a `dynamic = 'error'` page fails the build.
 */
export async function setPageLocale(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  return locale
}
