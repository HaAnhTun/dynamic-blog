'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ADMIN_LOCALE_COOKIE, isLocale } from '@/i18n/config'

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60
const MAX_RETURN_LENGTH = 512

/** C0 control characters, DEL or a backslash (the browser reads it as a slash). */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}

/**
 * The page to come back to: a path inside `/admin`, or `/admin`. Anything else (another origin, `//host`, backslashes, dot
 * segments, encoded separators, control characters) falls back to `/admin`, so the form is never an open redirect.
 */
function adminReturnPath(raw: FormDataEntryValue | null): string {
  if (typeof raw !== 'string' || raw.length > MAX_RETURN_LENGTH) return '/admin'
  const inAdmin = raw === '/admin' || raw.startsWith('/admin/') || raw.startsWith('/admin?')
  if (!inAdmin) return '/admin'
  if (hasForbiddenChar(raw) || raw.includes('//') || /%(2e|2f|5c|25)/i.test(raw)) return '/admin'
  const path = raw.split(/[?#]/, 1)[0] ?? ''
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return '/admin'
  return raw
}

/**
 * The admin language switch: stores the chosen language in the `admin_locale` cookie (read by i18n/request.ts) and goes back to
 * the page the form was on. A plain form post, so it works without JavaScript. An unknown language changes nothing.
 */
export async function setAdminLocale(formData: FormData): Promise<void> {
  const locale = formData.get('locale')
  if (isLocale(locale)) {
    ;(await cookies()).set(ADMIN_LOCALE_COOKIE, locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: ONE_YEAR_SECONDS,
      secure: process.env.NODE_ENV === 'production',
    })
  }
  redirect(adminReturnPath(formData.get('returnTo')))
}
