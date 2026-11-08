import { useTranslations } from 'next-intl'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChevronLeftIcon, CircleAlertIcon } from '@/components/icons'
import { BACK_LINK, H1, LEAD, postStatusLabel, postStatusTone } from './ui'

/*
 * Prebuilt admin blocks, shared by every screen. No
 * directive: usable in both Server Components and Client Components (the only hook is next-intl's `useTranslations`,
 * which works in both).
 */

/**
 * Page header: back link (if any), h1 title, description sentence, and a place for the primary button on the right. On a
 * phone the button drops below the title. The DOM order is the reading order: back, title, description, action.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  back?: { href: string; label: string }
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back !== undefined && (
          <Link href={back.href} className={`${BACK_LINK} mb-3`}>
            <ChevronLeftIcon />
            {back.label}
          </Link>
        )}
        <h1 className={H1}>{title}</h1>
        {description !== undefined && <p className={LEAD}>{description}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Empty state: what is empty (the title), why that matters and what to do next (the
 * explanatory sentence), then the action if there is one.
 *
 * `focusTarget`: the title carries `data-empty-list` and `tabIndex={-1}`, the focus target of
 * useFocusAfterRemoval when the last row of the list was just removed.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  focusTarget = false,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
  focusTarget?: boolean
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      {icon !== undefined && (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">{icon}</span>
      )}
      <p
        className="rounded-sm text-sm font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 outline-brand"
        {...(focusTarget ? { 'data-empty-list': true, tabIndex: -1 } : {})}
      >
        {title}
      </p>
      {children !== undefined && <p className="mt-1 max-w-md text-sm leading-6 text-slate-600">{children}</p>}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  )
}

/**
 * An in-place error, right next to the operation that just failed (`role="alert"`, announced at once). The icon has no text,
 * so the `textContent` of the frame is exactly the error sentence: the editor tests match it verbatim.
 */
export function ErrorAlert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={`flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-6 text-red-800 ${className ?? ''}`}
    >
      <CircleAlertIcon className="mt-1 text-red-600" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/**
 * One status: a colored dot and text. Color is never the only information, the text is always there.
 * No border, no background: a list of twenty posts with twenty colored pills is noise.
 * `tone` is a text color class (`text-…`), taken from ui.ts (posts) or statuses.ts (comments, accounts).
 */
export function ToneBadge({ label, tone, className }: { label: string; tone: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium ${tone} ${className ?? ''}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </span>
  )
}

/** Post status. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const t = useTranslations('Admin.statuses')
  return <ToneBadge label={postStatusLabel(status, t)} tone={postStatusTone(status)} className={className} />
}
