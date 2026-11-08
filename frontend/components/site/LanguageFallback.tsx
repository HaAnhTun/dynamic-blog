import { useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/config'
import { getPathname } from '@/i18n/navigation'
import { LANGUAGE_NAMES } from './language-names'
import { INLINE_LINK } from './SectionHeading'

/**
 * Shown where a language-filtered list is empty while the other language has posts: a short message and a link to the same page
 * in that language. A plain `<a>` built with `getPathname`, like the language switcher (another language is another root layout).
 * `path` is the page path without the locale prefix, for example `/categories/go-loi`.
 */
export function LanguageFallback({ path, language }: { path: string; language: Locale }) {
  const t = useTranslations('Site.languageFallback')
  return (
    <p className="mt-6 text-neutral-600 dark:text-neutral-400" data-testid="language-fallback">
      {t('message')}{' '}
      <a href={getPathname({ href: path, locale: language })} lang={language} hrefLang={language} className={INLINE_LINK}>
        {t('link', { language: LANGUAGE_NAMES[language] })}
      </a>
    </p>
  )
}
