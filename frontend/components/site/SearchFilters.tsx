import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ChevronRightIcon, XIcon } from '@/components/icons'
import { FOCUS, FOCUS_INSET, FOCUS_RING, INLINE_LINK, TAP_TARGET, TRANSITION } from './SectionHeading'

/** The /search filters, already sanitized in page.tsx: category slug, at most 5 tag slugs, series slug. */
export type SearchFilterState = { category?: string; tags: string[]; series?: string }

export type FilterOption = { slug: string; name: string }
export type FilterOptions = { categories: FilterOption[]; tags: FilterOption[]; series: FilterOption[] }

export function hasFilters(filters: SearchFilterState): boolean {
  return Boolean(filters.category || filters.series) || filters.tags.length > 0
}

/** A link to /search, without `page`; the order is q, category, tag…, series, like the API call. */
export function searchHref(query: string, filters: SearchFilterState): string {
  const params = new URLSearchParams()
  if (query !== '') params.set('q', query)
  if (filters.category) params.set('category', filters.category)
  for (const tag of filters.tags) params.append('tag', tag)
  if (filters.series) params.set('series', filters.series)
  const search = params.toString()
  return search === '' ? '/search' : `/search?${search}`
}

/**
 * A filter value that is active but not in the list (an unknown slug, a list that failed to load) still becomes a selected
 * option: otherwise the next press of the search button silently drops that filter. Removing a filter is the chip's job.
 */
function withActive(options: FilterOption[], active: string[]): FilterOption[] {
  const missing = active.filter((slug) => !options.some((option) => option.slug === slug))
  return [...options, ...missing.map((slug) => ({ slug, name: slug }))]
}

function nameOf(options: FilterOption[], slug: string): string {
  return options.find((option) => option.slug === slug)?.name ?? slug
}

const FIELD = `mt-1 block min-h-11 w-full min-w-0 rounded-md border border-neutral-200 bg-white px-3 py-2 text-base text-neutral-900 sm:min-h-0 sm:text-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 ${FOCUS_RING}`

function FilterSelect(props: {
  id: string
  name: string
  label: string
  all: string
  options: FilterOption[]
  value: string | undefined
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={props.id} className="block text-sm font-medium">
        {props.label}
      </label>
      <select id={props.id} name={props.name} defaultValue={props.value ?? ''} className={FIELD}>
        <option value="">{props.all}</option>
        {props.options.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Plain GET filter fields, placed inside SearchForm's form so the search button submits them too. Collapsed in <details>: a dozen
 * or so open tags push the results below the first screen on a phone (the reason /writing dropped its tag strip).
 * Open when nothing has been searched yet, while the page has nothing else to look at; the chips below the form show the filters in use.
 */
export function SearchFilters({ filters, options, open }: { filters: SearchFilterState; options: FilterOptions; open: boolean }) {
  const categories = withActive(options.categories, filters.category ? [filters.category] : [])
  const series = withActive(options.series, filters.series ? [filters.series] : [])
  const tags = withActive(options.tags, filters.tags)
  const t = useTranslations('Site.search.filters')
  if (categories.length === 0 && series.length === 0 && tags.length === 0) return null

  return (
    <details open={open} className="group mt-4 rounded-card border border-neutral-200 dark:border-neutral-800">
      <summary
        className={`flex cursor-pointer list-none items-center justify-between gap-3 rounded-card px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden ${FOCUS_INSET}`}
      >
        {t('summary')}
        <ChevronRightIcon size={14} className="rotate-90 text-neutral-500 group-open:-rotate-90 dark:text-neutral-400" />
      </summary>
      <div className="space-y-4 px-4 pb-4">
        {(categories.length > 0 || series.length > 0) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {categories.length > 0 && (
              <FilterSelect
                id="search-category"
                name="category"
                label={t('category')}
                all={t('allCategories')}
                options={categories}
                value={filters.category}
              />
            )}
            {series.length > 0 && (
              <FilterSelect
                id="search-series"
                name="series"
                label={t('series')}
                all={t('allSeries')}
                options={series}
                value={filters.series}
              />
            )}
          </div>
        )}
        {tags.length > 0 && (
          <fieldset>
            <legend className="text-sm font-medium">{t('tags')}</legend>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm max-sm:gap-y-0">
              {tags.map((tag) => (
                <label
                  key={tag.slug}
                  className={`inline-flex min-w-0 cursor-pointer items-center gap-2 [overflow-wrap:anywhere] max-sm:min-h-11 max-sm:after:hidden ${TAP_TARGET}`}
                >
                  <input
                    type="checkbox"
                    name="tag"
                    value={tag.slug}
                    defaultChecked={filters.tags.includes(tag.slug)}
                    className={`h-5 w-5 shrink-0 accent-brand sm:h-4 sm:w-4 ${FOCUS_RING}`}
                  />
                  {tag.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t.rich('combineHelp', {
            b: (chunks) => <span className="font-medium text-neutral-900 dark:text-neutral-100">{chunks}</span>,
          })}
        </p>
      </div>
    </details>
  )
}

const CHIP = `inline-flex max-w-full items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-xs max-sm:min-h-9 max-sm:text-[0.8125rem] max-sm:after:-inset-y-1 text-neutral-700 hover:text-brand dark:bg-neutral-800 dark:text-neutral-300 ${FOCUS} ${TAP_TARGET} ${TRANSITION}`

/**
 * Each active filter is a link to the same URL minus exactly that filter, and dropping `page`: page 3 of the old set
 * is not page 3 of the new set. The accessible name is entirely in `aria-label`, because Chrome splits a combined name from
 * sr-only spans. `gap-3`: the TAP_TARGET tap areas (6px horizontal, 10px vertical) do not cover the neighboring chip.
 */
export function ActiveFilters({
  query,
  filters,
  options,
}: {
  query: string
  filters: SearchFilterState
  options: FilterOptions
}) {
  const t = useTranslations('Site.search.active')
  if (!hasFilters(filters)) return null

  const chips: { key: string; kind: 'category' | 'tag' | 'series'; name: string; href: string }[] = []
  if (filters.category) {
    chips.push({
      key: `category:${filters.category}`,
      kind: 'category',
      name: nameOf(options.categories, filters.category),
      href: searchHref(query, { ...filters, category: undefined }),
    })
  }
  for (const tag of filters.tags) {
    chips.push({
      key: `tag:${tag}`,
      kind: 'tag',
      name: nameOf(options.tags, tag),
      href: searchHref(query, { ...filters, tags: filters.tags.filter((other) => other !== tag) }),
    })
  }
  if (filters.series) {
    chips.push({
      key: `series:${filters.series}`,
      kind: 'series',
      name: nameOf(options.series, filters.series),
      href: searchHref(query, { ...filters, series: undefined }),
    })
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
      <span id="search-active-filters" className="text-neutral-600 dark:text-neutral-400">
        {t('label')}
      </span>
      <ul aria-labelledby="search-active-filters" className="flex min-w-0 flex-wrap gap-3">
        {chips.map((chip) => (
          <li key={chip.key} className="min-w-0">
            <Link href={chip.href} aria-label={t(`remove.${chip.kind}`, { name: chip.name })} className={CHIP}>
              <span className="min-w-0 [overflow-wrap:anywhere]">{t(`chip.${chip.kind}`, { name: chip.name })}</span>
              <XIcon size={14} className="text-neutral-500 dark:text-neutral-400" />
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href={searchHref(query, { tags: [] })}
        className={`${INLINE_LINK} ${TAP_TARGET} max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:after:hidden`}
      >
        {t('clear')}
      </Link>
    </div>
  )
}
