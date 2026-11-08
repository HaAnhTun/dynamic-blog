'use client'

import { Link } from '@/i18n/navigation'
import { useEffect, useRef, useState, type Ref } from 'react'
import { useTranslations } from 'next-intl'
import { FOCUS_RING, INLINE_LINK, TRANSITION } from '@/components/site/SectionHeading'
import { callBff } from '@/lib/bff-client'
import { sendError } from './messages'

/**
 * Button of /newsletter/confirm and /newsletter/unsubscribe. Opening the link only draws the button: mail scanners open links before
 * the reader, so only a real click sends the POST. The token arrives here as a prop, only to be sent, and is never printed.
 */

export type TokenKind = 'confirm' | 'unsubscribe'

const URLS: Record<TokenKind, string> = {
  confirm: '/api/newsletter/confirm',
  unsubscribe: '/api/newsletter/unsubscribe',
}

/** Same primary button style as /login and /profile; `aria-disabled` while sending. */
const PRIMARY = `inline-flex h-10 items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-4 text-sm font-medium text-white hover:border-brand hover:bg-brand aria-disabled:cursor-wait aria-disabled:opacity-70 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

const RESULT = `mt-6 rounded-md border border-neutral-200 px-4 py-3 text-neutral-800 dark:border-neutral-800 dark:text-neutral-200 ${FOCUS_RING}`

/** Broken link: one sentence for every case, with a way back to /newsletter. The page draws it directly when the token is malformed. */
export function InvalidLink({ kind, ref }: { kind: TokenKind; ref?: Ref<HTMLDivElement> }) {
  const t = useTranslations('Site.newsletter')
  return (
    <div ref={ref} tabIndex={-1} className={RESULT}>
      <p>{t('token.linkInvalid')}</p>
      <Link href="/newsletter" className={`mt-2 inline-block text-sm ${INLINE_LINK}`}>
        {t(`token.${kind}.back`)}
      </Link>
    </div>
  )
}

type Phase = 'idle' | 'busy' | 'done' | 'invalid'

export function TokenAction({ kind, token }: { kind: TokenKind; token: string }) {
  const t = useTranslations('Site.newsletter')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const result = useRef<HTMLDivElement>(null)

  // The button just clicked disappears together with its part: focus goes to the result sentence instead of falling back to <body>.
  useEffect(() => {
    if (phase === 'done' || phase === 'invalid') result.current?.focus()
  }, [phase])

  async function run() {
    if (pending.current) return
    pending.current = true
    setPhase('busy')
    setError(null)
    const outcome = await callBff<unknown>(URLS[kind], { method: 'POST', body: JSON.stringify({ token }) })
    pending.current = false
    if (outcome.ok) setPhase('done')
    else if (outcome.code === 'NEWSLETTER_TOKEN_INVALID') setPhase('invalid')
    else {
      setPhase('idle')
      setError(sendError(outcome.code, outcome.status, t))
    }
  }

  if (phase === 'invalid') return <InvalidLink kind={kind} ref={result} />
  if (phase === 'done') {
    return (
      <div ref={result} tabIndex={-1} className={RESULT}>
        <p>{t(`token.${kind}.done`)}</p>
      </div>
    )
  }
  return (
    <div className="mt-6">
      <button type="button" onClick={() => void run()} aria-disabled={phase === 'busy' || undefined} className={PRIMARY}>
        {phase === 'busy' ? t(`token.${kind}.busy`) : t(`token.${kind}.button`)}
      </button>
      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
