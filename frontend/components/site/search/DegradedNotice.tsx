import { useTranslations } from 'next-intl'

/**
 * `degraded`: the main engine is down, the results are from basic search (Postgres). A neutral line of text, shared by
 * the quick search panel and `/search`; not an error, so no `role="alert"` or `role="status"`.
 */
export function DegradedNotice({ className = '' }: { className?: string }) {
  const t = useTranslations('Site.search')
  return <p className={`text-xs text-neutral-600 dark:text-neutral-400 ${className}`}>{t('degraded')}</p>
}
