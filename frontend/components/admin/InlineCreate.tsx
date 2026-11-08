'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { PlusIcon } from '@/components/icons'
import { button, INPUT } from './ui'

/**
 * A disclosure plus one text field. Deliberately NOT a nested <form>: a submit button here
 * would submit the post instead of creating the category. Hence type="button" and an
 * explicit handler.
 *
 * The input is not attached to the post form (no `form=`, not inside any <form> — see PostEditor), so
 * Enter here no longer submits the whole post as before; it does what this box is for, which is add, and Escape is
 * cancel. Opening focuses the box; closing returns focus to the open button, so the keyboard does not fall back to <body>.
 */
export default function InlineCreate({
  label,
  fieldLabel,
  onCreate,
}: {
  label: string
  fieldLabel: string
  onCreate: (name: string) => Promise<void>
}) {
  const t = useTranslations('Admin.editor.inlineCreate')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  // Only restore focus after it has been opened at least once, not when the page has just loaded.
  const opened = useRef(false)
  const inputId = `inline-${fieldLabel.replace(/\s+/g, '-').toLowerCase()}`

  useEffect(() => {
    if (open) {
      opened.current = true
      input.current?.focus()
    } else if (opened.current) {
      opener.current?.focus()
    }
  }, [open])

  async function create() {
    const trimmed = name.trim()
    if (pending || trimmed === '') return
    setPending(true)
    try {
      await onCreate(trimmed)
      setName('')
      setOpen(false)
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <button ref={opener} type="button" onClick={() => setOpen(true)} className={button('ghost', 'sm', 'mt-2 -ml-2 px-2')}>
        <PlusIcon size={14} />
        {label}
      </button>
    )
  }

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
      <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-slate-700">
        {fieldLabel}
      </label>
      <input
        ref={input}
        id={inputId}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void create()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          }
        }}
        className={`${INPUT} h-9`}
      />
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={pending || name.trim() === ''}
          onClick={() => void create()}
          className={button('secondary', 'sm')}
        >
          {t('add')}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={button('ghost', 'sm')}>
          {t('cancel')}
        </button>
      </div>
    </div>
  )
}
