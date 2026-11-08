import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { ADMIN_CLIENT_NAMESPACES, pickMessages } from '@/i18n/client-messages'
import { RootShell } from '@/components/RootShell'
import { siteUrlObject } from '@/lib/site'

/**
 * Exists for one line of metadata, and renders nothing.
 *
 * ## What it fixes
 *
 * `/admin` 307s to `/admin/login`, which answers 200 with a real HTML login form and —
 * measured before this file — no `<meta name="robots">` and no `X-Robots-Tag`. `robots.txt`
 * already carries `Disallow: /admin`, but a disallow blocks CRAWLING, not INDEXING: a URL
 * that is linked from somewhere else can still be listed in results, as a bare URL with no
 * snippet, because the crawler never fetched it and so never learned not to.
 *
 * Worth stating plainly rather than hiding, because the two measures are in tension for the
 * one crawler that matters most: while `Disallow: /admin` stands, Googlebot will not fetch
 * this page and therefore will never see the tag below. The tag is what covers every other
 * case — the crawler that ignores robots.txt, the day somebody loosens that rule, an
 * internal search appliance, an archiver. Keeping both is defence in depth, and the
 * robots.txt rule stays exactly as it is (app/robots.test.ts asserts the whole rule set).
 *
 * ## Why here, at `app/admin/`, and not four times
 *
 * `app/admin/` is a filesystem level on the path to BOTH admin branches —
 * `app/admin/(shell)/**` and `app/admin/login` — and next-app-loader resolves each level's
 * layout out of that level's own directory while walking down from the app root. So this
 * layout is unconditionally in both chains. That is the same mechanism
 * `app/admin/login/page.tsx` documents at length as the reason the login page could NOT
 * escape the admin shell; here it works for us instead of against us.
 *
 * It also cannot leak onto a public page, structurally rather than by care: the public
 * routes live in `app/(site)/`, a sibling of this directory, not a descendant, and metadata
 * only flows root-to-leaf. A test asserts the whole tree declares `noindex` in exactly two
 * places — here, and `/search?q=` — so a future page that adds one anywhere else fails
 * loudly.
 *
 * ## The two things this file must NOT grow
 *
 * A wrapper element. It returns a fragment, so the DOM is byte-identical to before: the
 * login page is a self-contained full-height panel and the (shell) layout owns the admin
 * chrome, and a `<div>` inserted between `body.flex.min-h-dvh.flex-col` and the shell's
 * `min-h-screen` wrapper could change how the footer pins.
 *
 * A segment config. `export const dynamic = 'force-dynamic'` belongs on the (shell) layout,
 * where it is scoped to the pages that read a cookie. Repeating it here would newly force
 * `/admin/login` dynamic, which is an unrelated behaviour change smuggled in under an SEO
 * fix.
 */
export const metadata: Metadata = {
  // The site-wide share image (app/opengraph-image.tsx) is attached to every route under app/, admin included, and Next warns at
  // build time when it has no origin to resolve it against. The public site gets it from the [locale] layout.
  metadataBase: siteUrlObject(),
  /**
   * `follow: false`, unlike `/search?q=`, which is `follow: true`.
   *
   * The asymmetry is the interesting part and is read off what is actually on each page.
   * The search results page links to real published articles, so refusing a crawler the
   * path to them would cost something. Every link on an admin page points back into
   * `/admin/*` except the single "Xem blog" link to `/`, which is in the sitemap and linked
   * from every public page anyway — so `follow: true` would discover nothing here. And the
   * admin post list renders DRAFTS: if a row ever grows a preview link, `nofollow` keeps an
   * unpublished URL out of the crawl frontier instead of feeding it in.
   */
  robots: { index: false, follow: false },
}

/**
 * Admin is always light: the shell and the login page set `color-scheme: light` and have no dark variant.
 * The root layout's `themeColor` follows the operating system theme (app/layout.tsx), so on a dark
 * machine the browser bar would be dark above a white page. Overridden here for the whole admin
 * branch: Next merges `viewport` per segment, and the child segment wins on the same key.
 */
export const viewport: Viewport = { themeColor: '#ffffff' }

/**
 * The root layout of the admin: its own `<html>`, whose `lang` is the admin language (cookie, see i18n/request.ts). It still
 * returns no wrapper element: the shell is the document's flex column child, as before.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  return (
    <RootShell lang={locale}>
      <NextIntlClientProvider messages={pickMessages(await getMessages(), ADMIN_CLIENT_NAMESPACES)}>
        {children}
      </NextIntlClientProvider>
    </RootShell>
  )
}
