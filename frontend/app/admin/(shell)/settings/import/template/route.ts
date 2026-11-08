import { downloadRoute } from '@/lib/admin-download'
import { fetchTemplate } from '@/lib/admin-site-import'

/**
 * /admin/settings/import/template?locale=vi|en: download the empty profile file of one language, with the instructions for an
 * AI assistant. A route handler, like the content export: one GET that the browser saves as a file. The backend checks that the
 * caller is an ADMIN; the file name is fixed here, not taken from a header.
 */
export function GET(request: Request): Promise<Response> {
  return downloadRoute(request, {
    messages: 'Admin.settings.profileImport.route',
    fetcher: fetchTemplate,
    filename: (locale) => `site-profile-template-${locale}.md`,
    contentType: 'text/markdown; charset=utf-8',
    failure: 'Profile template download failed',
  })
}
