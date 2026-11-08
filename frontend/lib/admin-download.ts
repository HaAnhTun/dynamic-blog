import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { isLocale, type Locale } from '@/i18n/config'
import { SessionExpiredError } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'

/** The catalog groups that hold `badLocale`, `forbidden` and `unavailable` for a download. */
type Messages = 'Admin.settings.exportRoute' | 'Admin.settings.profileImport.route' | 'Admin.posts.import.route'

export type DownloadSpec = {
  messages: Messages
  /** Calls the backend for one validated locale. */
  fetcher: (locale: Locale) => Promise<Response>
  /** Built here from the validated locale, never taken from a backend header. */
  filename: (locale: Locale) => string
  contentType: string
  /** The log line when the backend call fails (no value from the request is added to it). */
  failure: string
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function plain(status: 400 | 403 | 502, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS } })
}

/**
 * The GET of an admin download route (`?locale=vi|en`): validates the locale before calling the backend, passes the body on as an
 * attachment, and maps the failures (expired session to login, 403 stays 403, anything else a 502 with no internal text). One place,
 * because three route handlers differed only in the fetcher, the file name, the content type and the message group.
 */
export async function downloadRoute(request: Request, spec: DownloadSpec): Promise<Response> {
  const t = await getTranslations(spec.messages)
  const locale = new URL(request.url).searchParams.get('locale')
  if (!isLocale(locale)) return plain(400, t('badLocale'))

  let upstream: Response
  try {
    upstream = await spec.fetcher(locale)
  } catch (error) {
    if (error instanceof SessionExpiredError) return NextResponse.redirect(new URL('/admin/login', request.url))
    if (error instanceof ApiError && error.status === 403) return plain(403, t('forbidden'))
    console.error(spec.failure, error)
    return plain(502, t('unavailable'))
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': spec.contentType,
      'content-disposition': `attachment; filename="${spec.filename(locale)}"`,
      ...HEADERS,
    },
  })
}
