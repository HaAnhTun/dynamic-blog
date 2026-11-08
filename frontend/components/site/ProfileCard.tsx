'use client'

import { useRouter } from '@/i18n/navigation'
import { useRef, useState } from 'react'
import { BrandIcon } from '@/components/BrandIcon'
import { formatDate } from '@/lib/date'
import { logout, useSession } from '@/lib/session-client'
import type { SessionUser } from '@/lib/types'
import { Avatar } from './Avatar'
import { GitHubLoginLink } from './GitHubLoginLink'
import { FOCUS_RING, INLINE_LINK, TRANSITION } from './SectionHeading'
import { useLocale, useTranslations } from 'next-intl'
import { asLocale } from '@/lib/format'

/**
 * Content of /profile: photo, name, GitHub name, join date,
 * and the sign-out button. No more: no bio, no "your comments" (maybe later).
 *
 * A client island in a static page: the page does not read cookies, so its HTML is identical for
 * everyone; the session comes from the client-side store after hydration.
 */

/** Primary button, the same style as the "Continue with GitHub" button of the /login page. */
const PRIMARY = `inline-flex items-center gap-2 rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:border-brand hover:bg-brand dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

/** Secondary bordered button, the same shape as the header's buttons: signing out is not the primary action here. */
const SECONDARY = `inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium text-neutral-700 hover:border-brand hover:text-brand dark:border-neutral-700 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

export function ProfileCard() {
  const session = useSession()
  const t = useTranslations('Site.profileCard')

  if (session.status === 'loading') {
    // Reserve exactly the profile's mold (64px photo, two lines of text) so the page does not jump when the session answers.
    return (
      <div aria-busy="true" className="mt-8 flex items-center gap-4 sm:gap-5">
        <span aria-hidden="true" className="h-16 w-16 shrink-0 rounded-full bg-neutral-100 dark:bg-neutral-900" />
        <span aria-hidden="true" className="flex-1 space-y-2">
          <span className="block h-5 w-40 max-w-full rounded bg-neutral-100 dark:bg-neutral-900" />
          <span className="block h-4 w-28 max-w-full rounded bg-neutral-100 dark:bg-neutral-900" />
        </span>
      </div>
    )
  }

  if (session.status === 'anonymous') {
    return (
      <div className="mt-8">
        <p className="text-neutral-700 dark:text-neutral-300">{t('anonymous')}</p>
        <GitHubLoginLink returnTo="/profile" className={`${PRIMARY} mt-4`}>
          {t('signInGithub')}
        </GitHubLoginLink>
      </div>
    )
  }

  return <ProfileDetails user={session.user} />
}

function ProfileDetails({ user }: { user: SessionUser }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // Block a double click: state only changes on the next render, a ref changes immediately.
  const pending = useRef(false)
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.profileCard')
  const joined = formatDate(user.joinedAt, 'long', locale)

  async function onLogout() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    if (await logout()) {
      // Signing out at /profile goes to the home page. The "signed out" sentence and focus returning to the sign-in button
      // are handled by the account button in the header, because the header stays after this page goes.
      router.replace('/')
      return
    }
    pending.current = false
    setBusy(false)
    setFailed(true)
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-4 sm:gap-5">
        <Avatar name={user.displayName} src={user.avatarUrl} size={64} />
        <div className="min-w-0">
          {/* <bdi>: the name is set by the user. A long name wraps anywhere, never overflows horizontally. */}
          <h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            <bdi>{user.displayName}</bdi>
          </h2>
          {/* An account with only a password and no GitHub login: no link, no "@null". */}
          {user.githubLogin !== null ? (
            <p className="mt-1 text-sm">
              <a
                href={`https://github.com/${encodeURIComponent(user.githubLogin)}`}
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1.5 ${INLINE_LINK}`}
              >
                <BrandIcon name="github" size={14} />@{user.githubLogin}
              </a>
            </p>
          ) : null}
          {joined !== null ? (
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {t.rich('joined', { date: joined, time: (chunks) => <time dateTime={user.joinedAt}>{chunks}</time> })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-8">
        <button type="button" onClick={onLogout} aria-disabled={busy} className={SECONDARY}>
          {busy ? t('signingOut') : t('signOut')}
        </button>
        {failed ? (
          <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
            {t('signOutFailed')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
