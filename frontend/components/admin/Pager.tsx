import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { button, META } from './ui'

/**
 * Pagination of an admin list: "21–40 of 45 comments · page 2/3", then previous page /
 * next page. Extracted from the post list so Posts, Comments and Users say the
 * same sentence. A list that fits one page draws nothing.
 *
 * Plain links (GET) rather than buttons: every page has a pasteable URL, and Back returns to exactly the previous page.
 * `href` builds the URL of page `n` and must keep every active filter. No directive: only used in a
 * Server Component, so it can receive a function as a prop.
 */
export function Pager({
  page,
  totalPages,
  total,
  pageSize,
  unit,
  href,
}: {
  /** The page being viewed, from 0. */
  page: number
  totalPages: number
  /** Item count of the whole filtered list, not just this page. */
  total: number
  pageSize: number
  /** The unit counted after the number. */
  unit: 'post' | 'comment' | 'user' | 'application'
  href: (page: number) => string
}) {
  const t = useTranslations('Admin.common.pager')
  if (totalPages <= 1) return null
  const from = page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)
  return (
    <nav aria-label={t('label')} className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <p className={META}>{t('summary', { from, to, total, unit, page: page + 1, totalPages })}</p>
      <div className="flex gap-2">
        {page > 0 ? (
          <Link href={href(page - 1)} className={button('secondary', 'sm')}>
            {t('previous')}
          </Link>
        ) : null}
        {page < totalPages - 1 ? (
          <Link href={href(page + 1)} className={button('secondary', 'sm')}>
            {t('next')}
          </Link>
        ) : null}
      </div>
    </nav>
  )
}
