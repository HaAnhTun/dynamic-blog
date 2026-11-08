import 'server-only'
import { cookies } from 'next/headers'
import type { Locale } from '@/i18n/config'
import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { accessCookieName } from './auth-cookies'
import type { SiteContentKey } from './site-content-types'
import { apiBaseUrl } from '@/lib/api-base-url'

/*
 * Admin calls of the site content endpoints (/api/v1/admin/site-content/**). A module of its own: admin-api.ts does not
 * export its request helper, and this API has two shapes it cannot return (a raw export stream, a text import).
 * Same rules as admin-api: the token comes from the cookie, nothing is cached, 401 is SessionExpiredError.
 */

const BASE_URL = apiBaseUrl()
const ROOT = '/api/v1/admin/site-content'

export type SectionRow = { schemaVersion: number; updatedAt: string; payload: unknown }

/** `GET /admin/site-content?locale=`: the exact rows of one locale (no fallback) and the deployment settings. */
export type SiteContentOverview = {
  locale: Locale
  defaultLocale: Locale
  locales: Locale[]
  sections: Partial<Record<SiteContentKey, SectionRow>>
}

export type SectionDetail = SectionRow & { key: SiteContentKey; locale: Locale }

export type RevisionSummary = { id: number; schemaVersion: number; createdAt: string }

export type ImportResult = {
  locale: Locale
  sections: { key: SiteContentKey; status: 'created' | 'updated' | 'unchanged' }[]
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = (await cookies()).get(accessCookieName())?.value
  if (!token) throw new SessionExpiredError()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    const message = body.error?.message ?? `API responded ${res.status} for ${path}`
    if (res.status === 401) throw new SessionExpiredError(message)
    throw new ApiError(res.status, body.error?.code, message)
  }
  return res
}

async function data<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init)
  const body = (await res.json().catch(() => null)) as { data?: T } | null
  if (body === null || body.data === undefined) throw new ApiError(502, undefined, `API answered ${path} with no content`)
  return body.data
}

const section = (key: SiteContentKey, locale: Locale) => `${ROOT}/${encodeURIComponent(key)}?locale=${locale}`

export function getSiteContentOverview(locale: Locale): Promise<SiteContentOverview> {
  return data(`${ROOT}?locale=${locale}`)
}

/** The row of one key and locale, or null when none was saved yet (404). */
export async function getSectionRow(key: SiteContentKey, locale: Locale): Promise<SectionDetail | null> {
  try {
    return await data<SectionDetail>(section(key, locale))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export function putSectionRow(key: SiteContentKey, locale: Locale, payload: unknown): Promise<SectionDetail> {
  return data(section(key, locale), { method: 'PUT', body: JSON.stringify({ schemaVersion: 1, payload }) })
}

export function listRevisions(key: SiteContentKey, locale: Locale): Promise<RevisionSummary[]> {
  return data(`${ROOT}/${encodeURIComponent(key)}/revisions?locale=${locale}`)
}

export function restoreRevisionRow(key: SiteContentKey, locale: Locale, id: number): Promise<SectionDetail> {
  return data(`${ROOT}/${encodeURIComponent(key)}/revisions/${id}/restore?locale=${locale}`, { method: 'POST' })
}

/** The raw backend response of the export, to be passed on to the browser as it is. */
export function fetchExport(locale: Locale): Promise<Response> {
  return call(`${ROOT}/export?locale=${locale}`)
}

/** `text` is the export document as a string; the backend validates all of it before it writes anything. */
export function importDocumentText(text: string): Promise<ImportResult> {
  return data(`${ROOT}/import`, { method: 'POST', body: text })
}

/** Stores an avatar image through the media pipeline; returns the `/media/...` value the `profile.avatar` field accepts. */
export async function uploadAvatarFile(file: File): Promise<{ url: string }> {
  const body = new FormData()
  body.append('file', file, file.name)
  return data(`${ROOT}/avatar`, { method: 'POST', body })
}
