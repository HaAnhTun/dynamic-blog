import { useTranslations } from 'next-intl'
import { isLocale, type Locale } from '@/i18n/config'
import { getPathname } from '@/i18n/navigation'
import type { PostTranslation } from '@/lib/types'
import { postPath } from './ArticleJsonLd'
import { LANGUAGE_NAMES } from './language-names'
import { INLINE_LINK } from './SectionHeading'

/**
 * "Read in another language": one link per published translation of the article, each to the translation's own URL, tagged with
 * its language (`lang`, `hreflang`). A plain `<a>` with `getPathname`, like the language switcher: the i18n `Link`'s `locale` prop puts a
 * `/vi` prefix on the default language, and another language is another root layout anyway. Nothing when the post has no published translation; the backend never lists a draft.
 */
export function TranslationLink({ translations }: { translations: PostTranslation[] | undefined }) {
  const t = useTranslations('Site.article.translations')
  const items = (translations ?? []).filter((item): item is PostTranslation & { language: Locale } => isLocale(item.language))
  if (items.length === 0) return null

  return (
    <nav aria-label={t('label')} className="mt-8 text-sm text-neutral-700 dark:text-neutral-300 print:hidden">
      <p className="font-medium">{t('label')}</p>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item.language}>
            <span lang={item.language} className="text-neutral-600 dark:text-neutral-400">
              {LANGUAGE_NAMES[item.language]}:
            </span>{' '}
            <a
              href={getPathname({ href: postPath(item.slug), locale: item.language })}
              lang={item.language}
              hrefLang={item.language}
              className={INLINE_LINK}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
