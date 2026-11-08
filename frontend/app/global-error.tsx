'use client'

import { useEffect, type CSSProperties } from 'react'
import { createTranslator } from 'next-intl'
import { ERROR_EXITS } from '@/components/site/ErrorContent'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config'
import en from '@/messages/en.json'
import vi from '@/messages/vi.json'

/**
 * When app/layout.tsx itself breaks, Next replaces the WHOLE document with this file — so it carries its own
 * `<html lang>` (the locale of the URL), a `<head>` with `<title>` (global-error has no `metadata`; the Next docs recommend
 * React's `<title>`), and `<body>`.
 *
 * Inline styles, no Tailwind: this document has no globals.css (Next error.md, "Global Error").
 * There is also no theme boot script, so it cannot know whether the reader chose light or dark: the document follows the OS
 * via `color-scheme: light dark`, and every color is written with `light-dark()` using the exact site colors (background
 * white / #0a0a0a, text neutral-900 / neutral-100). A browser without `light-dark()` ignores that declaration
 * and uses its own default color — which also follows `color-scheme`, so there is still never dark text on a dark background.
 *
 * The exits are plain `<a>`, not `next/link`: the root layout just broke, and a full page load is the surest way
 * out of here. The retry button calls Next's `retry()` (refetch data then re-render). `error.message` is never
 * printed; the `digest` is, because it connects the screen to the server log.
 */

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'

const STYLES = {
  html: { colorScheme: 'light dark' },
  body: {
    margin: 0,
    fontFamily: FONT,
    lineHeight: 1.6,
    backgroundColor: 'light-dark(#ffffff, #0a0a0a)',
    color: 'light-dark(#171717, #f5f5f5)',
  },
  // Text column like Container width="prose": at most 48rem, 16px margin.
  main: { maxWidth: '48rem', margin: '0 auto', padding: '4rem 1rem', boxSizing: 'border-box' },
  title: { margin: 0, fontSize: '1.875rem', lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.025em' },
  lead: { margin: '0.75rem 0 0', color: 'light-dark(#525252, #a3a3a3)' },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1rem 1.5rem',
    marginTop: '2rem',
    fontSize: '0.875rem',
  },
  // 40px tall like the site primary button on mobile. The focus ring is the browser's: the outline is not touched.
  retry: {
    font: 'inherit',
    fontWeight: 500,
    height: '2.5rem',
    padding: '0 1rem',
    borderRadius: '0.375rem',
    border: '1px solid',
    borderColor: 'light-dark(#171717, #f5f5f5)',
    backgroundColor: 'light-dark(#171717, #f5f5f5)',
    color: 'light-dark(#ffffff, #171717)',
    cursor: 'pointer',
  },
  link: { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '4px' },
  digest: {
    margin: '2rem 0 0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.75rem',
    color: 'light-dark(#737373, #a3a3a3)',
  },
} satisfies Record<string, CSSProperties>

const CATALOGS: Record<Locale, typeof vi> = { vi, en }

/** There is no provider here and no request: the locale is the first URL segment when it names one, else the default. */
function currentLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const first = window.location.pathname.split('/')[1]
  return isLocale(first) && first !== DEFAULT_LOCALE ? first : DEFAULT_LOCALE
}

/** Exits are plain links, so a non-default locale carries its URL prefix by hand (localePrefix is 'as-needed'). */
function localizedHref(href: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return href
  return href === '/' ? `/${locale}` : `/${locale}${href}`
}

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error('Root layout failed to render', error)
  }, [error])

  const locale = currentLocale()
  const t = createTranslator({ locale, messages: CATALOGS[locale], namespace: 'Site.errorPage' })

  return (
    <html lang={locale} style={STYLES.html}>
      <head>
        <title>{t('title')}</title>
      </head>
      <body style={STYLES.body}>
        <main style={STYLES.main}>
          <h1 style={STYLES.title}>{t('title')}</h1>
          <p style={STYLES.lead}>{t('lead')}</p>
          <div style={STYLES.actions}>
            <button type="button" onClick={() => retry()} style={STYLES.retry}>
              {t('retry')}
            </button>
            {ERROR_EXITS.map((exit) => (
              <a key={exit.href} href={localizedHref(exit.href, locale)} style={STYLES.link}>
                {t(exit.labelKey)}
              </a>
            ))}
          </div>
          {error.digest ? <p style={STYLES.digest}>{t('digest', { digest: error.digest })}</p> : null}
        </main>
      </body>
    </html>
  )
}
