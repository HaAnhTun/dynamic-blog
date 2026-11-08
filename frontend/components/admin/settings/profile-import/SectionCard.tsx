'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useId } from 'react'
import type { ImportProblem, PreviewChange, PreviewSection, SectionStatus } from '@/lib/admin-site-import'
import { ToneBadge } from '../../primitives'
import { CHECKBOX, META } from '../../ui'
import { problemText } from './problem'

const TONE: Record<SectionStatus, string> = {
  new: 'text-emerald-700',
  will_change: 'text-amber-700',
  unchanged: 'text-slate-500',
  error: 'text-red-700',
  missing: 'text-slate-500',
}

function Change({ change }: { change: PreviewChange }) {
  const t = useTranslations('Admin.settings.profileImport.preview')
  if (change.kind === 'list') {
    return (
      <li className="break-words">
        <code className="font-mono text-[13px]">{change.field}</code>{' '}
        {t('listCounts', { added: change.added ?? 0, removed: change.removed ?? 0, kept: change.kept ?? 0 })}
      </li>
    )
  }
  return (
    <li className="break-words">
      <code className="font-mono text-[13px]">{change.field}</code>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[13px]">
        <dt className="text-slate-500">{t('before')}</dt>
        <dd className="break-words text-slate-700">{change.before ?? t('none')}</dd>
        <dt className="text-slate-500">{t('after')}</dt>
        <dd className="break-words font-medium text-slate-900">{change.after ?? t('none')}</dd>
      </dl>
    </li>
  )
}

/** One section of the preview: status, what changes, what is missing and what is wrong, and the choice to write it. */
export default function SectionCard({
  section,
  checked,
  onToggle,
  disabled,
}: {
  section: PreviewSection
  checked: boolean
  onToggle: (id: string) => void
  disabled: boolean
}) {
  const t = useTranslations('Admin.settings.profileImport.preview')
  const format = useFormatter()
  const id = useId()
  const problems: ImportProblem[] = section.errors

  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-3">
          {section.present && (
            <input
              type="checkbox"
              id={`${id}-check`}
              className={`${CHECKBOX} mt-1`}
              checked={checked}
              disabled={disabled || !section.selectable || section.status === 'unchanged'}
              aria-describedby={`${id}-status`}
              onChange={() => onToggle(section.id)}
            />
          )}
          <div className="min-w-0">
            <label
              id={`${id}-heading`}
              htmlFor={section.present ? `${id}-check` : undefined}
              className="break-words text-[15px] font-medium text-slate-900"
            >
              {section.heading}
            </label>
            {section.line !== null && <p className={META}>{t('line', { line: section.line })}</p>}
          </div>
        </div>
        <span id={`${id}-status`}>
          <ToneBadge label={t(`status.${section.status}`)} tone={TONE[section.status]} />
        </span>
      </div>

      {problems.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-800">
          {problems.map((problem, index) => (
            <li key={index} className="break-words">
              {problemText(problem, section.heading, t)}
            </li>
          ))}
        </ul>
      )}

      {section.changes.length > 0 && (
        <div className="mt-3">
          <p className="text-[13px] font-medium text-slate-700">{t('changes')}</p>
          <ul className="mt-1 space-y-2 text-sm text-slate-800">
            {section.changes.map((change) => (
              <Change key={`${change.kind}:${change.field}`} change={change} />
            ))}
          </ul>
        </div>
      )}

      {section.present && section.missingOptional.length > 0 && (
        <p className={`mt-3 break-words ${META}`}>{t('missingOptional', { fields: format.list(section.missingOptional) })}</p>
      )}
    </li>
  )
}
