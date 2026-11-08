'use client'

import type { Locale } from '@/i18n/config'
import { Link } from '@/i18n/navigation'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { CircleAlertIcon, SearchIcon, UserIcon, XIcon } from '@/components/icons'
import { useLocale, useTranslations } from 'next-intl'
import { formatDate } from '@/lib/date'
import { asLocale } from '@/lib/format'
import { cleanQuery, GROUP_LABEL_KEYS, SEARCH_LIMITS, TAB_TYPES, type PopularItem, type SearchScope } from '@/lib/search-contract'
import { sitePages } from '@/lib/site-pages'
import { useSession } from '@/lib/session-client'
import { Avatar } from '../Avatar'
import { SegmentText } from '../Highlight'
import { searchHref } from '../SearchFilters'
import { FOCUS_INSET, TRANSITION } from '../SectionHeading'
import { DegradedNotice } from './DegradedNotice'
import { allResultsRow, initialSections, resultSections, type PaletteRow, type PaletteSection } from './palette-rows'
import { addRecent, clearRecent, readRecent } from './recent-searches'
import { useSuggest } from './useSuggest'

/**
 * Below 640px: a full-screen sheet like the image viewer (`h-dvh`, `w-full` not `w-screen`). From 640px: a panel
 * anchored at the top, at most 48rem wide (56rem from lg) and no more than the viewport − 2rem, at most 85dvh tall, the results
 * scroll inside. A solid background, one shadow, no glass effect; no animation (no need to worry about reduced motion).
 */
const DIALOG =
  'm-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-neutral-900 backdrop:bg-black/40 backdrop:backdrop-blur-sm print:hidden dark:bg-neutral-900 dark:text-neutral-100 sm:mx-auto sm:mt-[8dvh] sm:h-auto sm:max-h-[85dvh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:rounded-card sm:border sm:border-neutral-200 sm:shadow-lg lg:max-w-4xl sm:dark:border-neutral-800'

const LABEL = 'px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase dark:text-neutral-400'
const ROW = `flex min-h-11 items-start gap-3 rounded-md px-3 py-2 ${TRANSITION}`
const ROW_ACTIVE = 'bg-neutral-100 shadow-[inset_2px_0_0_var(--color-brand)] dark:bg-neutral-800'
const ICON_BOX =
  'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
const KBD = 'rounded border border-neutral-300 px-1 font-sans text-[0.6875rem] dark:border-neutral-700'

/** Once per page load: the most-read block does not change with the query. On error the block is hidden. */
let popularOnce: { locale: Locale; promise: Promise<PopularItem[]> } | null = null
function loadPopular(locale: Locale): Promise<PopularItem[]> {
  // Wrapped in a Promise: a synchronous error (fetch replaced) is also just a hidden block, it does not break the whole header.
  if (popularOnce?.locale === locale) return popularOnce.promise
  const promise = Promise.resolve()
    .then(() =>
      fetch(`/api/search/popular?${new URLSearchParams({ lang: locale })}`, { headers: { accept: 'application/json' } }),
    )
    .then((response) => (response.ok ? (response.json() as Promise<{ items?: unknown }>) : { items: [] }))
    .then((body) => (Array.isArray(body.items) ? (body.items as PopularItem[]) : []))
    .catch(() => [])
  popularOnce = { locale, promise }
  return promise
}

type Active = { key: string; index: number }

/**
 * The quick search panel: a native modal `<dialog>`, the input is an ARIA combobox, the list is a
 * listbox; focus stays in the input (`aria-activedescendant`). Each opening is a fresh mount (Header changes
 * `key`), so the query, tab and result memory always start over. Every way of closing goes through the `close` event.
 */
export function SearchPalette({
  onClosed,
  siteName,
  galleryLead,
}: {
  onClosed: (navigated: boolean) => void
  siteName: string
  galleryLead: string | null
}) {
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.palette')
  const tNav = useTranslations('Site.nav')
  const tDesc = useTranslations('Site.pageDescriptions')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigatedRef = useRef(false)
  const pressOnBackdrop = useRef(false)
  const id = useId()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [active, setActive] = useState<Active>({ key: '', index: 0 })
  const [recent, setRecent] = useState<string[]>(() => readRecent())
  const [popular, setPopular] = useState<PopularItem[]>([])
  const session = useSession()
  // An input method (Telex/VNI via IME) is composing text: no search, no Enter handling.
  const [composing, setComposing] = useState(false)
  const suggest = useSuggest(query, scope, composing, locale)

  const cleaned = cleanQuery(query)
  const searching = cleaned.length >= SEARCH_LIMITS.minChars
  const allHref = searchHref(cleaned, { tags: [] })

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    inputRef.current?.focus()
    let live = true
    void loadPopular(locale).then((items) => {
      if (live) setPopular(items)
    })
    // The virtual keyboard covers the lower half of the full-screen sheet: shrink the sheet to visualViewport, not to vh. Re-evaluated on every
    // resize (device rotation): from 640px it is a panel, height is left to CSS.
    const viewport = window.visualViewport
    function fit() {
      if (!dialog || !viewport) return
      const narrow = window.matchMedia?.('(max-width: 639.98px)')?.matches ?? false
      dialog.style.height = narrow ? `${viewport.height}px` : ''
    }
    fit()
    viewport?.addEventListener('resize', fit)
    return () => {
      live = false
      viewport?.removeEventListener('resize', fit)
    }
  }, [locale])

  // A tab shows when that kind has results for this query (by the "All" response); the selected tab always shows. While on
  // a tab and the "All" response for the new query has not arrived, only "All" and that tab remain, not a tab of the old query.
  const tabSource = scope === 'all' ? suggest.tabs : suggest.tabsForQuery
  const tabs: SearchScope[] = searching
    ? ['all', ...TAB_TYPES.filter((type) => type === scope || (tabSource?.groups.some((group) => group.type === type) ?? false))]
    : []
  const showTabs = tabs.length > 1

  const sections: PaletteSection[] = searching
    ? [
        ...(suggest.data ? resultSections(suggest.data.groups, t) : []),
        { id: 'all', label: null, rows: [allResultsRow(cleaned, allHref, t)] },
      ]
    : [
        ...initialSections(
          cleaned,
          {
            signedIn: session.status === 'authenticated',
            popular,
            recent,
            pages: sitePages(tNav, tDesc, { siteName, galleryLead }),
          },
          t,
        ),
        // One character: Enter still has somewhere to go (/search?q=…) even though no page matches.
        ...(cleaned !== '' ? [{ id: 'all', label: null, rows: [allResultsRow(cleaned, allHref, t)] }] : []),
      ]
  const rows = sections.flatMap((section) => section.rows)
  // Position of the first row of each group in the flat list: an option's id is by that position.
  const firstIndex = sections.map((_, at) => sections.slice(0, at).reduce((sum, section) => sum + section.rows.length, 0))
  const signature = `${scope}\u0000${cleaned}\u0000${rows.map((row) => row.key).join('|')}`
  const activeIndex = active.key === signature ? Math.min(active.index, rows.length - 1) : 0
  const optionId = (index: number) => `${id}-option-${index}`

  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
  })

  const total = suggest.data?.groups.reduce((sum, group) => sum + group.total, 0) ?? 0
  const noMatch = searching && suggest.fresh && total === 0
  const firstLoad = searching && suggest.status === 'loading' && !suggest.data

  function close(navigated: boolean) {
    navigatedRef.current = navigated
    dialogRef.current?.close()
  }

  function move(delta: number) {
    if (rows.length === 0) return
    setActive({ key: signature, index: (activeIndex + delta + rows.length) % rows.length })
  }

  function switchTab(delta: number) {
    if (!showTabs) return
    const at = tabs.indexOf(scope)
    setScope(tabs[(at + delta + tabs.length) % tabs.length]!)
  }

  function openRow(index: number) {
    document.getElementById(optionId(index))?.click()
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Composing text with an input method (Telex, VNI): the key belongs to the input method, not a command.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    // Ctrl+Shift+←/→ selects by word; with no tabs, Ctrl+←/→ jumps by word like in any input.
    const arrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    if (showTabs && arrow && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      switchTab(event.key === 'ArrowRight' ? 1 : -1)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        move(event.key === 'ArrowDown' ? 1 : -1)
        break
      case 'Home':
      case 'End':
        // Shift+Home/End is still text selection in the field.
        if (event.shiftKey || rows.length === 0) return
        event.preventDefault()
        setActive({ key: signature, index: event.key === 'Home' ? 0 : rows.length - 1 })
        break
      case 'Enter': {
        event.preventDefault()
        // The results shown are those of the previous query (loading, error): do not open any row of them.
        if (searching && !suggest.fresh) openRow(rows.length - 1)
        else if (rows.length > 0) openRow(activeIndex)
        break
      }
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const at = tabs.indexOf(scope)
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!
    setScope(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }

  /** A plain click on a panel link: saves the query (if searching) then closes. Ctrl/⌘/Shift/Alt or the middle button
   *  is a new tab, the browser's business; the panel stays open. */
  function onNavigate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (searching) setRecent(addRecent(cleaned, locale))
    close(true)
  }

  function onRowClick(event: MouseEvent<HTMLAnchorElement>, row: PaletteRow) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (row.recentQuery !== undefined) {
      event.preventDefault()
      setQuery(row.recentQuery)
      inputRef.current?.focus()
      return
    }
    onNavigate(event)
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return
    // The browser's native close on Esc behaves differently across browsers (and Esc in a search field
    // clears its text): close it ourselves here, one path for everywhere.
    event.preventDefault()
    close(false)
  }

  function onPointerDown(event: PointerEvent<HTMLDialogElement>) {
    pressOnBackdrop.current = event.target === event.currentTarget
  }

  function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
    // A click on the backdrop (::backdrop has the dialog itself as target), and the press also started on the backdrop.
    if (event.target === event.currentTarget && pressOnBackdrop.current) close(false)
  }

  // The results shown are from basic search: announced in text in the results area, and once in each read-out sentence.
  const degraded = searching && suggest.data?.degraded === true
  const announceKey = `announce.${total > 0 ? 'results' : 'none'}${degraded ? 'Degraded' : ''}`
  const announcement = !searching || !suggest.fresh ? '' : t(announceKey, { count: total })

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('dialogLabel')}
      data-search-palette=""
      className={DIALOG}
      onClose={() => onClosed(navigatedRef.current)}
      onKeyDown={onDialogKeyDown}
      onPointerDown={onPointerDown}
      onClick={onDialogClick}
    >
      <div className="flex h-full flex-col sm:max-h-[85dvh]">
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 sm:px-4 dark:border-neutral-800">
          <SearchIcon size={20} className="text-neutral-500 dark:text-neutral-400" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label={t('inputLabel')}
            aria-expanded={rows.length > 0}
            aria-controls={`${id}-listbox`}
            aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={SEARCH_LIMITS.query}
            placeholder={t('placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            className={`min-w-0 flex-1 rounded-sm bg-transparent py-2 text-base placeholder:text-neutral-500 sm:text-sm dark:placeholder:text-neutral-400 [&::-webkit-search-cancel-button]:appearance-none ${FOCUS_INSET}`}
          />
          {query !== '' ? (
            <button
              type="button"
              aria-label={t('clearQuery')}
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 ${FOCUS_INSET} ${TRANSITION}`}
            >
              <XIcon />
            </button>
          ) : null}
          <button
            type="button"
            // The name contains both visible labels: the close label below 640px, "esc" from 640px (WCAG 2.5.3).
            aria-label={t('closeLabel')}
            onClick={() => close(false)}
            className={`inline-flex h-9 shrink-0 items-center justify-center rounded-md px-2 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 ${FOCUS_INSET} ${TRANSITION}`}
          >
            <span className="sm:hidden">{t('closeShort')}</span>
            <kbd className={`hidden sm:inline ${KBD}`}>esc</kbd>
          </button>
        </div>

        {query.length >= SEARCH_LIMITS.query ? (
          <p className="px-4 pt-2 text-xs text-neutral-600 dark:text-neutral-400">
            {t('maxChars', { max: SEARCH_LIMITS.query })}
          </p>
        ) : null}

        {showTabs ? (
          <div
            role="tablist"
            aria-label={t('tabsLabel')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-neutral-200 px-3 py-2 [scrollbar-width:none] dark:border-neutral-800"
          >
            {tabs.map((tab) => (
              <button
                key={tab}
                id={`${id}-tab-${tab}`}
                type="button"
                role="tab"
                aria-selected={scope === tab}
                aria-controls={`${id}-listbox`}
                tabIndex={scope === tab ? 0 : -1}
                onClick={() => setScope(tab)}
                onKeyDown={onTabKeyDown}
                // A solid brand background: white text 4.8:1 (light), neutral-950 on #4da3ff (dark). Brand text on brand/10 is only 4.2:1
                // (measured by Lighthouse, below 4.5).
                className={`min-h-9 shrink-0 rounded-full px-3 text-sm ${FOCUS_INSET} ${TRANSITION} ${
                  scope === tab
                    ? 'bg-brand font-medium text-white dark:text-neutral-950'
                    : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
                }`}
              >
                {tab === 'all' ? t('tabAll') : t(GROUP_LABEL_KEYS[tab])}
              </button>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" aria-busy={suggest.status === 'loading'}>
          {firstLoad ? <Skeleton /> : null}
          {noMatch ? (
            <NoMatch
              query={cleaned}
              href={allHref}
              scope={scope}
              onShowAll={() => {
                setScope('all')
                inputRef.current?.focus()
              }}
              onNavigate={onNavigate}
            />
          ) : null}
          {searching && suggest.status === 'error' ? (
            <Unavailable href={allHref} rateLimited={suggest.error === 'rate-limited'} onNavigate={onNavigate} />
          ) : null}
          {degraded ? <DegradedNotice className="px-3 pt-3" /> : null}

          {rows.length > 0 ? (
            <div role="listbox" id={`${id}-listbox`} aria-label={t('resultsLabel')}>
              {sections.map((section, sectionAt) => (
                <div
                  key={section.id}
                  role="group"
                  aria-labelledby={section.label ? `${id}-${section.id}` : undefined}
                  aria-label={section.label ? undefined : t('searchPageGroup')}
                >
                  {section.label ? (
                    <div id={`${id}-${section.id}`} role="presentation" className={LABEL}>
                      {section.label}
                    </div>
                  ) : null}
                  {section.rows.map((row, rowAt) => {
                    const at = firstIndex[sectionAt]! + rowAt
                    return (
                      <Row
                        key={row.key}
                        id={optionId(at)}
                        row={row}
                        active={at === activeIndex}
                        onPointerMove={() => {
                          if (at !== activeIndex) setActive({ key: signature, index: at })
                        }}
                        onClick={(event) => onRowClick(event, row)}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Key hints only from 640px; the delete button for recent searches is at every size (rule 6: deletable). */}
        <div
          className={`${!searching && recent.length > 0 ? 'flex' : 'hidden sm:flex'} shrink-0 items-center justify-between gap-4 border-t border-neutral-200 px-4 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400`}
        >
          <span aria-hidden="true" className="hidden items-center gap-3 sm:flex">
            {(['select', 'open', 'close'] as const).map((hint) => (
              <span key={hint}>{t.rich(`hints.${hint}`, { kbd: (chunks) => <kbd className={KBD}>{chunks}</kbd> })}</span>
            ))}
          </span>
          {!searching && recent.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                clearRecent()
                setRecent([])
                // The button disappears by itself: move focus back to the field, do not let it fall to <body> inside the modal.
                inputRef.current?.focus()
              }}
              className={`rounded-sm underline decoration-neutral-300 underline-offset-4 hover:text-brand dark:decoration-neutral-700 ${FOCUS_INSET} ${TRANSITION}`}
            >
              {t('clearRecent')}
            </button>
          ) : null}
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
    </dialog>
  )
}

function Row({
  id,
  row,
  active,
  onPointerMove,
  onClick,
}: {
  id: string
  row: PaletteRow
  active: boolean
  onPointerMove: () => void
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const meta = row.meta
  const locale = asLocale(useLocale())
  const t = useTranslations('Site.palette.meta')
  const metaLine =
    meta?.kind === 'post'
      ? [
          meta.category,
          meta.author,
          formatDate(meta.publishedAt, 'long', locale),
          meta.readingMinutes ? t('readingMinutes', { minutes: meta.readingMinutes }) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : meta?.kind === 'category' || meta?.kind === 'tag'
        ? t(meta.kind === 'category' ? 'categoryCount' : 'tagCount', { count: meta.count })
        : meta?.kind === 'series'
          ? t('parts', { parts: meta.parts })
          : null
  const avatar = row.avatarUrl?.startsWith('https://avatars.githubusercontent.com/') ? row.avatarUrl : null

  return (
    <Link
      id={id}
      href={row.href}
      locale={row.locale}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      prefetch={false}
      onPointerMove={onPointerMove}
      onClick={onClick}
      className={`${ROW} ${active ? ROW_ACTIVE : ''}`}
    >
      {meta?.kind === 'author' ? (
        avatar ? (
          <Avatar name={row.title.map((segment) => segment.text).join('')} src={avatar} size={32} className="mt-0.5 shrink-0" />
        ) : (
          <span className={ICON_BOX} aria-hidden="true">
            <UserIcon />
          </span>
        )
      ) : (
        <span className={ICON_BOX} aria-hidden="true">
          {row.icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-medium break-words ${row.kind === 'all' ? 'text-brand' : ''}`}>
          <SegmentText segments={row.title} />
        </span>
        {row.description ? (
          <span className="mt-0.5 line-clamp-2 text-sm text-neutral-600 dark:text-neutral-300">
            <SegmentText segments={row.description} />
          </span>
        ) : null}
        {metaLine || (meta?.kind === 'post' && meta.tags) ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
            {metaLine ? <span>{metaLine}</span> : null}
            {meta?.kind === 'post'
              ? meta.tags?.map((tag) => (
                  <span key={tag} className="rounded-full border border-neutral-200 px-1.5 dark:border-neutral-700">
                    {tag}
                  </span>
                ))
              : null}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="space-y-2 px-3 pt-4">
      {[0, 1, 2].map((n) => (
        <div key={n} className="flex items-start gap-3">
          <span className="h-8 w-8 shrink-0 rounded-md bg-neutral-100 dark:bg-neutral-800" />
          <span className="flex-1 space-y-2 pt-1">
            <span className="block h-3 w-2/3 rounded bg-neutral-100 dark:bg-neutral-800" />
            <span className="block h-3 w-1/2 rounded bg-neutral-100 dark:bg-neutral-800" />
          </span>
        </div>
      ))}
    </div>
  )
}

function NoMatch({
  query,
  href,
  scope,
  onShowAll,
  onNavigate,
}: {
  query: string
  href: string
  scope: SearchScope
  onShowAll: () => void
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const t = useTranslations('Site.palette.noMatch')
  return (
    <div className="px-3 pt-4 pb-2 text-sm text-neutral-700 dark:text-neutral-300">
      <p className="font-medium">{t('title', { query })}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-400">
        <li>{t('tryShorter')}</li>
        {scope !== 'all' ? (
          <li>
            <button
              type="button"
              onClick={onShowAll}
              className={`rounded-sm underline underline-offset-4 hover:text-brand ${FOCUS_INSET}`}
            >
              {t('searchAllTypes')}
            </button>
          </li>
        ) : null}
        <li>
          <Link
            href={href}
            onClick={onNavigate}
            className={`rounded-sm underline underline-offset-4 hover:text-brand ${FOCUS_INSET}`}
          >
            {t('openFullSearch')}
          </Link>
        </li>
      </ul>
    </div>
  )
}

function Unavailable({
  href,
  rateLimited,
  onNavigate,
}: {
  href: string
  rateLimited: boolean
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const t = useTranslations('Site.palette.unavailable')
  return (
    <div
      role="alert"
      className="mx-1 mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <CircleAlertIcon className="mt-0.5" />
      <p>
        {t(rateLimited ? 'rateLimited' : 'failed')}{' '}
        <Link href={href} onClick={onNavigate} className={`rounded-sm font-medium underline underline-offset-4 ${FOCUS_INSET}`}>
          {t('tryPage')}
        </Link>
      </p>
    </div>
  )
}
