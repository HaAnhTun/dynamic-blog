import { useTranslations } from 'next-intl'
import { PAGE } from '@/components/admin/ui'

/**
 * Placeholder for every admin page while the server fetches data from the backend (each admin page
 * is dynamic and calls the API on every open). Without this file, pressing a sidebar item stays on
 * the old page until the new one is done; with it the sidebar switches item at once and the content
 * area shows the outline of the page to come.
 *
 * A generic outline (heading, one line of description, a few rows) because one file serves every
 * screen. The pulse runs only when the user has not turned motion off.
 */
export default function AdminLoading() {
  const t = useTranslations('Admin.shell')
  return (
    <div className={PAGE} aria-busy="true">
      <p role="status" className="sr-only">
        {t('loading')}
      </p>
      <div aria-hidden="true" className="motion-safe:animate-pulse">
        <div className="h-8 w-44 rounded-md bg-slate-200" />
        <div className="mt-3 h-4 w-full max-w-md rounded bg-slate-100" />
        <div className="mt-10 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="flex items-center gap-4 px-4 py-4 sm:px-5">
              <div className="hidden h-12 w-[4.5rem] shrink-0 rounded-md bg-slate-100 sm:block" />
              <div className="min-w-0 flex-1">
                <div className="h-4 w-3/4 rounded bg-slate-200" />
                <div className="mt-2 h-3 w-1/2 rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
