'use client'

import { useEffect, useRef, useState } from 'react'
import type { Locale } from '@/i18n/config'
import { cleanQuery, SEARCH_LIMITS, type SearchScope, type SuggestResponse } from '@/lib/search-contract'

/** Within the 150–200 ms of the brief: continuous typing fires no request, pausing for a beat brings results. */
export const DEBOUNCE_MS = 180

/** A small memory, in RAM only, living for one opening of the panel (the panel remounts on every opening). */
const CACHE_MAX = 30

export type SuggestError = 'unavailable' | 'rate-limited'

export type SuggestState = {
  /** `idle`: under 2 characters, no network call. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The results being shown; while waiting they are those of the previous query (no layout jump, not used to open anything). */
  data: SuggestResponse | null
  /** `data` is the result for exactly the current query and scope. */
  fresh: boolean
  error: SuggestError | null
  /** The "All" response for this query (or the latest, while waiting): the source of the tab list under "All". */
  tabs: SuggestResponse | null
  /** Only the "All" response for exactly this query: the source of the tab list while on a tab. */
  tabsForQuery: SuggestResponse | null
}

type Store = {
  byKey: ReadonlyMap<string, SuggestResponse>
  /** The latest successful response (any scope) and the latest of "All". */
  lastKey: string | null
  lastAllKey: string | null
  failed: { key: string; error: SuggestError } | null
}

const keyOf = (scope: SearchScope, query: string, language?: Locale) => `${scope}\u0000${query}\u0000${language ?? ''}`

/**
 * Ask as you type: debounce, cancel the old request with AbortController, and a counter so a slow response
 * to an old query never overwrites the new query. The state is derived at render time from the memory;
 * the effect only writes when a response arrives.
 */
export function useSuggest(rawQuery: string, scope: SearchScope, paused = false, language?: Locale): SuggestState {
  const [store, setStore] = useState<Store>({ byKey: new Map(), lastKey: null, lastAllKey: null, failed: null })
  const latest = useRef(0)
  const query = cleanQuery(rawQuery)
  const active = query.length >= SEARCH_LIMITS.minChars
  const key = keyOf(scope, query, language)
  const hit = active ? store.byKey.get(key) : undefined

  useEffect(() => {
    const id = ++latest.current
    // `paused`: an input method is composing text; ask once the text is composed (the effect runs again when `paused` returns to false).
    if (!active || hit || paused) return

    const controller = new AbortController()
    const settle = (update: (store: Store) => Store) => {
      if (id === latest.current) setStore(update)
    }
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, type: scope, ...(language ? { lang: language } : {}) })
        const response = await fetch(`/api/search/suggest?${params}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
        if (!response.ok) {
          const error: SuggestError = response.status === 429 ? 'rate-limited' : 'unavailable'
          settle((previous) => ({ ...previous, failed: { key, error } }))
          return
        }
        const data = (await response.json()) as SuggestResponse
        settle((previous) => {
          const byKey = new Map(previous.byKey).set(key, data)
          if (byKey.size > CACHE_MAX) byKey.delete(byKey.keys().next().value as string)
          return { byKey, lastKey: key, lastAllKey: scope === 'all' ? key : previous.lastAllKey, failed: null }
        })
      } catch {
        // Cancelling because of a new query is not an error; a real network loss is "could not search".
        if (controller.signal.aborted) return
        settle((previous) => ({ ...previous, failed: { key, error: 'unavailable' } }))
      }
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [active, hit, key, language, paused, query, scope])

  const tabsForQuery = active ? (store.byKey.get(keyOf('all', query, language)) ?? null) : null
  const tabs = tabsForQuery ?? (active && store.lastAllKey ? (store.byKey.get(store.lastAllKey) ?? null) : null)
  if (!active) return { status: 'idle', data: null, fresh: false, error: null, tabs: null, tabsForQuery: null }
  if (hit) return { status: 'ready', data: hit, fresh: true, error: null, tabs, tabsForQuery }
  const shown = store.lastKey ? (store.byKey.get(store.lastKey) ?? null) : null
  if (store.failed?.key === key)
    return { status: 'error', data: shown, fresh: false, error: store.failed.error, tabs, tabsForQuery }
  return { status: 'loading', data: shown, fresh: false, error: null, tabs, tabsForQuery }
}
