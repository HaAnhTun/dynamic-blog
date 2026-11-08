// frontend/app/admin/LogoutButton.tsx
'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { button } from '@/components/admin/ui'
import { LogOutIcon } from '@/components/icons'
import { clearClientSessionData } from '@/lib/client-session-data'
import { suspendDraftWrites } from '@/lib/draft-storage'

export default function LogoutButton() {
  const t = useTranslations('Admin.shell')
  const router = useRouter()
  // Locked while waiting: a double press does not send twice, and the dimmed button shows it was received.
  const [pending, setPending] = useState(false)
  // Set when the session was NOT ended (no answer, or an answer that did not come from the sign-out route): the person must not
  // believe they are signed out.
  const [failed, setFailed] = useState(false)

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setFailed(false)
          // The open editor keeps a debounce timer and a pagehide flush that would write its draft again after the cleanup below, while the
          // request is still in flight. Stop the writes now; if the request fails the session is still alive and they resume.
          const resumeDrafts = suspendDraftWrites()
          let response: Response
          try {
            // A fetch, not a link: logout is a mutation, and a GET that logs you out is
            // triggerable by any image tag pointing at it.
            response = await fetch('/admin/logout', { method: 'POST' })
          } catch {
            // The server was not reached: the session is alive, so nothing is cleared, the editor goes on saving, and the button is enabled
            // again to try once more.
            resumeDrafts()
            setFailed(true)
            setPending(false)
            return
          }
          if (!response.ok) {
            // A proxy error, a refused Origin or a limiter answered before the sign-out route cleared the cookies: the session is
            // alive, exactly as if nothing had answered. Only the route itself answers 200, with `revoked` saying what the backend did.
            resumeDrafts()
            setFailed(true)
            setPending(false)
            return
          }
          try {
            // The cookies are gone either way. `revoked: false` says the server could not end the session (it stays valid
            // until it expires): the login page tells the person, who can end it with "Sign out everywhere".
            const body = (await response.json().catch(() => null)) as { revoked?: unknown } | null
            // The editor's local draft (localStorage) follows the writer, not the machine: a shared machine must not keep unpublished text
            // of the person who just signed out, here or in the other open tabs. Never throws.
            clearClientSessionData()
            router.replace(body?.revoked === false ? '/admin/login?reason=session-not-ended' : '/admin/login')
          } finally {
            setPending(false)
          }
        }}
        className={button('ghost', 'sm', '-mr-1 px-2')}
      >
        <LogOutIcon />
        {t('logout')}
      </button>
      {failed ? (
        <span role="alert" className="ml-2 text-xs text-red-700 dark:text-red-400">
          {t('logoutFailed')}
        </span>
      ) : null}
    </>
  )
}
