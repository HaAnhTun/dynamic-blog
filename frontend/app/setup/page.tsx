import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { H1, LEAD } from '@/components/admin/ui'
import { SETUP_CLIENT_NAMESPACES } from '@/components/setup/namespaces'
import SetupForm from '@/components/setup/SetupForm'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { pickMessages } from '@/i18n/client-messages'
import { isLocale, LOCALES, type Locale } from '@/i18n/config'
import { isSetupRequired } from '@/lib/setup-api'

// Reads the live setup state on every request: never prerendered, never cached.
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('Setup')
  return { title: t('title') }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** A valid `?lang=` wins (first visit); otherwise the admin language cookie or the default, already resolved by `getLocale`. */
async function pageLocale(lang: string | undefined): Promise<Locale> {
  if (isLocale(lang)) return lang
  const current = await getLocale()
  return isLocale(current) ? current : LOCALES[0]
}

/** Typed by hand: `PageProps<'/setup'>` only exists once Next has regenerated its route types. */
export default async function SetupPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isSetupRequired())) notFound()

  const locale = await pageLocale(first((await props.searchParams).lang))
  const t = await getTranslations({ locale, namespace: 'Setup' })
  const tLanguage = await getTranslations({ locale, namespace: 'Language' })
  const catalog = (await import(`@/messages/${locale}.json`)).default
  const messages = pickMessages(catalog, SETUP_CLIENT_NAMESPACES)

  return (
    <div lang={locale} data-admin className="min-h-screen bg-slate-50 text-slate-900 [color-scheme:light]">
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
        <div className="text-center">
          <h1 className={H1}>{t('title')}</h1>
          <p className={LEAD}>{t('lead')}</p>
        </div>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SetupForm />
        </NextIntlClientProvider>
        <nav aria-label={tLanguage('navLabel')} className="mt-6 flex justify-center gap-4 text-sm">
          {LOCALES.map((code) => (
            <Link
              key={code}
              href={`/setup?lang=${code}`}
              lang={code}
              prefetch={false}
              aria-current={code === locale ? 'true' : undefined}
              className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand aria-[current=true]:font-semibold aria-[current=true]:no-underline"
            >
              {LANGUAGE_NAMES[code]}
            </Link>
          ))}
        </nav>
      </main>
    </div>
  )
}
