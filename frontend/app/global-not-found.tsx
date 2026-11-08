import { NextIntlClientProvider } from 'next-intl'
import type { Metadata } from 'next'
import { getLocale, getMessages } from 'next-intl/server'
import { NOT_FOUND_CLIENT_NAMESPACES, pickMessages } from '@/i18n/client-messages'
import { RootShell } from '@/components/RootShell'
import { NotFoundPage } from '@/components/site/NotFoundPage'
import { asLocale } from '@/lib/format'
import { rootMetadata, rootViewport } from '@/lib/root-metadata'

export async function generateMetadata(): Promise<Metadata> {
  return rootMetadata(asLocale(await getLocale()))
}
export const viewport = rootViewport

/**
 * The page for every URL that matches no route (`experimental.globalNotFound` in next.config.ts).
 *
 * It has to render its own `<html>`: with `<html lang>` following the locale there is no shared root layout to wrap a root
 * `not-found.tsx`, and without this file an unknown URL answered 404 with an empty body (measured in the V9 spike). The
 * locale is the one the middleware found in the URL (`/en/nothing` is an English 404), else the default; a 404 is rendered per
 * request, which is fine for a page nobody links to.
 */
export default async function GlobalNotFound() {
  const locale = await getLocale()
  return (
    <RootShell lang={locale}>
      <NextIntlClientProvider messages={pickMessages(await getMessages(), NOT_FOUND_CLIENT_NAMESPACES)}>
        <NotFoundPage />
      </NextIntlClientProvider>
    </RootShell>
  )
}
