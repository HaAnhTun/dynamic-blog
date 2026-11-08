/** The route that receives the violation reports (app/api/csp-report/route.ts). */
export const CSP_REPORT_PATH = '/api/csp-report'

/**
 * The name of the reporting endpoint in `report-to`; the `Reporting-Endpoints` header of next.config.ts defines it. Browsers that
 * know the Reporting API (Chrome, Edge) use it and ignore `report-uri`; the others (Firefox, Safari) use `report-uri`.
 */
export const CSP_REPORT_GROUP = 'csp-endpoint'

/**
 * The Content-Security-Policy of the HTML pages (docs/SECURITY.md, "Content Security Policy": enforced by next.config.ts, with a
 * report endpoint, since stage 2).
 *
 * A plain `.mjs` file on purpose: next.config.ts imports no app code, and an extensionless `.ts` import fails under
 * Node's native TypeScript loader (see the note in next.config.ts). The policy needs no `@/` alias or any other module.
 *
 * Why 'unsafe-inline' for scripts: the theme boot script (components/RootShell.tsx) and the React Server Components
 * payload (`self.__next_f.push(...)`) are inline scripts. A nonce would force every page to render per request and
 * lose the static and ISR cache; hashes cannot cover the RSC payload, which differs on every page. The policy therefore
 * does not stop injected inline scripts. What it does stop: loading script from another origin, plugins, `<base>` tag
 * hijacking, form posts to another origin, framing, calls to another origin from script (`connect-src`) and eval in
 * production. The nonce stage is a separate decision.
 *
 * Why `https:` for images: an author may put an `https` image in a figure block or in Markdown, and the product says so
 * (docs/content-blocks.md). Listing only the hosts the code itself uses (GitHub avatars) would break those pictures on the day the
 * policy is enforced. An image cannot run code, so this costs privacy (a third-party host sees the reader), not integrity;
 * docs/SECURITY.md, "What is not protected", says so. Every other directive stays on `'self'` or `'none'`.
 *
 * No page embeds a frame, and the client only calls its own origin (the BFF routes).
 *
 * @param {{ dev: boolean, siteUrl?: string, reportOnly?: boolean }} options `dev` is true for `next dev` (React needs eval
 *   for stack reconstruction there); `siteUrl` is NEXT_PUBLIC_SITE_URL, https adds `upgrade-insecure-requests`;
 *   `reportOnly` leaves out `frame-ancestors` and `upgrade-insecure-requests`, which browsers ignore (with a console
 *   warning) in a Report-Only policy. next.config.ts does not use it: it is the way back to Report-Only if an enforced
 *   policy ever has to be taken back (send the result as `Content-Security-Policy-Report-Only`, and keep an enforced
 *   `frame-ancestors 'none'` next to it).
 * @returns {string} the policy, directives separated by `; `
 */
export function buildContentSecurityPolicy({ dev, siteUrl, reportOnly = false }) {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])]
  const directives = [
    ['default-src', "'self'"],
    ['script-src', ...scriptSrc],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:', 'https:'],
    ['font-src', "'self'", 'data:'],
    ['connect-src', "'self'"],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
  ]
  if (!reportOnly) directives.push(['frame-ancestors', "'none'"])
  if (!reportOnly && /^https:\/\//i.test(siteUrl?.trim() ?? '')) directives.push(['upgrade-insecure-requests'])
  directives.push(['report-uri', CSP_REPORT_PATH], ['report-to', CSP_REPORT_GROUP])
  return directives.map((parts) => parts.join(' ')).join('; ')
}
