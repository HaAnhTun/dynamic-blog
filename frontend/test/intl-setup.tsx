import type { RenderOptions } from '@testing-library/react'
import { vi } from 'vitest'
import type { Locale } from '@/i18n/config'
import { CATALOGS, currentTestLocale, IntlWrapper, translatorFor } from './intl'

/**
 * Loaded by vitest.setup.ts. Two global stand-ins, so that the existing tests need no edit when a component starts to use
 * next-intl:
 *
 * - `render` / `renderHook` of Testing Library wrap the tree in the default locale provider. An explicit provider inside (what
 *   `renderWithIntl` adds) wins, as nested providers do.
 * - `next-intl/server` is the real library minus the request scope it needs: `getTranslations` and `getLocale` read the test
 *   locale, `setRequestLocale` does nothing.
 */
vi.mock('@testing-library/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@testing-library/react')>()
  const withIntl = (Inner?: React.JSXElementConstructor<{ children: React.ReactNode }>) =>
    function Wrapper({ children }: { children: React.ReactNode }) {
      return <IntlWrapper locale={currentTestLocale()}>{Inner ? <Inner>{children}</Inner> : children}</IntlWrapper>
    }
  return {
    ...actual,
    render: ((ui: React.ReactElement, options?: RenderOptions) =>
      actual.render(ui, { ...options, wrapper: withIntl(options?.wrapper) })) as typeof actual.render,
    renderHook: ((hook, options) =>
      actual.renderHook(hook, { ...options, wrapper: withIntl(options?.wrapper) })) as typeof actual.renderHook,
  }
})

vi.mock('next-intl/server', () => ({
  setRequestLocale: () => {},
  getLocale: async (): Promise<Locale> => currentTestLocale(),
  getMessages: async () => CATALOGS[currentTestLocale()],
  getTranslations: async (namespaceOrOptions?: string | { namespace?: string; locale?: Locale }) => {
    const namespace = typeof namespaceOrOptions === 'string' ? namespaceOrOptions : namespaceOrOptions?.namespace
    const locale =
      typeof namespaceOrOptions === 'object' && namespaceOrOptions?.locale ? namespaceOrOptions.locale : currentTestLocale()
    return translatorFor(locale, namespace)
  },
}))

// Pages and metadata read the owner's content through `getSiteContent`; unit tests get the packaged defaults and no network
// call. A test that needs other content mocks `@/lib/site-content` itself.
vi.mock('@/lib/site-content', async () => {
  const { defaultSiteContent } = await import('@/content/defaults')
  const getSiteContent = async (locale: Locale) => defaultSiteContent(locale)
  return {
    SITE_CONTENT_TAG: 'site-content',
    getSiteContent,
    getDefaultSiteContent: async () => defaultSiteContent((await import('@/i18n/config')).DEFAULT_LOCALE),
  }
})
