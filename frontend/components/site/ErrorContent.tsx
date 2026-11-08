import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Container } from './Container'
import { CARD, CARD_PAGE } from './reader/reader-layout'
import { FOCUS_RING, INLINE_LINK, TRANSITION } from './SectionHeading'

/**
 * The wording of the error pages lives in the `Site.errorPage` messages, one place for all three boundaries:
 * app/(site)/error.tsx, app/admin/error.tsx and app/global-error.tsx (the last renders outside the providers, so it builds
 * its own translator and has no Tailwind: it only uses the text, not the components below).
 *
 * The reader's words, not the operator's: no "API", no "server". The reader can do exactly
 * two things — try again, or go elsewhere — so the lead sentence says exactly those two things.
 */

/** Three ways out, the same three links as the 404 page (NotFoundContent). `labelKey` is relative to `Site.errorPage`. */
export const ERROR_EXITS = [
  { href: '/', labelKey: 'exits.home' },
  { href: '/writing', labelKey: 'exits.allPosts' },
  { href: '/search', labelKey: 'exits.search' },
] as const

/** The site's primary button, like the submit button of the comment form: 40px on a phone, 36px from 640px. */
const RETRY = `inline-flex h-10 items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-4 text-sm font-medium text-white hover:border-brand hover:bg-brand sm:h-9 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

/**
 * The content part of the error page, like NotFoundContent of the 404 page: a centred 768px card (CARD_PAGE and CARD of reader-layout.ts), no
 * `<main>` — the boundary of the (site) group already sits inside the group layout's `<main>`, while the boundary at the root wraps
 * `<main id="main-content">` around this part itself.
 *
 * It takes `digest` and not the whole `error`: the rendered part has no way to reach `error.message`. In
 * production Next already replaces the message of a server error with a generic sentence, but an error thrown on the client keeps its
 * message, and the ApiError of lib/api.ts carries the request path.
 *
 * `digest` is the only thing linking this screen to the server log, so it is printed — small, at the bottom.
 */
export function ErrorContent({ digest, retry }: { digest?: string; retry: () => void }) {
  const t = useTranslations('Site.errorPage')
  return (
    <Container width="prose" className={CARD_PAGE}>
      <div className={CARD}>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">{t('lead')}</p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4 text-sm">
          {/* `() => retry()`: do not pass the click event into Next's function. */}
          <button type="button" onClick={() => retry()} className={RETRY}>
            {t('retry')}
          </button>
          {ERROR_EXITS.map((exit) => (
            <Link key={exit.href} href={exit.href} className={INLINE_LINK}>
              {t(exit.labelKey)}
            </Link>
          ))}
        </div>
        {digest ? (
          <p className="mt-8 font-mono text-xs text-neutral-500 dark:text-neutral-400">{t('digest', { digest })}</p>
        ) : null}
      </div>
    </Container>
  )
}
