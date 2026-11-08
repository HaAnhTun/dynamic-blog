// frontend/app/admin/login/LoginForm.tsx
'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ErrorAlert } from '@/components/admin/primitives'
import { button, INPUT, LABEL } from '@/components/admin/ui'
import { mfaStepPath } from '@/lib/return-to'

/**
 * Where the credentials are POSTed. NOT `/admin/login`, which is this page's own URL,
 * and the reason is measured rather than stylistic — see the block comment in
 * `app/admin/login/page.tsx`. In short: a Next segment cannot serve both a `page` and a
 * `route`, the page silently wins, and a POST to a page route is a 405.
 *
 * This is the one line to change if the coordinator relocates the login Route Handler
 * somewhere other than `app/admin/login/submit/route.ts`. It is exported so the test
 * asserts the same constant the component uses, rather than a copy that can drift.
 */
export const LOGIN_ENDPOINT = '/admin/login/submit'

/**
 * `next`: where the sign-in ends (an admin path, already checked by the page with `safeAdminNext`); `/admin` by default.
 * It is kept through the second step in the URL of its pages (never in storage).
 */
export default function LoginForm({ next = '/admin' }: { next?: string }) {
  const t = useTranslations('Admin.login')
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    try {
      // Posts to the Route Handler, which is what holds the cookies. The token never
      // passes through this component, so there is nothing here for an XSS to steal.
      const res = await fetch(LOGIN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      })
      // DEVIATION from the plan, which branched on `!res.ok` alone: the handler answers
      // `{ ok: true }` and nothing else, so that is what success is. A 200 whose body is
      // not that means something other than the handler answered — in practice a
      // middleware redirect that fetch followed back to this very page, which `res.ok`
      // reads as success and which then bounces off /admin with no message at all.
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean
        error?: string
        next?: string
        enrollmentCodeRequired?: boolean
      } | null
      if (!res.ok || body?.ok !== true) {
        setError(body?.error ?? t('failed'))
        return
      }
      // The password was right but a second step is due (every administrator): no session exists yet, only the challenge
      // cookie. `enrollmentCodeRequired` is a hint for which step to draw; the backend decides.
      if (body.next === 'mfa' || body.next === 'enroll') {
        router.replace(mfaStepPath(body.next, { next, codeRequired: body.enrollmentCodeRequired === true }))
        return
      }
      // replace, not push: the back button must not return to a login form that is
      // already satisfied.
      router.replace(next)
    } catch {
      setError(t('network'))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      // Before hydration (or without JavaScript) the browser submits natively: a POST that the route refuses (it takes JSON only), never a GET that would put the password in the URL, the history and the access log.
      method="post"
      action={LOGIN_ENDPOINT}
      onSubmit={onSubmit}
      className="space-y-5"
    >
      <div>
        <label htmlFor="email" className={LABEL}>
          {t('email')}
        </label>
        <input id="email" name="email" type="email" required autoComplete="username" className={INPUT} />
      </div>
      <div>
        <label htmlFor="password" className={LABEL}>
          {t('password')}
        </label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className={INPUT} />
      </div>
      {/* Right above the button: the next press goes past the previous error message. */}
      {error !== null && <ErrorAlert>{error}</ErrorAlert>}
      {/* min-h-10, not h-10: the md size of button() already carries h-9, and when two height
          classes apply at once the winner is decided by the order Tailwind emits CSS, not the order
          written. A larger min-height always beats height. The button is one step taller because it
          is the only job on the whole page. */}
      <button type="submit" disabled={pending} className={button('primary', 'md', 'w-full min-h-10')}>
        {pending ? t('submitting') : t('submit')}
      </button>
    </form>
  )
}
