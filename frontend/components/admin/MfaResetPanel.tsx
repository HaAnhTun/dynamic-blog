'use client'

import { useTranslations } from 'next-intl'
import { type Ref, useEffect, useId, useRef, useState } from 'react'
import { ErrorAlert } from './primitives'
import { button, INPUT, LABEL } from './ui'

/**
 * The confirmation step under a UserTable row that resets the two-step verification of an AUTHOR who lost the device and the recovery
 * codes: it says what is removed, and asks for the CALLER's own code (an authenticator code or a recovery code), because the backend
 * wants the administrator's second factor before it takes someone else's away. The administrator also needs a sign-in within the last
 * ten minutes; a refusal for that reason arrives as the sentence in `error`. An administrator's own enrollment is never reset here:
 * that is the server owner's job (docs/SECURITY.md), and the backend refuses it anyway.
 */
export function MfaResetPanel({
  ref,
  handle,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  /** The outermost frame: the row asks it whether focus is still inside (focusStayedIn). */
  ref?: Ref<HTMLDivElement>
  /** "@login", or the display name when there is none: how the table refers to this person. */
  handle: string
  pending: boolean
  error: string | null
  onConfirm: (code: string) => void
  onCancel: () => void
}) {
  const t = useTranslations('Admin.users.table')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState('')

  // The code is the one thing to do here: focus goes to it.
  useEffect(() => {
    input.current?.focus()
  }, [])

  const promptId = `${id}-prompt`
  const inputId = `${id}-code`
  const ready = code.trim() !== ''

  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onCancel()
      }}
      className="rounded-lg border border-red-200 bg-red-50/60 p-4"
    >
      <p id={promptId} className="text-[13px] leading-5 text-red-900">
        {t.rich('resetMfaConfirm', {
          handle,
          strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
          bdi: (chunks) => <bdi>{chunks}</bdi>,
        })}
      </p>
      <div className="mt-3 max-w-xs">
        <label htmlFor={inputId} className={LABEL}>
          {t('resetMfaCode')}
        </label>
        <input
          ref={input}
          id={inputId}
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={40}
          className={INPUT}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          aria-disabled={pending || !ready || undefined}
          onClick={() => {
            if (ready && !pending) onConfirm(code.trim())
          }}
          className={button('dangerSolid', 'sm', 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60')}
        >
          {pending ? t('resetMfaWorking') : t('resetMfaSubmit')}
        </button>
        <button
          type="button"
          aria-disabled={pending || undefined}
          onClick={onCancel}
          className={button('secondary', 'sm', 'aria-disabled:cursor-wait aria-disabled:opacity-60')}
        >
          {t('cancel')}
        </button>
      </div>
      {error !== null && <ErrorAlert className="mt-3">{error}</ErrorAlert>}
    </div>
  )
}
