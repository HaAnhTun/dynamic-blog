'use client'

import { useTranslations } from 'next-intl'
import { useId, useRef, useState } from 'react'
import { ErrorAlert } from '../primitives'
import { HINT, INPUT_MONO, LABEL, STATUS_TEXT, button } from '../ui'
import { SaveBar, useSave, type SaveSection } from './fields'
import { pointerToLine, syntaxErrorLocation } from './json-text'

type Located = { line: number | null; reason: string }

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * A validated JSON editor for the keys that have no dedicated form yet. Syntax errors are caught here with their line and column.
 * The text is pretty-printed before it is sent, so the line a server problem (`/entries/2/url: ...`) maps to is the line shown.
 */
export default function JsonEditor({ value, onSave }: { value: unknown; onSave: SaveSection }) {
  const t = useTranslations('Admin.settings.json')
  const id = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(() => pretty(value))
  const [syntax, setSyntax] = useState<string | null>(null)
  const [located, setLocated] = useState<Located[]>([])
  // The text the server saw: lines are mapped against it, not against whatever has been typed since.
  const sent = useRef('')
  const save = useSave(async (payload) => {
    const result = await onSave(payload)
    if ('error' in result && result.problems !== undefined) {
      setLocated(
        result.problems.map((p) => ({
          line: p.pointer === null ? null : pointerToLine(sent.current, p.pointer),
          reason: p.reason,
        })),
      )
    }
    return result
  })

  /** The parsed object, or null after showing why not. */
  function parse(): Record<string, unknown> | null {
    setSyntax(null)
    setLocated([])
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const where = syntaxErrorLocation(text, error)
      setSyntax(where === null ? t('syntaxNoPosition') : t('syntax', where))
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setSyntax(t('notObject'))
      return null
    }
    return parsed as Record<string, unknown>
  }

  function format() {
    const parsed = parse()
    if (parsed !== null) setText(pretty(parsed))
  }

  function goTo(line: number) {
    const area = box.current
    if (area === null) return
    const lines = text.split('\n')
    const start = lines.slice(0, line - 1).reduce((sum, current) => sum + current.length + 1, 0)
    area.focus()
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
  }

  const textId = `${id}-text`
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        const parsed = parse()
        if (parsed === null) return
        const formatted = pretty(parsed)
        setText(formatted)
        sent.current = formatted
        void save.run(parsed)
      }}
    >
      <div>
        <label htmlFor={textId} className={LABEL}>
          {t('label')}
        </label>
        <textarea
          ref={box}
          id={textId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={24}
          spellCheck={false}
          aria-describedby={`${textId}-hint`}
          aria-invalid={syntax !== null}
          className={INPUT_MONO}
        />
        <p id={`${textId}-hint`} className={HINT}>
          {t('hint')}
        </p>
      </div>

      {syntax !== null && <ErrorAlert>{syntax}</ErrorAlert>}
      {located.length > 0 && (
        <ul className="space-y-1 text-sm text-red-800">
          {located.map((problem, index) => (
            <li key={index}>
              {problem.line !== null ? (
                <button
                  type="button"
                  onClick={() => goTo(problem.line!)}
                  className="underline outline-brand focus-visible:outline-2"
                >
                  {t('line', { line: problem.line })}
                </button>
              ) : null}
              {problem.line !== null && ' '}
              {problem.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={format} className={button('secondary')}>
          {t('format')}
        </button>
        <p className={STATUS_TEXT}>{t('formatHint')}</p>
      </div>
      <SaveBar state={{ ...save, problems: [] }} />
    </form>
  )
}
