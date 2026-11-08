import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { BrandIcon } from '@/components/BrandIcon'
import { Container } from '@/components/site/Container'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { INLINE_LINK } from '@/components/site/SectionHeading'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { LOGIN_ERRORS, safeReturnTo, type LoginError } from '@/lib/return-to'
import { setPageLocale } from '@/i18n/page-locale'

/**
 * /login: where failed GitHub sign-ins return to, and the entry for anyone who opens the URL directly.
 * The "Sign in" button in the header goes straight to the start route, not through here.
 *
 * A dynamic page (reads `searchParams`) but with no user data: it reads no cookie and
 * calls no backend. noindex: a login page has nothing to find, and `?error=` is a URL a stranger can build.
 * An unknown error code shows nothing, and the value on the URL is never echoed back.
 */

export async function generateMetadata(props: PageProps<'/[locale]/login'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.login' })
  return {
    ...(await pageMetadata({
      locale,
      title: t('page.title'),
      description: t('page.metaDescription'),
      canonical: '/login',
    })),
    // follow: false like the admin pages: the two links here are the home page (already everywhere) and the start
    // route (nofollow, /api is blocked by robots.txt), nothing more for a crawler to discover.
    robots: { index: false, follow: false },
  }
}

/** `?x=a&x=b` arrives as an array: take the first value. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isLoginError(value: string | undefined): value is LoginError {
  return LOGIN_ERRORS.some((code) => code === value)
}

/** Primary button, same style as the "Search" button of SearchForm. */
const PRIMARY =
  'inline-flex items-center gap-2 rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-[120ms] hover:border-brand hover:bg-brand motion-reduce:transition-none dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'

export default async function LoginPage(props: PageProps<'/[locale]/login'>) {
  await setPageLocale(props.params)
  const t = await getTranslations('Site.login')
  const { error, returnTo } = await props.searchParams
  const code = first(error)
  // The `state` error: a browser holds only one half-finished sign-in, a second one in another tab breaks the first.
  const message = isLoginError(code) ? t(`errors.${code}`) : null
  const target = safeReturnTo(first(returnTo))

  return (
    // No <main> here: app/(site)/layout.tsx holds the single `<main id="main-content">`.
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('page.title')}</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t('intro')}</p>

        {message !== null ? (
          <p
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
          >
            {message}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
          {/* A plain `<a>`, not `<Link>`: the Next router prefetches links, which would start an
            OAuth round trip by itself. nofollow for crawlers; robots.txt already blocks /api. */}
          <a href={`/api/auth/github/start?returnTo=${encodeURIComponent(target)}`} rel="nofollow" className={PRIMARY}>
            <BrandIcon name="github" />
            {t('continueWithGithub')}
          </a>
          <Link href="/" className={`text-sm ${INLINE_LINK}`}>
            {t('backHome')}
          </Link>
        </div>
      </div>
    </Container>
  )
}
