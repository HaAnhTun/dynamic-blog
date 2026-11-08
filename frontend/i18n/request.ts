import { hasLocale } from 'next-intl'
import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'
import { ADMIN_LOCALE_COOKIE } from './config'
import { pseudoMessages } from './pseudo'
import { routing } from './routing'

/**
 * The locale of a request: the one the middleware found in the URL (public pages); for `/admin`, which has no locale in its URLs
 * and does not go through the middleware, the `admin_locale` cookie; otherwise the default. The cookie is read only when the URL
 * says nothing, so prerendered public pages never touch the request.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  let locale: string = routing.defaultLocale
  if (hasLocale(routing.locales, requested)) {
    locale = requested
  } else {
    const fromCookie = (await cookies()).get(ADMIN_LOCALE_COOKIE)?.value
    if (hasLocale(routing.locales, fromCookie)) locale = fromCookie
  }
  const messages = (await import(`../messages/${locale}.json`)).default
  return { locale, messages: process.env.PSEUDO_LOCALE === '1' ? pseudoMessages(messages) : messages }
})
