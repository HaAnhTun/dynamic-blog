'use client'

import { useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'
import { copyToClipboard, groupsOfFour, type EnrollmentSecret } from '@/lib/mfa-client'
import { button, LABEL, STATUS_TEXT } from '../ui'

/**
 * The new authenticator secret, as text: the base32 key in groups of four, a Copy button (the clipboard, or, where the browser has
 * none, the text selected for Ctrl+C), and the `otpauth://` link that a phone opens in its authenticator app. There is no QR image
 * (no library): the owner's decision, and the key works in every app.
 *
 * The secret exists only in this component's props: the host drops it from state when the recovery codes appear, and nothing
 * writes it to storage or to the URL.
 */
export default function SecretKey({ secret }: { secret: EnrollmentSecret }) {
  const t = useTranslations('Admin.login.enroll')
  const nameId = useId()
  const key = useRef<HTMLElement>(null)
  const [status, setStatus] = useState<'idle' | 'copied' | 'selected'>('idle')

  async function copy() {
    if (await copyToClipboard(secret.secretBase32)) {
      setStatus('copied')
      return
    }
    // No clipboard here (an insecure origin, an old browser): select the key so that the person can copy it by hand.
    const node = key.current
    if (node !== null) {
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    setStatus('selected')
  }

  // Only an `otpauth:` link is ever rendered as a link, whatever the response said.
  const appLink = secret.otpauthUri.startsWith('otpauth://') ? secret.otpauthUri : null

  return (
    <div>
      <p className="text-sm leading-6 text-slate-600">{t('step2')}</p>
      <div role="group" aria-labelledby={nameId} className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
        <p id={nameId} className={`${LABEL} !mb-1`}>
          {t('secret')}
        </p>
        <code ref={key} translate="no" className="block font-mono text-base tracking-wider break-all text-slate-900 select-all">
          {groupsOfFour(secret.secretBase32)}
        </code>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button('secondary', 'sm')} onClick={copy}>
          {status === 'copied' ? t('copied') : t('copy')}
        </button>
        {appLink !== null && (
          <a href={appLink} className={button('secondary', 'sm')}>
            {t('openApp')}
          </a>
        )}
      </div>
      <p role="status" aria-live="polite" className={`mt-2 min-h-6 ${STATUS_TEXT}`}>
        {status === 'copied' ? t('copied') : status === 'selected' ? t('copySelected') : ''}
      </p>
    </div>
  )
}
