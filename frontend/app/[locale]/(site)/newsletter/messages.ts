import type { Translator } from '@/i18n/translator'

/**
 * Error sentence of the newsletter pages (`t` is the `Site.newsletter` translator). The messages of the BFF routes (English, for API
 * callers) must never be shown.
 */

/** An error while sending that is not caused by the address or the token. */
export function sendError(code: string, status: number, t: Translator): string {
  if (code === 'RATE_LIMITED' || status === 429) return t('errors.rateLimited')
  if (code === 'NETWORK' || status === 0 || status >= 500) return t('errors.network')
  return t('errors.generic')
}
