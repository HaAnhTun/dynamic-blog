// frontend/app/admin/(shell)/layout.tsx
//
// In a route group, so it wraps /admin and /admin/posts/** but NOT /admin/login. A login
// screen showing an admin nav to someone who is not logged in was the shape before the
// split, and a nested layout cannot opt a child out of an ancestor — the group is the
// only way to express "these pages, not that one". The group name never appears in a URL.
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { DraftOwner } from '@/components/admin/DraftOwner'
import { accessCookieName } from '@/lib/auth-cookies'
import { isAdminRole } from '@/lib/admin-role'
import { roleOf, subjectOf } from '@/lib/jwt'
import { getDefaultSiteContent } from '@/lib/site-content'
import { isUuid } from '@/lib/uuid'
import AdminSidebar from './AdminSidebar'

/**
 * Every admin page is dynamic. They read a cookie, so Next could not pre-render them
 * anyway, but saying it here means a future page that happens not to read one does not
 * silently become static and serve one author's drafts to everybody.
 */
export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(accessCookieName())?.value
  // The second layer after proxy.ts: the proxy already blocks at the HTTP level, this is for every
  // full render, in case the proxy does not run (a changed matcher, a new render path).
  if (!token) redirect('/admin/login')
  // From the token's claim: UX routing only. The backend re-reads the current
  // role from the database for every ADMIN/AUTHOR request, so a stale claim may show the
  // shell but never the data. /admin admits ADMIN and AUTHOR — a forged claim
  // only renders an empty shell, because every data call goes to the backend, which
  // verifies the signature and refuses with SessionExpiredError or FORBIDDEN through the
  // existing paths. No backend call here on purpose: with none, the layout has no outage
  // path that could escape (shell)/error.tsx.
  const role = roleOf(token)
  if (!isAdminRole(role)) redirect('/admin/login?reason=forbidden')
  // Whose local drafts the editor may touch: the user id (a UUID) in the token's `sub`. Like the role, an unverified claim, and like the role it
  // only chooses what the browser shows: it keeps one account's unsaved text from being offered to the next one on the same browser.
  const sub = subjectOf(token)
  const draftOwner = isUuid(sub) ? sub : null
  const t = await getTranslations('Admin.shell')
  const { site } = await getDefaultSiteContent()

  return (
    // `DraftOwner` renders no element of its own (it hands the editor the account whose local drafts it may touch), so the first
    // element below is still the shell.
    //
    // Admin has a single theme, light, set here rather than through `dark:` on each element. The site's
    // body carries `dark:text-neutral-100`; the shell sets its own background and text colour that every child, input
    // included, inherits; a light color-scheme keeps checkboxes, selects and scrollbars drawn for a light background.
    //
    // `data-admin` lets the site CSS exclude this region from rules meant only for the dark theme (the `dark:`
    // variant, cover art, figure, figcaption, .shiki inside .prose in globals.css): without it, the
    // editor's "Preview" frame shows dark Shiki code on a white background (visual QA).
    //
    // Ghost-style layout: from lg a left sidebar + content area; below lg the sidebar becomes a top bar.
    // Flex rather than a two-column grid: the editor and the preview have no sidebar (AdminSidebar returns
    // null), and the content area then takes the full width instead of falling into the 15rem column.
    <DraftOwner owner={draftOwner}>
      <div data-admin className="min-h-dvh bg-white text-slate-900 [color-scheme:light] lg:flex">
        {/*
          Skip link: the first focusable thing on every admin page, so keyboard and screen reader users do not have to go
                  through the site name, the "Menu" button and the eight nav items on every page. The same classes
                  as the site's skip link (components/site/Header.tsx) except the `dark:` variant: admin has a single light theme.
                  Hidden with sr-only, NOT with `hidden` — display:none leaves the Tab order. `focus:absolute`
                  puts it in the top left corner, above the sidebar's sticky bar (z-30).
        */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-brand focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-brand focus:outline-2 focus:outline-offset-2 focus:outline-brand"
        >
          {t('skipToContent')}
        </a>
        <AdminSidebar siteName={site.name} role={role} />
        {/*
          The admin area's own <main>, and the id the skip link in the PUBLIC header points
          at. These pages no longer render inside app/(site)/layout.tsx — which is what
          owns that <main> for the public site — so without one here the admin screens
          would have no main landmark at all.

          Sets no width or padding: each page wraps its content in PAGE
                  (components/admin/ui.ts), and the editor needs the full width.
        */}
        <main id="main-content" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </DraftOwner>
  )
}
