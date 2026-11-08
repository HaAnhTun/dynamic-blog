'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { FOCUS_RING, HINT, button } from '../../ui'

/**
 * Chooses one file by click, keyboard or drag and drop. The native input stays in the page (visually hidden, focusable) and its
 * label is the drop zone, so a keyboard or screen reader user gets the same control as a pointer user. Only the file is
 * reported: what is acceptable is decided by the parent and the server.
 */
export default function FileDrop({
  file,
  onFile,
  onRemove,
  disabled,
  accept,
  errorId,
}: {
  file: File | null
  onFile: (file: File) => void
  onRemove: () => void
  disabled: boolean
  accept: string
  /** The id of the alert that shows a refusal of the file: the input is described by it while it exists. */
  errorId?: string
}) {
  const t = useTranslations('Admin.settings.profileImport.file')
  const format = useFormatter()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const replace = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)
  const had = useRef(file !== null)

  useEffect(() => {
    const before = had.current
    had.current = file !== null
    if (!before && file !== null) replace.current?.focus()
    else if (before && file === null) input.current?.focus()
  }, [file])

  const take = (list: FileList | null) => {
    const first = list?.[0]
    if (first !== undefined && !disabled) onFile(first)
  }

  return (
    <div>
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        // The drop label names the input while it is shown (WCAG 2.5.3: the accessible name contains the visible text); once a
        // file is chosen there is no label left, so the name comes from here.
        aria-label={file === null ? undefined : t('inputLabel')}
        aria-describedby={errorId === undefined ? `${id}-hint` : `${id}-hint ${errorId}`}
        className="peer sr-only"
        onChange={(event) => {
          take(event.target.files)
          // The same file can be chosen again after a change on disk.
          event.target.value = ''
        }}
      />
      {file === null ? (
        <label
          htmlFor={id}
          onDragOver={(event) => {
            event.preventDefault()
            if (!disabled) setDragging(true)
          }}
          onDragLeave={(event) => {
            // Moving over a child of the label also fires dragleave on the label: only leaving the label itself clears the highlight.
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
            setDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            take(event.dataTransfer.files)
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 outline-brand ${
            dragging ? 'border-slate-500 bg-slate-100' : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'
          } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <span className="text-sm font-medium text-slate-900">{t('dropTitle')}</span>
          <span className="mt-1 text-[13px] text-slate-500">{t('dropHint')}</span>
        </label>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <p className="min-w-0 break-words text-sm text-slate-900">
            <span className="font-medium break-all">{file.name}</span>{' '}
            <span className="text-slate-500">
              {t('size', { kib: format.number(file.size / 1024, { maximumFractionDigits: 1 }) })}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              ref={replace}
              type="button"
              disabled={disabled}
              onClick={() => input.current?.click()}
              className={button('secondary', 'sm')}
            >
              {t('replace')}
            </button>
            <button type="button" disabled={disabled} onClick={onRemove} className={`${button('ghost', 'sm')} ${FOCUS_RING}`}>
              {t('remove')}
            </button>
          </div>
        </div>
      )}
      <p id={`${id}-hint`} className={HINT}>
        {t('hint')}
      </p>
    </div>
  )
}
