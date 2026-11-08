'use client'

import { useTranslations } from 'next-intl'
import { type Ref, useId } from 'react'
import { HINT, INPUT, LABEL } from './ui'

/**
 * The administrator's own code (an authenticator code or a recovery code) for a change that wants a second proof: the backend checks
 * it before it writes anything, and also wants a sign-in from the last ten minutes (a refusal for that reason arrives as the sentence
 * of the panel's error). It is the same field the reset of an author's two-step verification asks for.
 */
export function StepUpCodeField({
  value,
  onChange,
  readOnly,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  inputRef?: Ref<HTMLInputElement>
}) {
  const t = useTranslations('Admin.stepUp')
  const id = useId()
  return (
    <div>
      <label htmlFor={`${id}-code`} className={LABEL}>
        {t('codeLabel')}
      </label>
      <input
        ref={inputRef}
        id={`${id}-code`}
        name="code"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={40}
        aria-describedby={`${id}-hint`}
        className={`${INPUT} sm:max-w-xs`}
      />
      <p id={`${id}-hint`} className={HINT}>
        {t('codeHint')}
      </p>
    </div>
  )
}
