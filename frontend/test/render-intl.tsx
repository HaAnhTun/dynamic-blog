import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Locale } from '@/i18n/config'
import { currentTestLocale, IntlWrapper, setTestLocale } from './intl'

/**
 * Render `ui` under a locale: the provider, and the locale the server helpers (`getTranslations`, `getLocale`) answer with, for
 * the rest of the test (vitest.setup.ts puts it back after each test).
 */
export function renderWithIntl(
  ui: ReactElement,
  { locale, ...options }: { locale?: Locale } & Omit<RenderOptions, 'queries'> = {},
): RenderResult {
  if (locale) setTestLocale(locale)
  return render(ui, {
    ...options,
    wrapper: ({ children }) => <IntlWrapper locale={locale ?? currentTestLocale()}>{children}</IntlWrapper>,
  })
}

export { msg } from './intl'
