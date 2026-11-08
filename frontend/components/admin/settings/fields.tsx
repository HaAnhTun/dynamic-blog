'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { SectionSaved, SettingsError } from '@/app/admin/(shell)/settings/actions'
import { isRedirectError } from '../redirect-error'
import { ErrorAlert } from '../primitives'
import { HINT, INPUT, INPUT_MONO, LABEL, STATUS_TEXT, button } from '../ui'
import type { Problem } from './json-text'

/** What a section editor calls to save: the page binds the key and the locale into it. */
export type SaveSection = (payload: unknown) => Promise<SectionSaved | SettingsError>

export type SaveState = {
  pending: boolean
  error: string | null
  problems: Problem[]
  notice: string
  run: (payload: unknown) => Promise<boolean>
}

/**
 * The submit cycle shared by every editor: a pending guard, the error or the refused-content problems in place, a saved notice.
 * Catches rejected promises too (an action that throws reaches no error boundary); a redirect error is the router leaving for
 * the login page, not something to show.
 */
export function useSave(onSave: SaveSection): SaveState {
  const t = useTranslations('Admin.settings')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [notice, setNotice] = useState('')

  async function run(payload: unknown): Promise<boolean> {
    if (pending) return false
    setPending(true)
    setError(null)
    setProblems([])
    setNotice('')
    try {
      const result = await onSave(payload)
      if ('error' in result) {
        setError(result.error)
        setProblems(result.problems ?? [])
        return false
      }
      setNotice(t('saved'))
      return true
    } catch (caught) {
      if (isRedirectError(caught)) return false
      console.error('Site content save failed', caught)
      setError(t('errors.unreachable'))
      return false
    } finally {
      setPending(false)
    }
  }
  return { pending, error, problems, notice, run }
}

export function ProblemList({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return null
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-800">
      {problems.map((problem, index) => (
        <li key={index}>
          {problem.pointer !== null && <code className="font-mono text-[13px]">{problem.pointer || '/'}</code>}
          {problem.pointer !== null && ' '}
          {problem.reason}
        </li>
      ))}
    </ul>
  )
}

/** The error, the problem list, the submit button and the saved notice (a live region that exists before its text does). */
export function SaveBar({ state, disabled = false }: { state: SaveState; disabled?: boolean }) {
  const t = useTranslations('Admin.settings')
  return (
    <div className="space-y-3">
      {state.error !== null && (
        <div>
          <ErrorAlert>{state.error}</ErrorAlert>
          <ProblemList problems={state.problems} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="submit" disabled={state.pending || disabled} className={button('primary')}>
          {t('save')}
        </button>
        <p role="status" className={STATUS_TEXT}>
          {state.notice}
        </p>
      </div>
    </div>
  )
}

type FieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: ReactNode
  maxLength?: number
  required?: boolean
  mono?: boolean
  /** Rows of a multi-line box; a single-line input when absent. */
  rows?: number
  type?: 'text' | 'email' | 'url'
}

export function TextField({ label, value, onChange, hint, maxLength, required, mono, rows, type = 'text' }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const common = {
    id,
    value,
    maxLength,
    required,
    spellCheck: mono ? false : undefined,
    'aria-describedby': hint === undefined ? undefined : hintId,
    className: mono ? INPUT_MONO : INPUT,
  }
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {rows === undefined ? (
        <input {...common} type={type} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <textarea {...common} rows={rows} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint !== undefined && (
        <p id={hintId} className={HINT}>
          {hint}
        </p>
      )}
    </div>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={INPUT}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** A value for the payload: the backend refuses control characters (line breaks included) and surrounding whitespace. */
export const clean = (value: string): string => value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
/** An empty box means "not set" for the nullable fields. */
export const orNull = (value: string): string | null => (clean(value) === '' ? null : clean(value))

/** Rows with a stable key: the rows of a repeatable list can be removed from the middle, an index would mix up their boxes. */
export type Row<T> = { uid: number; value: T }
let nextUid = 1
export const toRows = <T,>(values: T[]): Row<T>[] => values.map((value) => ({ uid: nextUid++, value }))
export const newRow = <T,>(value: T): Row<T> => ({ uid: nextUid++, value })

/** A paragraph list in one box: one paragraph per line (a paragraph cannot contain a line break). */
export const joinParagraphs = (paragraphs: string[]): string => paragraphs.join('\n')
export const splitParagraphs = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')

/**
 * A repeatable list: heading, the rows, an add button. When a row is removed, focus moves to the add button: the remove button that
 * held it left the page with its row.
 */
export function RepeatableSection({
  heading,
  count,
  max,
  addLabel,
  onAdd,
  children,
}: {
  heading: string
  count: number
  max: number
  addLabel: string
  onAdd: () => void
  children: ReactNode
}) {
  const t = useTranslations('Admin.settings')
  const id = useId()
  const addButton = useRef<HTMLButtonElement>(null)
  const previous = useRef(count)
  useEffect(() => {
    if (count < previous.current) addButton.current?.focus()
    previous.current = count
  }, [count])
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className={LABEL}>
        {heading}
      </h3>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button ref={addButton} type="button" onClick={onAdd} disabled={count >= max} className={button('secondary')}>
          {addLabel}
        </button>
        {count >= max && <p className={STATUS_TEXT}>{t('listFull', { max })}</p>}
      </div>
    </section>
  )
}

export function RowFrame({ title, onRemove, children }: { title: string; onRemove: () => void; children: ReactNode }) {
  const t = useTranslations('Admin.settings')
  return (
    <div className="space-y-4 rounded-md border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-slate-900">{title}</h4>
        <button type="button" onClick={onRemove} aria-label={t('removeAria', { title })} className={button('danger', 'sm')}>
          {t('remove')}
        </button>
      </div>
      {children}
    </div>
  )
}
