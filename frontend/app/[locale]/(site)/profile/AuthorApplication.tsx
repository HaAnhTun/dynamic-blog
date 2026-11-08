'use client'

import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { GitHubLoginLink } from '@/components/site/GitHubLoginLink'
import { FOCUS, FOCUS_RING, INLINE_LINK, TRANSITION } from '@/components/site/SectionHeading'
import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translator'
import { callBff } from '@/lib/bff-client'
import { formatDate } from '@/lib/date'
import { asLocale, dateFormat } from '@/lib/format'
import { needsLogin } from '@/lib/interaction-errors'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { AuthorApplication as Application, AuthorApplicationStatus, MyAuthorApplication } from '@/lib/types'

/**
 * The "Apply to become an author" part of /profile: the status of the reader's latest application, and the form to submit
 * an application when one can be submitted. A client island like ProfileCard: the page stays static, the application loads through /api/me/author-application after the
 * session answers. Only readers (USER) have anything to ask for: authors and admins see one line, no backend call.
 */

const API = '/api/me/author-application'

/** Same limit as the backend (the CHECK of migration V28). `maxLength` counts UTF-16 units, so it never exceeds 500 code points. */
const MOTIVATION_MAX_LENGTH = 500

const STATUSES: readonly AuthorApplicationStatus[] = ['PENDING', 'APPROVED', 'REJECTED']

/** Same primary button style as /login and /profile; `aria-disabled` while sending. */
const PRIMARY = `inline-flex h-10 items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-4 text-sm font-medium text-white hover:border-brand hover:bg-brand aria-disabled:cursor-wait aria-disabled:opacity-70 sm:h-9 dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white ${TRANSITION} ${FOCUS_RING}`

const SECONDARY = `inline-flex h-10 items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-700 hover:border-brand hover:text-brand sm:h-9 dark:border-neutral-700 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

/** `text-base`: below 16px Safari on iPhone zooms the page by itself when the field gets focus (like CommentForm). */
const TEXTAREA =
  'mt-2 block w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 read-only:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:read-only:bg-neutral-950'

const MUTED = 'text-neutral-600 dark:text-neutral-400'
const BAR = 'block rounded bg-neutral-100 dark:bg-neutral-900'

/** Message key (under `Site.profile.author.errors`) by error code; the English backend `message` is never shown. */
const SUBMIT_ERROR_KEYS: Record<string, string> = {
  AUTHOR_APPLICATION_PENDING: 'pending',
  AUTHOR_APPLICATION_COOLDOWN: 'cooldown',
  AUTHOR_APPLICATION_NOT_ALLOWED: 'notAllowed',
  RATE_LIMITED: 'rateLimited',
  USER_SUSPENDED: 'suspended',
  VALIDATION_ERROR: 'tooLong',
  PAYLOAD_TOO_LARGE: 'tooLong',
}

type SubmitError = { message: string; login: boolean }

/** `t` is the `Site.profile.author` translator. */
function submitError(code: string, status: number, t: Translator): SubmitError {
  const tooLong = () => t('errors.tooLong', { max: MOTIVATION_MAX_LENGTH })
  if (needsLogin(code, status)) return { message: t('errors.sessionExpired'), login: true }
  const known = SUBMIT_ERROR_KEYS[code]
  if (known === 'tooLong') return { message: tooLong(), login: false }
  if (known !== undefined) return { message: t(`errors.${known}`), login: false }
  if (status === 413) return { message: tooLong(), login: false }
  if (code === 'NETWORK' || status === 0 || status >= 500) return { message: t('errors.network'), login: false }
  return { message: t('errors.fallback'), login: false }
}

/** The backend contract, checked again here: an off-contract payload is "could not load", not a broken page. */
function parseApplication(value: unknown): Application | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const status = STATUSES.find((candidate) => candidate === raw.status)
  if (typeof raw.id !== 'string' || status === undefined || typeof raw.createdAt !== 'string') return null
  return {
    id: raw.id,
    status,
    motivation: typeof raw.motivation === 'string' ? raw.motivation : null,
    createdAt: raw.createdAt,
    decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : null,
  }
}

function parseState(value: unknown): MyAuthorApplication | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.canApply !== 'boolean') return null
  const application = raw.application == null ? null : parseApplication(raw.application)
  if (raw.application != null && application === null) return null
  return {
    application,
    canApply: raw.canApply,
    reapplyAfter: typeof raw.reapplyAfter === 'string' ? raw.reapplyAfter : null,
  }
}

/**
 * Time and date in the reader time zone, not UTC like every other date on the site (lib/date.ts): this is a deadline
 * exact to the minute, and it is drawn only in the browser after loading, so there is no server HTML for it to disagree with.
 */
function formatDeadline(iso: string, locale: Locale, t: Translator): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const time = dateFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
  return t('deadline', { time, date: dateFormat(locale, { dateStyle: 'long' }).format(date) })
}

export function AuthorApplicationSection() {
  const session = useSession()
  const t = useTranslations('Site.profile.author')
  const headingId = useId()
  // Guest and while the session is being asked: nothing at all. The server HTML (static page) never carries this part.
  if (session.status !== 'authenticated') return null
  const { role } = session.user

  return (
    <section aria-labelledby={headingId} className="mt-12 border-t border-neutral-200 pt-8 dark:border-neutral-800">
      <h2 id={headingId} tabIndex={-1} className={`text-lg font-semibold tracking-tight ${FOCUS}`}>
        {t('heading')}
      </h2>
      {role === 'USER' ? (
        <ReaderApplication headingId={headingId} />
      ) : (
        <p className={`mt-2 ${MUTED}`}>
          {role === 'ADMIN'
            ? t('adminNote')
            : // A plain <a> like in AccountMenu: /admin is a different application, not prefetched from a public page.
              t.rich('authorNote', {
                admin: (chunks) => (
                  <a href="/admin" className={INLINE_LINK}>
                    {chunks}
                  </a>
                ),
              })}
        </p>
      )}
    </section>
  )
}

type Load = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; state: MyAuthorApplication }

function ReaderApplication({ headingId }: { headingId: string }) {
  const t = useTranslations('Site.profile.author')
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  // Number of the latest load: the answer of an older load (repeated clicks on "Try again") is dropped.
  const seq = useRef(0)
  const statusRef = useRef<HTMLDivElement>(null)
  // Where focus goes after the next render: the button just clicked ("Submit application", "Try again") disappears together with its part.
  const focusNext = useRef<'status' | 'heading' | null>(null)

  useEffect(() => {
    const target = focusNext.current
    if (target === null || load.status === 'loading') return
    focusNext.current = null
    // The reader tabbed elsewhere while waiting: leave it alone. Focus only falls back to <body> when the button just clicked disappears.
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    if (target === 'status' && statusRef.current !== null) statusRef.current.focus()
    else document.getElementById(headingId)?.focus()
  }, [load, headingId])

  function fetchState(): void {
    const current = ++seq.current
    void callBff<unknown>(API).then((result) => {
      if (current !== seq.current) return
      if (!result.ok && needsLogin(result.code, result.status)) {
        setAnonymous()
        return
      }
      const state = result.ok ? parseState(result.data) : null
      setLoad(state === null ? { status: 'failed' } : { status: 'ready', state })
    })
  }

  const onMount = useEffectEvent(fetchState)
  useEffect(() => {
    onMount()
  }, [])

  function applied(application: Application | null): void {
    focusNext.current = 'status'
    if (application === null) {
      // 201 but the body is off contract: the application was created, ask for the status again instead of guessing.
      setLoad({ status: 'loading' })
      fetchState()
      return
    }
    seq.current += 1
    setLoad({ status: 'ready', state: { application, canApply: false, reapplyAfter: null } })
  }

  if (load.status === 'loading') {
    // A roughly right placeholder of the form shape (the most common state) so the page does not jump when the application finishes loading.
    return (
      <div aria-busy="true" className="mt-2">
        <span aria-hidden="true" className="block space-y-2">
          <span className={`${BAR} h-4 w-full`} />
          <span className={`${BAR} h-4 w-2/3`} />
        </span>
        <span aria-hidden="true" className={`${BAR} mt-6 h-4 w-48 max-w-full`} />
        <span aria-hidden="true" className={`${BAR} mt-4 h-28 w-full`} />
        <span aria-hidden="true" className={`${BAR} mt-3 ml-auto h-10 w-28 sm:h-9`} />
      </div>
    )
  }

  if (load.status === 'failed') {
    return (
      <div className="mt-2">
        <p className={MUTED}>{t('loadFailed')}</p>
        <button
          type="button"
          onClick={() => {
            focusNext.current = 'heading'
            setLoad({ status: 'loading' })
            fetchState()
          }}
          className={`${SECONDARY} mt-4`}
        >
          {t('retry')}
        </button>
      </div>
    )
  }

  const { application, canApply, reapplyAfter } = load.state
  // An approved application that can be submitted again (the person was demoted later): the old application says nothing about the present.
  const showStatus = application !== null && !(application.status === 'APPROVED' && canApply)

  return (
    <>
      {showStatus && (
        <ApplicationStatus ref={statusRef} application={application} canApply={canApply} reapplyAfter={reapplyAfter} />
      )}
      {canApply ? (
        <ApplyForm onApplied={applied} />
      ) : (
        application === null && <p className={`mt-2 ${MUTED}`}>{t('cannotApply')}</p>
      )}
    </>
  )
}

function ApplicationStatus({
  ref,
  application,
  canApply,
  reapplyAfter,
}: {
  ref: Ref<HTMLDivElement>
  application: Application
  canApply: boolean
  reapplyAfter: string | null
}) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.profile.author')
  let title: string
  let detail: ReactNode
  if (application.status === 'PENDING') {
    const sent = formatDate(application.createdAt, 'long', locale)
    title = t('status.pending.title')
    detail = (
      <>
        {sent !== null && (
          <>
            {t.rich('status.pending.sent', {
              date: sent,
              time: (chunks) => <time dateTime={application.createdAt}>{chunks}</time>,
            })}{' '}
          </>
        )}
        {t('status.pending.review')}
      </>
    )
  } else if (application.status === 'APPROVED') {
    title = t('status.approved.title')
    detail = t('status.approved.detail')
  } else {
    const deadline = reapplyAfter === null ? null : formatDeadline(reapplyAfter, locale, t)
    title = canApply ? t('status.rejected.titleCanApply') : t('status.rejected.title')
    detail = canApply
      ? t('status.rejected.canApply')
      : deadline !== null && reapplyAfter !== null
        ? t.rich('status.rejected.reapplyFrom', {
            deadline,
            time: (chunks) => <time dateTime={reapplyAfter}>{chunks}</time>,
          })
        : t('status.rejected.notYet')
  }

  return (
    // Focus target after submitting the application: the form disappears together with the button just clicked, and this sentence says the result.
    <div
      ref={ref}
      tabIndex={-1}
      className={`mt-4 rounded-md border border-neutral-200 px-4 py-3 dark:border-neutral-800 ${FOCUS_RING}`}
    >
      <p className="font-medium text-neutral-900 dark:text-neutral-100">{title}</p>
      <p className={`mt-1 text-sm ${MUTED}`}>{detail}</p>
      {application.status === 'PENDING' && application.motivation !== null && (
        // Pure React text, never HTML or markdown.
        <p className="mt-3 border-l-2 border-neutral-200 pl-3 text-sm whitespace-pre-wrap text-neutral-700 [overflow-wrap:anywhere] dark:border-neutral-800 dark:text-neutral-300">
          {application.motivation}
        </p>
      )}
    </div>
  )
}

function ApplyForm({ onApplied }: { onApplied: (application: Application | null) => void }) {
  const t = useTranslations('Site.profile.author')
  const id = useId()
  const hintId = `${id}-goi-y`
  const counterId = `${id}-dem`
  const errorId = `${id}-loi`
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SubmitError | null>(null)
  // Block double submission: state only changes on the next render, a ref changes immediately.
  const pending = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    const motivation = text.trim()
    const result = await callBff<unknown>(API, {
      method: 'POST',
      body: JSON.stringify({ motivation: motivation === '' ? null : motivation }),
    })
    pending.current = false
    setBusy(false)
    if (result.ok) onApplied(parseApplication(result.data))
    else setError(submitError(result.code, result.status, t))
  }

  return (
    <form
      noValidate
      // Never a GET: the form appears only after the browser has loaded the person's state, and its box has no `name`.
      method="post"
      onSubmit={(event) => void submit(event)}
      className="mt-2"
    >
      <p className={MUTED}>{t('form.intro')}</p>
      <label htmlFor={id} className="mt-6 block text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {t.rich('form.motivationLabel', {
          optional: (chunks) => <span className="font-normal text-neutral-500">{chunks}</span>,
        })}
      </label>
      <p id={hintId} className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {t('form.hint')}
      </p>
      <textarea
        id={id}
        rows={4}
        value={text}
        maxLength={MOTIVATION_MAX_LENGTH}
        onChange={(event) => setText(event.target.value)}
        readOnly={busy}
        aria-describedby={[hintId, counterId, error !== null ? errorId : null].filter(Boolean).join(' ')}
        className={TEXTAREA}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p id={counterId} className="text-sm text-neutral-500 tabular-nums dark:text-neutral-400">
          {text.length}/{MOTIVATION_MAX_LENGTH}
        </p>
        <button type="submit" aria-disabled={busy || undefined} className={PRIMARY}>
          {busy ? t('form.sending') : t('form.submit')}
        </button>
      </div>
      {error !== null && (
        <div className="mt-2">
          <p id={errorId} role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error.message}
          </p>
          {error.login && (
            <GitHubLoginLink returnTo="/profile" className={`mt-2 inline-flex items-center gap-1.5 text-sm ${INLINE_LINK}`}>
              {t('form.signInAgain')}
            </GitHubLoginLink>
          )}
        </div>
      )}
    </form>
  )
}
