import type { Metadata } from 'next'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { PUBLIC_CLIENT_NAMESPACES, pickMessages } from '@/i18n/client-messages'
import { notFound } from 'next/navigation'
import { RootShell } from '@/components/RootShell'
import { DEFAULT_LOCALE } from '@/i18n/config'
import { routing } from '@/i18n/routing'
import { rootMetadata, rootViewport } from '@/lib/root-metadata'

export const viewport = rootViewport

export async function generateMetadata(props: LayoutProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = await props.params
  return rootMetadata(hasLocale(routing.locales, locale) ? locale : DEFAULT_LOCALE)
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

/**
 * The root layout of the public site: `<html lang>` is the locale of the URL. The middleware only lets a valid locale (or no
 * prefix, meaning the default one) reach this segment; the check below is the backstop for a request the matcher skips.
 */
export default async function LocaleLayout({ children, params }: LayoutProps<'/[locale]'>) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  return (
    <RootShell lang={locale}>
      <NextIntlClientProvider messages={pickMessages(await getMessages(), PUBLIC_CLIENT_NAMESPACES)}>
        {children}
      </NextIntlClientProvider>
    </RootShell>
  )
}
