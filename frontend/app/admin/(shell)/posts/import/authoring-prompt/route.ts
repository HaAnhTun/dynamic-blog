import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { SessionExpiredError } from '@/lib/admin-api'
import { verifiedAdminRole } from '@/lib/admin-role'
import { authoringPrompt } from '@/lib/blocks/authoring-prompt'

/**
 * /admin/posts/import/authoring-prompt: the prompt to give to an AI assistant so that the article it writes uses the supported
 * blocks and comes back as one importable ZIP package. A route handler like the template download: one GET that the browser saves as
 * a file. The text is generated from the block registry (`lib/blocks/authoring-prompt.ts`), so it is the same for every caller and
 * holds nothing of the site; it is still only for admins and authors, like the import page it belongs to, and the file name is fixed
 * here.
 *
 * This handler makes no backend call of its own, so it asks the backend who the caller is (`verifiedAdminRole`) instead of reading the
 * role claim of the cookie, which `proxy.ts` and the shell trust only to choose a screen: a hand-made token with a role of ADMIN and
 * any refresh cookie reaches this route, and the backend is what refuses it (`docs/SECURITY.md`, "What is not protected").
 */
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

function plain(status: 403 | 502, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS } })
}

export async function GET(request: Request): Promise<Response> {
  const t = await getTranslations('Admin.posts.import.route')
  let role: Awaited<ReturnType<typeof verifiedAdminRole>>
  try {
    role = await verifiedAdminRole()
  } catch (error) {
    if (error instanceof SessionExpiredError) return NextResponse.redirect(new URL('/admin/login', request.url))
    console.error('Authoring prompt download: could not confirm the role with the backend', error)
    return plain(502, t('unavailable'))
  }
  if (role === null) return plain(403, t('forbidden'))
  return new Response(authoringPrompt(), {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="article-authoring-prompt.md"',
      ...HEADERS,
    },
  })
}
