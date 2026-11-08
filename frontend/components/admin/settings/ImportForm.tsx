'use client'

import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import type { SettingsError } from '@/app/admin/(shell)/settings/actions'
import type { ImportResult } from '@/lib/admin-site-content'
import { isRedirectError } from '../redirect-error'
import { ErrorAlert } from '../primitives'
import { FILE_INPUT, HINT, LABEL, STATUS_TEXT, button } from '../ui'
import { ProblemList } from './fields'
import type { Problem } from './json-text'

/** Import of an export document: the file is validated as a whole by the backend, nothing is written unless all of it is valid. */
export default function ImportForm({ onImport }: { onImport: (form: FormData) => Promise<ImportResult | SettingsError> }) {
  const t = useTranslations('Admin.settings.import')
  const tSections = useTranslations('Admin.settings.sections')
  const id = useId()
  const [file, setFile] = useState<File | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [result, setResult] = useState<ImportResult | null>(null)

  async function submit() {
    if (file === null || pending) return
    setPending(true)
    setError(null)
    setProblems([])
    setResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const outcome = await onImport(form)
      if ('error' in outcome) {
        setError(outcome.error)
        setProblems(outcome.problems ?? [])
        return
      }
      setResult(outcome)
    } catch (caught) {
      if (isRedirectError(caught)) return
      console.error('Site content import failed', caught)
      setError(t('unreachable'))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div>
        <label htmlFor={id} className={LABEL}>
          {t('file')}
        </label>
        <input
          id={id}
          type="file"
          accept="application/json,.json"
          aria-describedby={`${id}-hint`}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className={FILE_INPUT}
        />
        <p id={`${id}-hint`} className={HINT}>
          {t('hint')}
        </p>
      </div>
      {error !== null && (
        <div>
          <ErrorAlert>{error}</ErrorAlert>
          <ProblemList problems={problems} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={file === null || pending} className={button('secondary')}>
          {t('submit')}
        </button>
        <p role="status" className={STATUS_TEXT}>
          {pending ? t('importing') : result === null ? '' : t('done')}
        </p>
      </div>
      {result !== null && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          {result.sections.map((section) => (
            <li key={section.key}>{t('sectionResult', { name: tSections(`${section.key}.title`), status: section.status })}</li>
          ))}
        </ul>
      )}
    </form>
  )
}
