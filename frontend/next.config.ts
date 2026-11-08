import { join } from 'node:path'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { CSP_REPORT_GROUP, CSP_REPORT_PATH, buildContentSecurityPolicy } from './csp-policy.mjs'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

/** One day: short enough that an HTTPS mistake only locks readers out until tomorrow. */
const DEFAULT_HSTS_MAX_AGE = 86_400

/** One year: what ASVS 3.4.1 asks for, and what the build notice tells an operator to raise `HSTS_MAX_AGE` to once HTTPS is proven. */
const RECOMMENDED_HSTS_MAX_AGE = 31_536_000

/** Any locale prefix, as a path-to-regexp parameter (keep in step with LOCALES in i18n/config.ts: this file imports no app code). */
const LOCALE = ':locale(vi|en)'

/**
 * `Strict-Transport-Security`, only when the public origin is https. Read when `headers()` runs,
 * i.e. at `next build` (the standalone build keeps the result) or when `next dev` starts: the container run-time env
 * cannot change it, so the Dockerfile takes both NEXT_PUBLIC_SITE_URL and HSTS_MAX_AGE as
 * build args.
 * build arg.
 *
 * NEXT_PUBLIC_SITE_URL is read directly, without importing siteUrl() of lib/site.ts: this file does not import app code.
 * Measured with Next transpileConfig: with the native Node TypeScript loader (the flag
 * `--experimental-next-config-strip-types`), the extensionless import `./lib/site` fails with ERR_MODULE_NOT_FOUND
 * and Next has to fall back to the old loader with a warning. The question here is only "is it https or not", so the
 * empty-string rule of lib/site.ts cannot change the result: empty is not https.
 *
 * No `preload`: it is almost impossible to undo. No `includeSubDomains` unless `HSTS_INCLUDE_SUBDOMAINS=true` (an operator who owns
 * every subdomain of the host and serves all of them over https: a subdomain without working HTTPS goes dark for the whole max-age).
 * Only the exact word `true` opts in (trimmed, any case), and `max-age=0` never carries it, so the way back stays one plain value.
 * A `HSTS_MAX_AGE` that is not a number of seconds uses the default; `0` sends `max-age=0`, the way
 * RFC 6797 turns HSTS off: the browser forgets the remembered policy on the next visit over HTTPS, while dropping
 * the header makes it force HTTPS until the old max-age expires.
 */
function hstsHeaders(): { key: string; value: string }[] {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? ''
  if (!/^https:\/\//i.test(site)) return []
  const raw = process.env.HSTS_MAX_AGE?.trim() ?? ''
  const maxAge = /^\d{1,10}$/.test(raw) ? Number(raw) : DEFAULT_HSTS_MAX_AGE
  if (maxAge > 0 && maxAge < RECOMMENDED_HSTS_MAX_AGE) {
    // Once per build (headers() runs once): the default of one day is cautious on purpose, and nothing else would tell an operator
    // to raise it. Not a secret, so it is safe in a build log.
    console.info(
      `[hsts] Strict-Transport-Security max-age is ${maxAge} s, under a year. Once HTTPS has proven stable (the certificate renews, every page opens over https), set HSTS_MAX_AGE=${RECOMMENDED_HSTS_MAX_AGE} and rebuild (docs/INSTALL.md, "Raise HSTS").`,
    )
  }
  const subdomains = maxAge > 0 && (process.env.HSTS_INCLUDE_SUBDOMAINS?.trim().toLowerCase() ?? '') === 'true'
  return [{ key: 'Strict-Transport-Security', value: `max-age=${maxAge}${subdomains ? '; includeSubDomains' : ''}` }]
}

const nextConfig: NextConfig = {
  /**
   * How long, in seconds from the moment it was rendered, a page of the site may be served stale. The default is one year, which is
   * what a shared cache (a CDN in front) reads as `stale-while-revalidate`, and what Next itself uses to decide that an old entry
   * is still good enough to serve once before it renders again: a page nobody opened for a month, of a post unpublished meanwhile by a
   * script, would be shown once more (docs/SECURITY.md, "Caching, and a CDN in front"). With an hour, the pages say
   * `s-maxage=300, stale-while-revalidate=3300`, and an entry older than an hour is rendered fresh before the visitor gets an answer.
   * The pages revalidate every 300 seconds; the value must stay above that (next-config.test.ts).
   */
  expireTime: 3600,

  // Produces .next/standalone — a server plus only the node_modules it actually reaches.
  // The Docker image copies that instead of the whole dependency tree, which is the
  // difference between shipping the production server and shipping the toolchain that
  // built it. Harmless in development: `next dev` ignores it.
  output: 'standalone',

  // No `X-Powered-By: Next.js`: it only tells a scanner which vulnerabilities to try.
  poweredByHeader: false,

  // Rendered pages (ISR) and the data cache stay in memory instead of being written under `.next/server`, which is root-owned and
  // read-only in the container (cache-handler.mjs says why and what stays as it was). Not in `next dev`, which has its own cache.
  // The path is absolute here and the build stores it relative to `.next`, so the standalone folder can be moved.
  ...(process.env.NODE_ENV === 'development' ? {} : { cacheHandler: join(process.cwd(), 'cache-handler.mjs') }),

  // `next dev` prints the URL of every incoming request, with its query string: do not print what a reader typed into the search box
  // (only affects dev; production logs no request).
  logging: { incomingRequests: { ignore: [/^\/search(\?|$)/, /^\/api\/search\//] } },

  // typedRoutes was set here originally and is deliberately gone; see the plan's
  // Task 4 ruling. Every href in this app is built from an API slug at runtime, so
  // typed routes could only ever be satisfied by casts, and the casts silence the
  // check at exactly the links that matter.

  /**
   * Uploaded images (cover images, gallery) go through `/media/<uuid>.<ext>`, a same-origin
   * route handler (app/media/[file]/route.ts). `/_next/image` calls that route in the same process,
   * with no loopback HTTP.
   *
   * - `localPatterns` only has `/media/**`, and `search: ''` forbids every query string: an image changes version
   *   by a new id, not by `?v=`. Next adds `/_next/static/media/**` itself for statically imported
   *   images, so it need not be listed.
   * - NO `remotePatterns`: the backend is not published outside and sits at an internal IP, so optimizing
   *   directly from it would need `dangerouslyAllowLocalIP` and would print the backend host name into the HTML.
   * - `maximumDiskCacheSize`: the default is half of the free disk space at startup. In the container `.next/cache` is a tmpfs of 96 MB
   *   (docker-compose.yml), memory that counts against the container's limit, and this is its only content: 64 MB leaves a third for the
   *   size a file takes on a tmpfs beyond its bytes and for the image being written while the least used ones are deleted. A limit
   *   above the tmpfs does not evict anything and every write fails with ENOSPC once it is full (scripts/test_container_hardening.py
   *   keeps the two in step). An evicted image is encoded again on its next request.
   * - No `outputFileTracingIncludes` for sharp: measured, native sharp loads in the
   *   Alpine standalone image (require.cache points to sharp-linuxmusl-x64 .node).
   * - The WASM build `@img/sharp-wasm32` is ALSO in the standalone on Linux/Alpine, not only when
   *   building on Windows: in the lockfile of sharp 0.35.5 that package is optional and has no `cpu`
   *   restriction, so npm installs it on every platform and Next traces it into the standalone (~8.9 MB, measured in a
   *   container). The native build is loaded first, so the WASM one is an unused fallback. Leave it
   *   as it is, add no `outputFileTracingExcludes`: dropping it drops that fallback too.
   */
  images: {
    localPatterns: [{ pathname: '/media/**', search: '' }],
    maximumDiskCacheSize: 64_000_000,
    // AVIF first, WebP for browsers without it: about 30% and 25% smaller than JPEG at the same look. The browser's Accept header picks.
    formats: ['image/avif', 'image/webp'],
    // 75 for thumbnails, 85 for pictures that are the subject of a page (lib/image-quality.ts); Next serves the closest allowed value.
    qualities: [75, 85],
    // An image id never changes its bytes (a new picture is a new id), so an optimized copy can live a year without revalidation.
    minimumCacheTTL: 31_536_000,
  },

  experimental: {
    // Unknown URLs render app/global-not-found.tsx: with several root layouts there is no root one to wrap app/not-found.tsx.
    globalNotFound: true,
    serverActions: {
      /**
       * 5 MiB, on purpose, no larger. Next reads EVERY multipart POST to EVERY page up to
       * this limit before checking the action id, so it is also the memory limit for an
       * anonymous request: 50 concurrent junk POSTs cost about 250 MB, at 16 MiB about 800 MB. Images
       * are downsized in the browser to ≤ 4 MB before sending, so there is still room for the
       * multipart.
       */
      bodySizeLimit: '5mb',
    },
    /**
     * Equal to the default, written out to make the relation visible: proxy.ts matches /admin/*, exactly where the
     * upload actions POST to; it clones the body and truncates SILENTLY when this limit is exceeded. It must
     * always be larger than `bodySizeLimit`, and next-config.test.ts pins that relation.
     */
    proxyClientMaxBodySize: '10mb',
  },

  /**
   * `/` used to be the paginated post list, reading `?page`, `?tag` and `?category`. It is
   * now the portfolio homepage and reads no search params at all, so every one of those
   * URLs answers **200 with the filter silently dropped** — a reader following a bookmark
   * to `/?tag=aws` gets the homepage and no indication that anything was ignored. A 200
   * showing the wrong page is worse than a 404, because nothing reports it: no link
   * checker, no test, and no entry in any log.
   *
   * These are permanent (308) because the old URLs are genuinely gone, and a crawler that
   * has `/?tag=aws` indexed should transfer it to `/tags/aws` rather than keep checking
   * back.
   *
   * Order matters: `tag` and `category` are checked before `page`, so `/?tag=aws&page=2`
   * lands on the tag archive rather than on `/writing?page=2`, which would have dropped
   * the tag — the exact bug being fixed.
   */
  async redirects() {
    return [
      {
        source: '/',
        has: [{ type: 'query', key: 'tag', value: '(?<tag>.*)' }],
        destination: '/tags/:tag',
        permanent: true,
      },
      {
        source: '/',
        has: [{ type: 'query', key: 'category', value: '(?<category>.*)' }],
        destination: '/categories/:category',
        permanent: true,
      },
      {
        source: '/',
        has: [{ type: 'query', key: 'page', value: '(?<page>.*)' }],
        destination: '/writing?page=:page',
        permanent: true,
      },
      // /tags and /categories never had a page: only /tags/<slug> and /categories/<slug> are
      // real routes. A reader who deletes the URL tail to "go up a level" from /tags/aws hits a 404, while
      // /topics lists exactly what they are looking for (categories and tags, with post counts). 308 because /topics
      // is the official index from now on. The source has no parameters so it only matches exactly these two paths;
      // the page of each tag and each category is not touched.
      { source: '/tags', destination: '/topics', permanent: true },
      { source: '/categories', destination: '/topics', permanent: true },
      // The share card of a post used to live at `/posts/<slug>/opengraph-image-1tl6ux/card`: the file convention adds a build hash to the
      // URL, and links to it are in the preview caches of social networks. The card is a plain route now (`/api/og/posts/<slug>`),
      // and the old URL, whose hash is a constant of the past, redirects to it.
      { source: '/posts/:slug/opengraph-image-1tl6ux/card', destination: '/api/og/posts/:slug', permanent: true },
      // The same rules under a locale prefix (`/en?tag=aws`): the sources above match the unprefixed URL only, and without these
      // `/en/?tag=aws` answers 200 with the filter silently dropped, the exact bug of the first three rules.
      {
        source: `/${LOCALE}`,
        has: [{ type: 'query', key: 'tag', value: '(?<tag>.*)' }],
        destination: '/:locale/tags/:tag',
        permanent: true,
      },
      {
        source: `/${LOCALE}`,
        has: [{ type: 'query', key: 'category', value: '(?<category>.*)' }],
        destination: '/:locale/categories/:category',
        permanent: true,
      },
      {
        source: `/${LOCALE}`,
        has: [{ type: 'query', key: 'page', value: '(?<page>.*)' }],
        destination: '/:locale/writing?page=:page',
        permanent: true,
      },
      { source: `/${LOCALE}/tags`, destination: '/:locale/topics', permanent: true },
      { source: `/${LOCALE}/categories`, destination: '/:locale/topics', permanent: true },
    ]
  },

  /**
   * No page of the site may be embedded in a frame of another site:
   * liking a post, posting a comment and logging out are one-click actions, exactly what clickjacking targets.
   * The site embeds none of its own pages (there is no `<iframe>` besides one markdown test).
   *
   * - Both headers: `X-Frame-Options` has been replaced by the CSP `frame-ancestors` (Next docs,
   *   headers.md), an old browser understands the first, a new one the second.
   * - Static headers do not change rendering: post pages are still prerendered as before.
   * - The CSP is the full, enforced policy of csp-policy.mjs (docs/SECURITY.md, "Content Security Policy"), `frame-ancestors`
   *   included. It carries no nonce, so static and ISR pages stay cacheable. Its `report-uri` and `report-to` send what a
   *   browser blocks to app/api/csp-report/route.ts; `Reporting-Endpoints` names the endpoint `report-to` uses.
   *
   * The standard defensive headers for every path: `nosniff`, `Referrer-Policy` (exactly the
   * default of modern browsers, written out so old browsers follow it too), `Permissions-Policy` turning off
   * camera, microphone, location (no page uses them, markdown strips iframes), and HSTS when the origin is https
   * (hstsHeaders above).
   *
   * The rules for /media and for OAuth are mandatory, not decoration. Measured in node_modules/next 16.3.7:
   * router-server.js puts the config headers on the response BEFORE the route runs, and send-response.js
   * only copies a route handler header when the response does not already have a header of that name. So the first rule would silently
   * replace the CSP that app/media/[file]/route.ts sets for uploaded images, and the `Referrer-Policy:
   * no-referrer` that lib/oauth-flow-cookie.ts sets on every OAuth response (the callback URL carries code and
   * state). A later rule beats an earlier one on the same key, so each specific rule restates the route's exact value;
   * next-config.test.ts calls the real route code and compares the two sides.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: buildContentSecurityPolicy({
              dev: process.env.NODE_ENV === 'development',
              siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
            }),
          },
          // Where `report-to` of the policy sends violation reports (app/api/csp-report/route.ts); `report-uri` is the older twin.
          { key: 'Reporting-Endpoints', value: `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"` },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...hstsHeaders(),
        ],
      },
      {
        source: '/media/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "script-src 'none'; frame-src 'none'; sandbox; frame-ancestors 'none'",
          },
        ],
      },
      {
        source: '/api/auth/github/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      // Newsletter confirm and unsubscribe links carry a token in the URL, and that page calls /api/session on load: with the
      // shared rule, a same-origin Referer carries the whole URL. It also covers /newsletter (no token), harmlessly.
      {
        source: '/newsletter/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      // First-run setup: a page that takes a one-time code and a password. Nothing about it is cached or leaks in a Referer.
      {
        source: '/setup/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      // The same pages under a locale prefix: header rules match the URL as requested, before the middleware rewrites it.
      {
        source: `/${LOCALE}/newsletter/:path*`,
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ]
  },
}

export default withNextIntl(nextConfig)
