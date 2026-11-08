import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { newsletterToken } from '@/app/api/newsletter/token'
import { Container } from '@/components/site/Container'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { InvalidLink, TokenAction } from '../TokenAction'

/**
 * /newsletter/confirm?token=...: the link in the confirmation email. GET only draws the button; confirming is a POST when the reader
 * clicks. noindex, and `Referrer-Policy: no-referrer` (next.config.ts) so that the URL carrying the token does not travel in the Referer.
 */

export async function generateMetadata(props: PageProps<'/[locale]/newsletter/confirm'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.newsletter.confirm' })
  return {
    ...(await pageMetadata({
      locale,
      title: t('title'),
      description: t('metaDescription'),
      canonical: '/newsletter/confirm',
    })),
    // URLs differ only by token, nothing to find; the only link on the page is /newsletter, already in the footer.
    robots: { index: false, follow: false },
  }
}

export default async function NewsletterConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = (await searchParams).token
  const token = newsletterToken(Array.isArray(raw) ? raw[0] : raw)
  const t = await getTranslations('Site.newsletter.confirm')

  return (
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
        {token === null ? (
          <InvalidLink kind="confirm" />
        ) : (
          <>
            <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t('intro')}</p>
            <TokenAction kind="confirm" token={token} />
          </>
        )}
      </div>
    </Container>
  )
}
