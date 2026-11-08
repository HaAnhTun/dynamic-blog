'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { POST_IMPORT_LIMIT_VALUES } from '@/lib/post-import'
import { FOCUS_RING, HINT, META, button } from '../../ui'

/**
 * Chooses several files by click, keyboard or drag and drop (the multiple-file sibling of the profile import's FileDrop). The
 * native input stays in the page (visually hidden, focusable) and its label is the drop zone, so a keyboard or screen reader user
 * gets the same control as a pointer user. A new choice replaces the old one. Only the files are reported: what is acceptable is
 * decided by the parent and the server.
 */
export default function FilesDrop({
  files,
  onFiles,
  onRemove,
  disabled,
  errorId,
}: {
  files: readonly File[]
  onFiles: (files: File[]) => void
  onRemove: () => void
  disabled: boolean
  /** The id of the alert that shows a refusal of the files: the input is described by it while it exists. */
  errorId?: string
}) {
  const t = useTranslations('Admin.posts.import.files')
  const format = useFormatter()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const replace = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)
  const had = useRef(files.length > 0)

  useEffect(() => {
    const before = had.current
    had.current = files.length > 0
    if (!before && files.length > 0) replace.current?.focus()
    else if (before && files.length === 0) input.current?.focus()
  }, [files.length])

  const take = (list: FileList | null) => {
    const chosen = list === null ? [] : Array.from(list)
    if (chosen.length > 0 && !disabled) onFiles(chosen)
  }

  return (
    <div>
      <input
        ref={input}
        id={id}
        type="file"
        multiple
        accept=".md,.zip,text/markdown,application/zip,application/x-zip-compressed"
        disabled={disabled}
        // The drop label names the input while it is shown (WCAG 2.5.3: the accessible name contains the visible text); once files
        // are chosen there is no label left, so the name comes from here.
        aria-label={files.length === 0 ? undefined : t('inputLabel')}
        aria-describedby={errorId === undefined ? `${id}-hint` : `${id}-hint ${errorId}`}
        className="peer sr-only"
        onChange={(event) => {
          take(event.target.files)
          // The same files can be chosen again after a change on disk.
          event.target.value = ''
        }}
      />
      {files.length === 0 ? (
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
          <span className="mt-1 text-[13px] text-slate-500">{t('dropHint', POST_IMPORT_LIMIT_VALUES)}</span>
        </label>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
          <ul aria-label={t('listLabel')} className="space-y-1">
            {files.map((file, index) => (
              <li key={`${index}:${file.name}`} className="min-w-0 break-words text-sm text-slate-900">
                <span className="font-medium break-all">{file.name}</span>{' '}
                <span className={META}>{t('size', { kib: format.number(file.size / 1024, { maximumFractionDigits: 1 }) })}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={replace}
              type="button"
              disabled={disabled}
              onClick={() => input.current?.click()}
              className={button('secondary', 'sm')}
            >
              {t('choose')}
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
