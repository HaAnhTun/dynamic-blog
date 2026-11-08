'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { copyToClipboard, downloadTextFile, recoveryCodesFile, RECOVERY_CODES_FILE } from '@/lib/mfa-client'
import { button, FOCUS_RING, H2, SECTION_DESC, STATUS_TEXT } from '../ui'

/**
 * The ten recovery codes of an enrollment, a replacement or a regeneration: shown ONCE (the backend answers them only in that
 * response and keeps a hash), so the way out is gated. Download or copy them, tick "I stored these codes somewhere safe", and only
 * then the Continue button works.
 *
 * Nothing here persists the codes: no storage, no URL. The download is a Blob handed to the browser, named without any account
 * identifier. Focus moves to the heading when the step appears.
 */
export default function RecoveryCodes({
  codes,
  doneLabel,
  onDone,
}: {
  codes: readonly string[]
  /** The label of the button that leaves the step (it is the host's choice: "Continue to the admin area", "Done"). */
  doneLabel: string
  onDone: () => void
}) {
  const t = useTranslations('Admin.login.enroll')
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1} className={`${H2} rounded-sm ${FOCUS_RING}`}>
        {t('recoveryTitle')}
      </h2>
      <p className={SECTION_DESC}>{t('recoveryLead')}</p>
      <ul
        aria-label={t('recoveryList')}
        translate="no"
        className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-[13px] text-slate-900 sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button('secondary', 'sm')}
          onClick={() => downloadTextFile(RECOVERY_CODES_FILE, recoveryCodesFile(codes))}
        >
          {t('download')}
        </button>
        <button
          type="button"
          className={button('secondary', 'sm')}
          onClick={async () => setCopied(await copyToClipboard(recoveryCodesFile(codes)))}
        >
          {t('copyCodes')}
        </button>
      </div>
      <p role="status" aria-live="polite" className={`mt-2 min-h-6 ${STATUS_TEXT}`}>
        {copied ? t('copied') : ''}
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-slate-300 accent-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
        />
        <span>{t('saved')}</span>
      </label>
      <button type="button" disabled={!saved} onClick={onDone} className={button('primary', 'md', 'mt-4 w-full min-h-10')}>
        {doneLabel}
      </button>
    </section>
  )
}
