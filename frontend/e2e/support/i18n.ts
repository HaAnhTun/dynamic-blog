import type { BrowserContext } from '@playwright/test'
import { createTranslator } from 'next-intl'
import { BASE_URL } from './env'
import en from '../../messages/en.json'
import vi from '../../messages/vi.json'

/**
 * The locale an E2E run exercises: `E2E_LOCALE=en` runs the journeys against the English site (URLs carry the `/en` prefix, text comes
 * from the English catalog), anything else is the default Vietnamese site. Tests ask the catalog (`msg`) instead of hard-coding copy.
 */
export type E2ELocale = 'vi' | 'en'
export const E2E_LOCALE: E2ELocale = process.env.E2E_LOCALE === 'en' ? 'en' : 'vi'

/** The URL prefix of the locale under test: empty for the default locale. */
export const LOCALE_PREFIX = E2E_LOCALE === 'vi' ? '' : `/${E2E_LOCALE}`

const CATALOGS = { vi, en }

/** A public path under the locale being tested (`/writing` -> `/en/writing`). Admin paths are never prefixed. */
export function localePath(path: string): string {
  if (path.startsWith('/admin') || path.startsWith('/api') || LOCALE_PREFIX === '') return path
  return path === '/' ? LOCALE_PREFIX : `${LOCALE_PREFIX}${path}`
}

/** The message at a full key, formatted with ICU arguments, in the locale under test (or the given one). */
export function msg(key: string, args?: Record<string, string | number | Date>, locale: E2ELocale = E2E_LOCALE): string {
  const t = createTranslator({
    locale,
    messages: CATALOGS[locale] as never,
    onError: (error) => {
      throw error
    },
  }) as unknown as (key: string, args?: Record<string, unknown>) => string
  return t(key, args)
}

/**
 * Gives a browser context the language of the run. Public pages take their language from the URL (`localePath`), the admin screens
 * from the `admin_locale` cookie (app/admin/language-action.ts), so under `E2E_LOCALE=en` the context carries that cookie for the
 * base URL. Under the default `vi` nothing is set. Every context the suite creates goes through `prepareContext` (network.ts), which
 * calls this.
 */
export async function applyLocale(context: BrowserContext): Promise<void> {
  if (E2E_LOCALE === 'vi') return
  await context.addCookies([{ name: 'admin_locale', value: E2E_LOCALE, url: BASE_URL }])
}

/** The raw ICU template at a full key in the locale under test (for messages with rich-text tags, which `msg` cannot format). */
export function rawMsg(key: string, locale: E2ELocale = E2E_LOCALE): string {
  let node: unknown = CATALOGS[locale]
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part]
  if (typeof node !== 'string') throw new Error(`No message at ${key} in ${locale}`)
  return node
}

/** The URL of the home page of the locale under test, as a pattern for `toHaveURL` (`…/` for the default locale, `…/en` for English). */
export const HOME_URL: RegExp = LOCALE_PREFIX === '' ? /\/$/ : new RegExp(`${LOCALE_PREFIX}/?$`)
