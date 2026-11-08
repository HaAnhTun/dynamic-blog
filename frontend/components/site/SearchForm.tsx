import type { ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { getPathname } from '@/i18n/navigation'

/**
 * The search box. A plain GET form, and a server component — no `'use client'`.
 *
 * WHY A FORM AND NOT AN ONCHANGE FETCH. The query has to live in the URL. A
 * client-side box holding the query in `useState` gives a result set that cannot be
 * linked, cannot be shared, dies on reload and on the back button, and forces the whole
 * /search route to become a client component that fetches the API from the reader's
 * browser — which also means the API base URL has to be public and CORS has to allow
 * it. `method="get"` costs nothing and the browser does the work: it serialises the
 * named fields into `?q=…` and navigates. app/search/page.tsx then reads
 * `searchParams` and stays a server component.
 *
 * The submit is a real <button type="submit">, not only the implicit Enter-in-a-
 * single-input behaviour. Enter does submit a one-field form, but touch keyboards vary
 * on whether they offer a Go key, and a visible button is also the only affordance a
 * reader has that this box searches rather than filters as you type.
 *
 * `action="/search"` is absolute on purpose. A form with no action posts to the CURRENT
 * URL, which is almost right — /search submitting to /search — but it is only right
 * while this component is used on /search alone. The day it appears in the header or on
 * /writing, an actionless form would submit to that page instead, and `?q=` on
 * /writing is silently ignored. Naming the destination makes the component portable. The destination carries the
 * locale of the page (`/en/search`), or an English reader would land on the Vietnamese results.
 */
export function SearchForm({
  q,
  autoFocus = q === '',
  children,
}: {
  q: string
  /** /search turns it off when filtering with no keyword: the reader is reading results, as when `q` is present. */
  autoFocus?: boolean
  /** The /search filter fields: inside the same GET form, so the search button and Enter in the field submit them too. */
  children?: ReactNode
}) {
  const t = useTranslations('Site.search.form')
  const action = getPathname({ href: '/search', locale: useLocale() })
  return (
    /*
      `role="search"` makes this a search landmark, so a screen reader user can jump
      straight to it. The form is NOT given an aria-label as well: the landmark's name
      would then compete with the label on the field, and one of the two inevitably
      drifts. The visible <label> is the single name.

      No `aria-label` on the form also means no duplicate when the header's own search
      affordance grows into a second SearchForm.
    */
    <form method="get" action={action} role="search" className="mt-6">
      <label htmlFor="search-q" className="block text-sm font-medium">
        {t('keywordLabel')}
      </label>

      <div className="mt-2 flex flex-wrap gap-2 sm:flex-nowrap">
        {/*
          `type="search"`, not `type="text"`: mobile keyboards offer a Go key for it and
          desktop browsers add a clear affordance. It submits identically.

          `defaultValue`, not `value`: a controlled input in a server component has no
          onChange to put behind it, and React warns about exactly that. The field is
          re-rendered from the URL on every navigation, which is the whole point — after
          submitting "queue" the box still reads "queue", so refining a search means
          editing rather than retyping.

          `name="q"` is load-bearing — it is the only reason the browser produces
          `?q=…`. There is a test pinning it.

          `autoFocus` only when there is no query: a person arriving at an empty /search — from the header's search slot
          or the "/" key — arrives to type. With a query the reader is reading results, and focusing
          the field would scroll the page to the top and raise the phone keyboard over the list. Still a server
          component: React writes `autofocus` into the server HTML (first load) and calls focus() itself
          when the field is mounted on the client (router navigation). `id="search-q"` is the target of the "/"
          key in the Header when the reader is already on this page.
        */}
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={q}
          autoFocus={autoFocus}
          placeholder={t('placeholder')}
          className="min-w-0 flex-1 max-sm:min-h-11 rounded-md border border-neutral-200 bg-white px-3 py-2 text-neutral-900 placeholder:text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md max-sm:min-h-11 border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-[120ms] hover:border-brand hover:bg-brand motion-reduce:transition-none dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:border-brand dark:hover:bg-brand dark:hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {t('submit')}
        </button>
      </div>

      {children}

      {/*
        No more sentence about search being diacritic-sensitive under the field. That sentence was true when the backend searched
        with Postgres's `simple` config, which keeps diacritics in words (q=hoc returned 0 posts, q with diacritics returned 5).
        The backend now searches with the accent-stripping config `vi_unaccent`: the unaccented form finds the accented word, and so on,
        so a reader typing without diacritics no longer meets an empty page, and the warning sentence became false.
      */}
    </form>
  )
}
