import { downloadRoute } from '@/lib/admin-download'
import { fetchPostTemplate } from '@/lib/admin-post-import'

/**
 * /admin/posts/import/template?locale=vi|en: download the post file template of one language, with the instructions for an AI
 * assistant and a neutral example post. A route handler, like the profile template: one GET that the browser saves as a file. Any
 * admin or author may download it (the backend decides); the file name is fixed here, not taken from a header.
 */
export function GET(request: Request): Promise<Response> {
  return downloadRoute(request, {
    messages: 'Admin.posts.import.route',
    fetcher: fetchPostTemplate,
    filename: (locale) => `post-import-template-${locale}.md`,
    contentType: 'text/markdown; charset=utf-8',
    failure: 'Post import template download failed',
  })
}
