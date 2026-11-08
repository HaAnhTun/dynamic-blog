import { createTranslator, NextIntlClientProvider } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'
import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translator'
import en from '@/messages/en.json'
import vi from '@/messages/vi.json'

/**
 * Test helpers for the catalogs: tests never hard-code translated copy, they ask the catalog (`msg`) or render under a locale
 * (`renderWithIntl`). Every `render` of the suite is already wrapped in the default locale by `vitest.setup.ts`, so a test only
 * calls `renderWithIntl` when it needs another locale or wants the intent to be explicit.
 */
export const TEST_LOCALE: Locale = 'vi'

export const CATALOGS: Record<Locale, Record<string, unknown>> = { vi, en }

/** The locale server helpers (`getLocale`, `getTranslations`) answer with in a test; `renderWithIntl` sets it for its render. */
let serverLocale: Locale = TEST_LOCALE

export function currentTestLocale(): Locale {
  return serverLocale
}

export function setTestLocale(locale: Locale): void {
  serverLocale = locale
}

/** A translator over the real catalog. A missing key throws, so a typo in a test is a failure rather than a silent key path. */
export function translatorFor(locale: Locale, namespace?: string): Translator {
  return createTranslator({
    locale,
    messages: CATALOGS[locale] as never,
    namespace: namespace as never,
    onError: (error) => {
      throw error
    },
  }) as unknown as Translator
}

/** The message at a full key (`Site.nav.writing`), formatted with ICU arguments, in the given locale (default: the test locale). */
export function msg(key: string, args?: Record<string, string | number | Date>, locale: Locale = serverLocale): string {
  const t = translatorFor(locale) as unknown as (key: string, args?: Record<string, unknown>) => string
  return t(key, args)
}

export function IntlWrapper({ locale = TEST_LOCALE, children }: { locale?: Locale; children: ReactNode }): ReactElement {
  return (
    <NextIntlClientProvider locale={locale} messages={CATALOGS[locale] as never} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  )
}
