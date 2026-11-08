import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { SessionExpiredError, fetchAdminPostExport, getAdminPost } from '@/lib/admin-api'
import { ApiError } from '@/lib/api'
import { exportFileName, exportZipFileName, toSeedMarkdown } from '@/lib/post-markdown'
import type { Post } from '@/lib/types'

// An author's draft, read with their session: no browser, proxy or CDN may keep it.
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

/**
 * /admin/posts/<id>/export: download the SAVED post, for the editor's "Download ZIP" button. Unsaved changes are not here: the
 * route reads the post from the backend, not from the editor.
 *
 * By default the ZIP package the backend builds (`article.md` plus the images under `assets/`), in the format the post import reads,
 * so a downloaded post can be imported again as the same post. The body is passed on as it comes; the file name is the one the
 * backend sent, cleaned (`exportZipFileName`). `?format=md` keeps the older seed Markdown file (lib/post-markdown.ts,
 * `toSeedMarkdown`: the format and what a round of export then push back loses).
 *
 * A route handler, not a Server Action: a download is one GET that the browser itself saves as a file
 * (`Content-Disposition: attachment`), no JavaScript needed. Permission: proxy.ts only lets ADMIN and AUTHOR into /admin/**
 * (and refreshes the session as for every admin page); the backend checks permission on the post itself with the caller's token.
 *
 * No segment config: a route handler GET is dynamic by nature, and admin-api reads cookies on every call.
 */
export async function GET(request: Request, ctx: RouteContext<'/admin/posts/[id]/export'>): Promise<Response> {
  const { id } = await ctx.params
  const t = await getTranslations('Admin.posts.exportRoute')
  const markdown = new URL(request.url).searchParams.get('format') === 'md'

  try {
    return markdown ? markdownResponse(await getAdminPost(id)) : zipResponse(await fetchAdminPostExport(id))
  } catch (error) {
    // Before ApiError: SessionExpiredError is a subclass of it. Like the post edit page: to login.
    if (error instanceof SessionExpiredError) return NextResponse.redirect(new URL('/admin/login', request.url))
    if (error instanceof ApiError && error.status === 404) return plain(404, t('notFound'))
    // 403 stays 403: it is not "no such post", and redirecting to login is a loop.
    if (error instanceof ApiError && error.status === 403) return plain(403, t('forbidden'))
    // The package would go over the package limits: the user can act on this one, so it is not a generic 502.
    if (error instanceof ApiError && error.status === 413) return plain(413, t('tooLarge'))
    console.error('Post export failed', error)
    return plain(502, t('unavailable'))
  }
}

function markdownResponse(post: Post): Response {
  return new Response(toSeedMarkdown(post), {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFileName(post.slug)}"`,
      ...HEADERS,
    },
  })
}

function zipResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${exportZipFileName(upstream.headers.get('content-disposition'))}"`,
      ...HEADERS,
    },
  })
}

/** A lowercase error message, never cached. */
function plain(status: 403 | 404 | 413 | 502, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS } })
}
