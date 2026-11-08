import { isLocale, type Locale } from '@/i18n/config'

/**
 * The locale a link to `post` needs, or `undefined` when the page's own locale already is the post's language (or the post
 * carries none). Pass it as the `locale` prop of the i18n `Link`: a post belongs under the URL of its own language.
 */
export function postLinkLocale(post: { language?: string }, pageLocale: Locale): Locale | undefined {
  return isLocale(post.language) && post.language !== pageLocale ? post.language : undefined
}
