import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { PageMeta } from '@/lib/types'
import { FOCUS, TAP_TARGET, TRANSITION } from './site/SectionHeading'

/**
 * The two paging links: text-sm text is only ~20px tall, so the tap target is enlarged with TAP_TARGET (a transparent
 * ::after, the text does not move); below sm each link is an outlined 44px button instead (its ::after is off there); the focus ring and color transition are shared site constants, not retyped.
 */
const PAGE_LINK = `${FOCUS} ${TRANSITION} ${TAP_TARGET} hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:rounded-lg max-sm:border max-sm:border-neutral-300 max-sm:px-4 max-sm:no-underline max-sm:after:hidden dark:max-sm:border-neutral-700`

export function Pagination({ meta, basePath }: { meta: PageMeta; basePath: string }) {
  const t = useTranslations('Site.pagination')
  if (meta.totalPages <= 1) return null

  // The reader controls ?page= in the URL and the backend echoes back whatever it was
  // asked for — PostService uses PageRequest.of(Math.max(page, 0), …), so /?page=99
  // against three pages returns meta.page = 99. Without clamping, this component
  // renders "page 100 of 3" with a Previous link to page 98, which is also out of
  // range. Whether an out-of-range page should be a 404 in the first place is the
  // page component's decision, not this one's; this only keeps the pager honest.
  const page = Math.min(Math.max(meta.page, 0), meta.totalPages - 1)

  const hasPrevious = page > 0
  const hasNext = page < meta.totalPages - 1

  // basePath may already carry a query — a category or tag page would pass
  // "/?category=cong-nghe" — so this cannot be plain concatenation, which would
  // produce "/?category=cong-nghe?page=1".
  const href = (target: number) => {
    const [path, existingQuery] = basePath.split('?')
    const query = new URLSearchParams(existingQuery)
    query.set('page', String(target))
    return `${path}?${query}`
  }

  // Three-column grid `1fr auto 1fr`, not flex `justify-between`: the two side columns are equal, so
  // the page label always sits exactly in the middle, whether the left is the "previous page" link, the right is the "next page" link
  // or an empty cell. With justify-between it shifts with the length of the two links (measured at 1440: ~40px left of
  // center on page 1, ~46px right of center on page 2) and jumps when the reader pages.
  return (
    <nav aria-label={t('label')} className="mt-10 grid grid-cols-[1fr_auto_1fr] items-center gap-x-2 text-sm">
      {hasPrevious ? (
        <Link href={href(page - 1)} className={`justify-self-start ${PAGE_LINK}`}>
          {t('previous')}
        </Link>
      ) : (
        <span />
      )}

      <span className="justify-self-center text-neutral-600 dark:text-neutral-400">
        {t('status', { page: page + 1, total: meta.totalPages })}
      </span>

      {hasNext ? (
        <Link href={href(page + 1)} className={`justify-self-end text-right ${PAGE_LINK}`}>
          {t('next')}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  )
}
