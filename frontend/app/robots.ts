import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/site'

/**
 * robots.txt.
 *
 * Allow everything, disallow /admin, /api and /random, and point at the sitemap.
 *
 * `Disallow: /admin` is a PREFIX match in the Robots Exclusion Standard, so it covers
 * /admin, /admin/posts and /admin/posts/new without listing them — writing `/admin/`
 * as well would be redundant, and writing only `/admin/` would leave /admin itself
 * crawlable. /admin is behind a login and a crawler gets nothing from it but the login
 * form; keeping the form out of an index is the whole point, not security. Nothing here
 * is a security control: robots.txt is a request, it is public, and the authorization
 * that actually protects /admin lives in the backend and the middleware.
 *
 * /api is disallowed for the same "nothing to index" reason. The backend API is a
 * separate service on another port; what lives under /api here are route handlers such as
 * app/api/views (the view beacon), which answer POST only and have nothing to index.
 * Uploaded images are deliberately NOT under /api — they are served at /media, because
 * X/Twitterbot will not fetch an og:image from a disallowed path.
 *
 * /random is disallowed because it is a 307 to a different post on every request: a
 * crawler following it learns nothing stable about the URL. The posts themselves stay
 * reachable through the sitemap and ordinary links.
 */

/**
 * Duplicated from app/sitemap.ts, which duplicates it from app/layout.tsx. See the long
 * note there for why there is no shared constant to import yet (neither layout.tsx nor
 * ArticleJsonLd.tsx is mine in this run, and a named export from app/sitemap.ts is
 * re-exported onto the generated route module by next-metadata-route-loader, which I
 * cannot run `next build` to clear).
 *
 * The drift is caught rather than prevented: app/robots.test.ts asserts that this file
 * and app/sitemap.ts resolve the SAME origin for the same environment — including the
 * awkward values, an empty `NEXT_PUBLIC_SITE_URL=` line and a trailing slash — so a
 * change to one of the two cannot land silently. A `Sitemap:` line whose origin
 * disagrees with the sitemap's own `<loc>` entries is how a crawler ends up told to
 * fetch localhost in production.
 */

function siteOrigin(): string {
  // Delegates to lib/site.ts. This function had its own copy of the rule, and so did
  // robots.ts, ArticleJsonLd.tsx and app/layout.tsx — four copies, of which layout.tsx's
  // was the one that used `??` and would have 500'd the whole site on an empty
  // NEXT_PUBLIC_SITE_URL. Keeping the local name means the call sites below are unchanged.
  return siteUrl()
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/api', '/random'],
    },
    // Absolute, and required to be: the sitemap directive is the one line in robots.txt
    // that a crawler will not resolve relative to the host it fetched the file from.
    sitemap: `${siteOrigin()}/sitemap.xml`,
  }
}
