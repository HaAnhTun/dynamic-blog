import { downloadRoute } from '@/lib/admin-download'
import { fetchProfileExport } from '@/lib/admin-site-import'

/**
 * /admin/settings/import/export?locale=vi|en: download the saved site content of one language as a profile file, the same
 * format the import accepts. With `&format=zip` it is the ZIP package instead: the profile file plus every image the content uses
 * (the About photo, the images of its body, the timeline logos), which the import reads back. A route handler like the template
 * one: one GET that the browser saves as a file. The backend checks that the caller is an ADMIN; the file name is fixed here, not
 * taken from a header, and any `format` other than `zip` is the Markdown file.
 */
export function GET(request: Request): Promise<Response> {
  const zip = new URL(request.url).searchParams.get('format') === 'zip'
  return downloadRoute(request, {
    messages: 'Admin.settings.profileImport.route',
    fetcher: zip ? (locale) => fetchProfileExport(locale, 'zip') : (locale) => fetchProfileExport(locale),
    filename: (locale) => `site-profile-${locale}.${zip ? 'zip' : 'md'}`,
    contentType: zip ? 'application/zip' : 'text/markdown; charset=utf-8',
    failure: 'Profile export download failed',
  })
}
