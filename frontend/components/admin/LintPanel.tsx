'use client'

import { useTranslations } from 'next-intl'
import { type Ref, useId } from 'react'
import { CheckIcon, CircleAlertIcon } from '@/components/icons'
import type { LintWarning } from '@/lib/post-lint'
import { FOCUS_RING, LABEL } from './ui'

/**
 * "Check before publishing" in the editor's settings column: the warnings of lib/post-lint.ts
 * (same rules as seed/push.py) for the post being edited, recomputed on every keystroke. It blocks nothing: saving and publishing work
 * as before, this is only a list for the writer to review.
 *
 * The heading can receive focus (`tabIndex={-1}`, `headingRef`): the warning-count button on the top bar takes the writer
 * here, even on a phone, where the settings column sits at the bottom of the page.
 */
export default function LintPanel({ warnings, headingRef }: { warnings: LintWarning[]; headingRef?: Ref<HTMLHeadingElement> }) {
  const t = useTranslations('Admin.lint')
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className={`${LABEL} rounded-sm ${FOCUS_RING}`}>
        {t('heading')}
      </h3>
      {warnings.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[13px] leading-5 text-slate-600">
          <CheckIcon size={14} className="shrink-0 text-emerald-600" />
          {t('allClear')}
        </p>
      ) : (
        <>
          <p className="mb-2 text-[13px] leading-5 text-slate-600">{t('summary', { count: warnings.length })}</p>
          <ul className="space-y-1.5">
            {warnings.map((warning, index) => (
              // The order is the order within the post, and the same rule can repeat on many lines: the index is the right key.
              <li
                key={`${warning.rule}-${warning.line ?? 'x'}-${index}`}
                className="flex gap-2 text-[13px] leading-5 text-amber-800"
              >
                <CircleAlertIcon size={14} className="mt-0.5 shrink-0 text-amber-600" />
                <span className="min-w-0 break-words">{warning.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
