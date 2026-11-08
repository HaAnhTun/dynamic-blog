// frontend/app/admin/login/page.tsx
import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { ErrorAlert } from '@/components/admin/primitives'
import { button, CARD, HINT } from '@/components/admin/ui'
import { GitHubLoginLink } from '@/components/site/GitHubLoginLink'
import { firstParam } from '@/lib/first-param'
import { safeAdminNext } from '@/lib/return-to'
import { getDefaultSiteContent } from '@/lib/site-content'
import LoginForm from './LoginForm'
import LoginFrame from './LoginFrame'

export async function generateMetadata() {
  const t = await getTranslations('Admin.login')
  return { title: t('title') }
}

/**
 * STEP 4'S OPEN QUESTION, SETTLED BY MEASUREMENT — the self-contained page, not a
 * route group. Read in node_modules/next (16.3.7); no server was started.
 *
 * 1. A route group cannot escape this parent layout. `next-app-loader` builds the
 *    loader tree by walking FILE-SYSTEM segments from the app root downward and
 *    resolving each level's own `layout` out of that level's directory
 *    (createSubtreePropsFromSegmentPath, next-app-loader/index.js:152, and the
 *    FILE_TYPES resolution at :230). `app/admin/` is a level on the path to
 *    `app/admin/(auth)/login/`, so `app/admin/layout.tsx` is unconditionally in the
 *    chain. A group may ADD a layout at its own level; it can never remove an
 *    ancestor's. Escaping the shell meant moving the layout and every admin page
 *    into an `app/admin/(shell)/` group.
 *
 *    That move was done after this block was written: the shell is now
 *    `app/admin/(shell)/layout.tsx`, and `app/admin/layout.tsx` only returns a fragment carrying
 *    metadata. Nothing of the shell renders above this page, so the page builds its own frame:
 *    background, light theme, `<main>`, and the site name in place of the sidebar.
 *
 * 2. The group would not have helped anyway, because it does not change the URL:
 *    measured with Next's own normalizer,
 *      normalizeAppPath('/admin/(auth)/login/page') -> '/admin/login'
 *      normalizeAppPath('/admin/login/route')       -> '/admin/login'
 *
 * 3. Hence the POST target. This segment ALREADY holds `route.ts`, and a segment
 *    cannot serve both. Next does not complain: the only same-path error,
 *    "You cannot have two parallel pages that resolve to the same path"
 *    (next-app-loader/index.js:576), is reachable only when both entries are `page`
 *    entries; a page/route pair never gets there. At runtime both land under one key
 *    (base-server.js getAppPathRoutes, :1057) and the first matching matcher wins —
 *    and the AppPage provider is registered BEFORE the AppRoute provider
 *    (base-server.js:462-463, and next-dev-server.js:238-239), so THIS PAGE SHADOWS
 *    `route.ts`. Not even the dev "Duplicate page detected" warning fires: it is
 *    skipped when the duplicates' identities differ (dev-route-matcher-manager.js:108)
 *    and they do — AppPageRouteMatcher.identity is
 *    `/admin/login?__nextPage=/admin/login/page` while the route matcher's is plain
 *    `/admin/login`. `// TODO: see if we should error for duplicates in production?`
 *    (default-route-matcher-manager.js:70) is the state of the art there.
 *
 *    So POSTing the form to this URL would hit the page and get a 405, with nothing in
 *    any log to say why. LoginForm posts to LOGIN_ENDPOINT instead, and the handler
 *    lives at `app/admin/login/submit/route.ts`.
 *
 *    Both jobs this block once left for someone else are done: the handler at that path, and
 *    proxy.ts letting exactly that path through when not signed in (LOGIN_SUBMIT_PATH, which must
 *    equal LOGIN_ENDPOINT).
 *
 * The /admin UI is for ADMIN and AUTHOR. proxy.ts and the (shell) layout send every other role
 * here with `?reason=forbidden`, and the page says why before asking for a password. Reading
 * `searchParams` makes the page dynamic; the page has no data, so that is not a meaningful cost.
 * Only the exact values `forbidden` and `session-not-ended` get a sentence; the URL value is never echoed back.
 */
export default async function LoginPage(props: PageProps<'/admin/login'>) {
  const t = await getTranslations('Admin.login')
  const { site } = await getDefaultSiteContent()
  const { reason, next: rawNext } = await props.searchParams
  const forbidden = firstParam(reason) === 'forbidden'
  // The admin signed out, but the server could not end the session (app/admin/(shell)/LogoutButton.tsx): say so, once.
  const sessionNotEnded = firstParam(reason) === 'session-not-ended'
  // Where to go after the last step (`?next=`, for example /admin/security after "sign in again"): an admin path or the admin home.
  const next = safeAdminNext(firstParam(rawNext))

  return (
    <LoginFrame siteName={site.name} title={t('title')} lead={t('lead')}>
      {forbidden ? (
        // A GitHub reader clicked into /admin: being signed in yet asked for a password is confusing,
        // so this sentence comes before the form. "back to the home page" is a real link, not just text.
        <ErrorAlert className="mt-8">
          {t.rich('forbidden', {
            home: (chunks) => (
              <Link
                href="/"
                className="rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
              >
                {chunks}
              </Link>
            ),
          })}
        </ErrorAlert>
      ) : null}
      {sessionNotEnded ? <ErrorAlert className="mt-8">{t('sessionNotEnded')}</ErrorAlert> : null}
      <div className={`${CARD} mt-8 p-6 sm:p-8`}>
        <LoginForm next={next} />
        <p className="my-6 flex items-center gap-3 text-[13px] text-slate-500">
          <span className="h-px flex-1 bg-slate-200" />
          {t('or')}
          <span className="h-px flex-1 bg-slate-200" />
        </p>
        <GitHubLoginLink returnTo={next} className={button('secondary', 'md', 'w-full min-h-10')}>
          {t('github')}
        </GitHubLoginLink>
        <p className={HINT}>{t('authorHint')}</p>
      </div>
    </LoginFrame>
  )
}
