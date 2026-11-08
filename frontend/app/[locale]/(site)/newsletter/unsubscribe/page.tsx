import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { newsletterToken } from '@/app/api/newsletter/token'
import { Container } from '@/components/site/Container'
import { CARD, CARD_PAGE } from '@/components/site/reader/reader-layout'
import { metadataLocale } from '@/lib/locale-path'
import { pageMetadata } from '@/lib/metadata'
import { InvalidLink, TokenAction } from '../TokenAction'

/**
 * /newsletter/unsubscribe?token=...: the unsubscribe link in every email. GET only draws the button; unsubscribing is a POST when the reader
 * clicks. The mail provider POSTs straight to /api/newsletter/unsubscribe (one click, RFC 8058), not through this page.
 */

export async function generateMetadata(props: PageProps<'/[locale]/newsletter/unsubscribe'>): Promise<Metadata> {
  const locale = await metadataLocale(props.params)
  const t = await getTranslations({ locale, namespace: 'Site.newsletter.unsubscribe' })
  return {
    ...(await pageMetadata({
      locale,
      title: t('title'),
      description: t('metaDescription'),
      canonical: '/newsletter/unsubscribe',
    })),
    // Like /newsletter/confirm: URLs differ only by token, nothing to find.
    robots: { index: false, follow: false },
  }
}

export default async function NewsletterUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = (await searchParams).token
  const token = newsletterToken(Array.isArray(raw) ? raw[0] : raw)
  const t = await getTranslations('Site.newsletter.unsubscribe')

  return (
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
        {token === null ? (
          <InvalidLink kind="unsubscribe" />
        ) : (
          <>
            <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t('intro')}</p>
            <TokenAction kind="unsubscribe" token={token} />
          </>
        )}
      </div>
    </Container>
  )
}
