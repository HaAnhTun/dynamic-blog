import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { RootShell } from '@/components/RootShell'
import { SETUP_CLIENT_NAMESPACES } from '@/components/setup/namespaces'
import { pickMessages } from '@/i18n/client-messages'
import { siteUrlObject } from '@/lib/site'

/** The first-run page is not for search engines, and it is a 404 once the setup is done. */
export const metadata: Metadata = {
  metadataBase: siteUrlObject(),
  robots: { index: false, follow: false },
}

export const viewport: Viewport = { themeColor: '#ffffff' }

/** Its own root layout: /setup has no locale in its URL and is outside the public and admin trees. */
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  return (
    <RootShell lang={locale}>
      <NextIntlClientProvider messages={pickMessages(await getMessages(), SETUP_CLIENT_NAMESPACES)}>
        {children}
      </NextIntlClientProvider>
    </RootShell>
  )
}
