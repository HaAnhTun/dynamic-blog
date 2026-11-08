import Link from 'next/link'
import { redirect } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import AdminOnly from '@/components/admin/AdminOnly'
import { EmptyState, ErrorAlert, PageHeader } from '@/components/admin/primitives'
import { button, META, PAGE } from '@/components/admin/ui'
import { MailIcon } from '@/components/icons'
import { adminErrorMessage } from '@/lib/admin-action'
import { SessionExpiredError, getContactUnreadCount, listContactMessages } from '@/lib/admin-api'
import { adminRole } from '@/lib/admin-role'
import { ApiError } from '@/lib/api'
import type { ContactMessage, Page } from '@/lib/types'
import { markContactRead, removeContactMessage } from './actions'
import ContactInbox from './ContactInbox'
import { CONTACT_PAGE_SIZE, contactListHref, parsePage } from './contact-list'

/*
 * The Contact inbox, ADMIN only: the messages visitors sent through the contact form, newest first, with the number still unread.
 * Mark as read and delete on each message (ContactInbox). No filter or search: a personal blog gets a handful of messages.
 */

/** "21–40 of 45 messages · page 2/3" and the previous/next links; nothing when everything fits one page. */
function Pager({ page, totalPages, total }: { page: number; totalPages: number; total: number }) {
  const t = useTranslations('Admin.contact.pager')
  if (totalPages <= 1) return null
  const from = page * CONTACT_PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * CONTACT_PAGE_SIZE)
  return (
    <nav aria-label={t('label')} className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <p className={META}>{t('summary', { from, to, total, page: page + 1, totalPages })}</p>
      <div className="flex gap-2">
        {page > 0 && (
          <Link href={contactListHref(page - 1)} className={button('secondary', 'sm')}>
            {t('previous')}
          </Link>
        )}
        {page < totalPages - 1 && (
          <Link href={contactListHref(page + 1)} className={button('secondary', 'sm')}>
            {t('next')}
          </Link>
        )}
      </div>
    </nav>
  )
}

export default async function AdminContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('Admin.contact')
  // Before any backend call: AUTHOR (or a stray token) sees the "admin only" page, nothing else.
  if ((await adminRole()) !== 'ADMIN') return <AdminOnly title={t('title')} />
  const requested = parsePage((await searchParams).page)

  let result: Page<ContactMessage> | null = null
  let unread = 0
  let loadError: string | null = null
  try {
    ;[result, unread] = await Promise.all([listContactMessages(requested, CONTACT_PAGE_SIZE), getContactUnreadCount()])
  } catch (error) {
    // Expired session: to login. 403: the account is no longer ADMIN. Another 4xx: a local message. Anything else: error.tsx.
    if (error instanceof SessionExpiredError) redirect('/admin/login')
    if (error instanceof ApiError && error.status === 403) return <AdminOnly title={t('title')} />
    if (error instanceof ApiError && error.status < 500)
      loadError = adminErrorMessage(error, await getTranslations('Errors.admin'))
    else throw error
  }

  // `?page=` beyond the last page (the inbox just got shorter, or an old URL): go to the last page instead of an empty one.
  // Outside the try: redirect() throws NEXT_REDIRECT, and the catch above would swallow it.
  if (result !== null && result.items.length === 0 && result.meta.totalPages > 0 && requested >= result.meta.totalPages) {
    redirect(contactListHref(result.meta.totalPages - 1))
  }

  return (
    <div className={PAGE}>
      <PageHeader
        title={t('title')}
        description={t.rich('description', { code: (chunks) => <code className="font-mono text-[13px]">{chunks}</code> })}
      />

      {result === null ? (
        <ErrorAlert>{loadError}</ErrorAlert>
      ) : (
        <>
          <h2 className="mb-3 text-sm font-medium text-slate-900">
            {/* A space between the two parts: the accessible name concatenates the children text. */}
            {t('count', { count: result.meta.totalElements })}{' '}
            <span className="ml-1 font-normal text-slate-500">{t('unreadCount', { count: unread })}</span>
          </h2>
          {result.items.length === 0 ? (
            <EmptyState icon={<MailIcon size={20} />} title={t('empty.title')}>
              {t('empty.hint')}
            </EmptyState>
          ) : (
            <ContactInbox
              // A different page is a different list: rebuild with the new data, instead of keeping the state of the old one.
              key={contactListHref(result.meta.page)}
              messages={result.items}
              onMarkRead={markContactRead}
              onDelete={removeContactMessage}
            />
          )}
          <Pager page={result.meta.page} totalPages={result.meta.totalPages} total={result.meta.totalElements} />
        </>
      )}
    </div>
  )
}
