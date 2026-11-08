import 'server-only'
import { cookies } from 'next/headers'
import type { Locale } from '@/i18n/config'
import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { accessCookieName } from './auth-cookies'
import type { PostImportNote, PostPackageFacts } from './post-import'
import { apiBaseUrl } from '@/lib/api-base-url'

/*
 * Admin calls of the profile import endpoints (/api/v1/admin/site-import/**), the Markdown file that fills the site content.
 * Same rules as admin-site-content.ts: the token comes from the cookie, nothing is cached, 401 is SessionExpiredError.
 */

const BASE_URL = apiBaseUrl()
const ROOT = '/api/v1/admin/site-import'

export type ImportMode = 'create-only' | 'update'
export type SectionStatus = 'new' | 'will_change' | 'unchanged' | 'error' | 'missing'

/** A problem of the file or of one section. The message never echoes a value of the file. */
export type ImportProblem = { sectionId: string | null; field: string | null; line: number | null; message: string }
export type IgnoredItem = { kind: string; sectionId: string | null; name: string; line: number | null }

export type PreviewChange = {
  field: string
  kind: 'value' | 'list'
  before: string | null
  after: string | null
  added: number | null
  removed: number | null
  kept: number | null
}

export type PreviewSection = {
  id: string
  heading: string
  key: string
  line: number | null
  present: boolean
  status: SectionStatus
  selectable: boolean
  changes: PreviewChange[]
  missingOptional: string[]
  errors: ImportProblem[]
}

export type ImportPreview = {
  sha256: string
  bytes: number
  schemaVersion: string | null
  contentType: string | null
  locale: string | null
  willWriteTo: string | null
  errors: ImportProblem[]
  ignored: IgnoredItem[]
  ignoredTotal: number
  sections: PreviewSection[]
  /** What the ZIP package holds (counts and bytes, never text); null for a plain .md file. Optional: an older backend has none. */
  pack?: PostPackageFacts | null
  /** Non-blocking facts about a package, such as an image nothing uses (`asset_unused`, the path in `key`). */
  notes?: PostImportNote[]
}

export type AppliedStatus = 'created' | 'updated' | 'unchanged' | 'skipped'
export type ApplyResult = {
  importId: number | null
  locale: string
  mode: ImportMode
  sections: { id: string; key: string; status: AppliedStatus }[]
}

export type UndoResult = {
  importId: number
  locale: string
  sections: { key: string; status: 'restored' | 'removed' }[]
}

export type LastImport = {
  id: number
  createdAt: string
  locale: string
  mode: ImportMode
  undone: boolean
  undoable: boolean
  sections: { key: string; status: string }[]
}
export type ImportStatus = { lastImport: LastImport | null }

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = (await cookies()).get(accessCookieName())?.value
  if (!token) throw new SessionExpiredError()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
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

/** Uploads the file and returns what applying it would do. Nothing is written. */
export function previewFile(file: File): Promise<ImportPreview> {
  const body = new FormData()
  body.append('file', file, file.name)
  return data(`${ROOT}/preview`, { method: 'POST', body })
}

/** The same file, the hash the preview reported, the mode and the chosen section ids. */
export function applyImport(args: { file: File; sha256: string; mode: ImportMode; sections: string[] }): Promise<ApplyResult> {
  const body = new FormData()
  body.append('file', args.file, args.file.name)
  body.append('sha256', args.sha256)
  body.append('mode', args.mode)
  for (const id of args.sections) body.append('sections', id)
  return data(`${ROOT}/apply`, { method: 'POST', body })
}

/**
 * Undoes the import the admin is looking at. The id is required: when a newer import exists the backend answers 409
 * SITE_IMPORT_UNDO_CONFLICT instead of undoing one the admin did not see.
 */
export function undoImport(importId: number): Promise<UndoResult> {
  if (!Number.isSafeInteger(importId) || importId <= 0) throw new RangeError('importId must be a positive integer')
  return data(`${ROOT}/undo?importId=${importId}`, { method: 'POST' })
}

export function getImportStatus(): Promise<ImportStatus> {
  return data(`${ROOT}/status`)
}

/** The raw backend responses of the two downloads, to be passed on to the browser. */
export function fetchTemplate(locale: Locale): Promise<Response> {
  return call(`${ROOT}/template?locale=${encodeURIComponent(locale)}`)
}

/** The Markdown profile file, or with `format: 'zip'` the ZIP package: that file plus every image the content uses. */
export function fetchProfileExport(locale: Locale, format?: 'zip'): Promise<Response> {
  const query = format === 'zip' ? '&format=zip' : ''
  return call(`${ROOT}/export?locale=${encodeURIComponent(locale)}${query}`)
}
