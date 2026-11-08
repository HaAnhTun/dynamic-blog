import 'server-only'
import { LOCALES, type Locale } from '@/i18n/config'

/**
 * For a list page whose language-filtered list is empty: the first other language in which the same list has posts, or null.
 * `count` answers "how many items does this page's list have in that language"; a failing probe counts as none, because the
 * fallback hint is secondary and must not turn an empty page into an error page.
 */
export async function otherLanguageWithPosts(
  locale: Locale,
  count: (language: Locale) => Promise<number>,
): Promise<Locale | null> {
  for (const language of LOCALES) {
    if (language === locale) continue
    const total = await count(language).catch(() => 0)
    if (total > 0) return language
  }
  return null
}
