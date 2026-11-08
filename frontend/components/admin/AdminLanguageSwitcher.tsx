'use client'

import { useLocale, useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { useSyncExternalStore } from 'react'
import { setAdminLocale } from '@/app/admin/language-action'
import { LOCALES } from '@/i18n/config'
import { LANGUAGE_NAMES } from '@/components/site/language-names'
import { button } from './ui'

/**
 * The admin language: one submit button per language in a plain form (works without JavaScript). The language lives in a cookie
 * (the admin has no locale in its URLs); the action sets it and sends the browser back to this page.
 */
/** The query string is not a React-tracked value: read it from the location at render, and render without it on the server. */
const subscribeNothing = () => () => {}

export default function AdminLanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('Admin.language')
  const current = useLocale()
  const pathname = usePathname() ?? '/admin'
  // Known after mount (no JavaScript: the form returns to the path alone). `?reason=forbidden` and list filters are part of the page.
  const search = useSyncExternalStore(
    subscribeNothing,
    () => window.location.search,
    () => '',
  )
  const returnTo = `${pathname}${search}`

  return (
    <form action={setAdminLocale} className={className}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <div role="group" aria-label={t('label')} className="flex items-center gap-1">
        {LOCALES.map((locale) => (
          <button
            key={locale}
            type="submit"
            name="locale"
            value={locale}
            lang={locale}
            aria-pressed={locale === current}
            className={button('ghost', 'sm', locale === current ? 'bg-slate-200/70 text-slate-900' : '')}
          >
            {LANGUAGE_NAMES[locale]}
          </button>
        ))}
      </div>
    </form>
  )
}
