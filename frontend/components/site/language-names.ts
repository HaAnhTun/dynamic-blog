import type { Locale } from '@/i18n/config'

/**
 * Each language is named in itself, so a reader who cannot read the current language still finds theirs. They are not in the
 * catalogs: the same name must read the same in both, and the English catalog is checked for Vietnamese letters.
 */
export const LANGUAGE_NAMES: Record<Locale, string> = { vi: 'Ti\u1ebfng Vi\u1ec7t', en: 'English' }
