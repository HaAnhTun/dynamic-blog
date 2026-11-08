'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
import { CheckIcon } from '@/components/icons'

/**
 * Feedback after deleting a post: the delete action redirects to the list with `?deleted=1`.
 *
 * The sentence is fixed and carries nothing from the URL: the query string is not proof that a post was deleted (anyone can put it in a
 * link), so the title of the post is not repeated here and no other value of `deleted` is read. The page decides whether to render this.
 *
 * Takes focus when it appears. The list page is rebuilt from scratch, so a `role="status"` that
 * already has text at paint time is not announced by screen readers, and the focus of the
 * "Delete permanently" button is lost with the old page (it falls back to <body>). Focusing the notice
 * makes it read aloud, and Tab continues from the top of the page content.
 */
export function DeletedNotice() {
  const t = useTranslations('Admin.shell')
  const notice = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    notice.current?.focus()
  }, [])

  return (
    <p
      ref={notice}
      role="status"
      tabIndex={-1}
      className="mb-6 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm leading-6 text-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
    >
      <CheckIcon className="mt-1 text-emerald-600" />
      <span className="min-w-0">{t('postDeleted')}</span>
    </p>
  )
}
