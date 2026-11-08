import { downloadRoute } from '@/lib/admin-download'
import { fetchExport } from '@/lib/admin-site-content'

/**
 * /admin/settings/export?locale=vi|en: download the saved site content of one locale as JSON (the document the import accepts).
 * A route handler, like the post export: one GET that the browser saves as a file. The backend checks that the caller is an
 * ADMIN; the body is passed on as it comes, and the file name is built here from the validated locale, not taken from a header.
 */
export function GET(request: Request): Promise<Response> {
  return downloadRoute(request, {
    messages: 'Admin.settings.exportRoute',
    fetcher: fetchExport,
    filename: (locale) => `site-content-${locale}.json`,
    contentType: 'application/json; charset=utf-8',
    failure: 'Site content export failed',
  })
}
