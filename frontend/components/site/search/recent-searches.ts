/**
 * Recent searches of the quick search panel: only in the viewer's `localStorage`,
 * at most 5, deletable. Never sent anywhere. Every read/write is wrapped in try/catch: a private window or
 * blocked site data gives an empty list and the panel still runs.
 */

import { DEFAULT_LOCALE, type Locale } from '@/i18n/config'
import { lowerCase } from '@/lib/format'

export const RECENT_KEY = 'search.recent.v1'
export const RECENT_MAX = 5

export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Puts `query` first, drops duplicates (case-insensitive), keeps 5. Returns a new list. */
export function addRecent(query: string, locale: Locale = DEFAULT_LOCALE): string[] {
  const value = query.trim()
  if (value === '') return readRecent()
  const key = lowerCase(value, locale)
  const next = [value, ...readRecent().filter((item) => lowerCase(item, locale) !== key)].slice(0, RECENT_MAX)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // If it cannot be saved, so be it: the list is only a convenience.
  }
  return next
}

export function clearRecent(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY)
  } catch {
    // As above.
  }
}
