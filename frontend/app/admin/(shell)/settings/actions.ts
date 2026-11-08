'use server'

import { getTranslations } from 'next-intl/server'
import { updateTag } from 'next/cache'
import { parseProblems, type Problem } from '@/components/admin/settings/json-text'
import { adminErrorMessage, runAdminAction } from '@/lib/admin-action'
import {
  importDocumentText,
  restoreRevisionRow,
  putSectionRow,
  uploadAvatarFile,
  type ImportResult,
} from '@/lib/admin-site-content'
import { requestSampleContent, type SampleContentResult } from '@/lib/admin-sample-content'
import { isLocale } from '@/i18n/config'
import { MAX_UPLOAD_BYTES } from '@/lib/prepare-upload'
import { SITE_CONTENT_KEYS, type SiteContentKey } from '@/lib/site-content-types'

/*
 * The writes of the site content screen. The content is read by every public page through the 'site-content' tag, so each
 * successful write clears it; a failure clears nothing (updateTag also re-renders the current page in the response).
 * An action is an endpoint anyone can POST to: the key, the locale and the shape of the arguments are checked here again.
 */

/** Same limit as the backend (512 KiB): the check here only saves a round trip. */
const MAX_IMPORT_BYTES = 512 * 1024

/** An error to show in place; `problems` carries the parsed `<pointer>: <reason>` list of a refused document. */
export type SettingsError = { error: string; problems?: Problem[] }
export type SectionSaved = { saved: true; payload: unknown; updatedAt: string }

function invalidate() {
  updateTag('site-content')
}

const isKey = (value: unknown): value is SiteContentKey => (SITE_CONTENT_KEYS as readonly unknown[]).includes(value)
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function badArguments(): Promise<SettingsError> {
  return { error: (await getTranslations('Admin.settings.errors'))('badArguments') }
}

/**
 * Like `runAdminAction`, but a refused document (`SITE_CONTENT_INVALID`) also comes back as parsed problems, because the
 * message carries a JSON pointer per problem and the editors point at the field or line.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T | SettingsError> {
  let problems: Problem[] | undefined
  const result = await runAdminAction(fn, (e, t) => {
    if (e.code !== 'SITE_CONTENT_INVALID') return adminErrorMessage(e, t)
    problems = parseProblems(e.message)
    return ''
  })
  if (problems === undefined) return result
  return { error: (await getTranslations('Admin.settings.errors'))('invalid'), problems }
}

export async function saveSection(key: string, locale: string, payload: unknown): Promise<SectionSaved | SettingsError> {
  if (!isKey(key) || !isLocale(locale) || !isPlainObject(payload)) return badArguments()
  const result = await guard(() => putSectionRow(key, locale, payload))
  if ('error' in result) return result
  invalidate()
  return { saved: true, payload: result.payload, updatedAt: result.updatedAt }
}

export async function restoreRevision(key: string, locale: string, id: number): Promise<SectionSaved | SettingsError> {
  if (!isKey(key) || !isLocale(locale) || !Number.isSafeInteger(id) || id <= 0) return badArguments()
  const result = await guard(() => restoreRevisionRow(key, locale, id))
  if ('error' in result) return result
  invalidate()
  return { saved: true, payload: result.payload, updatedAt: result.updatedAt }
}

/** The form field `file` holds the export document; the backend validates every section before it writes any. */
export async function importDocument(form: FormData): Promise<ImportResult | SettingsError> {
  const t = await getTranslations('Admin.settings.errors')
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return { error: t('noFile') }
  if (file.size > MAX_IMPORT_BYTES) return { error: t('fileTooLarge') }
  const text = await file.text()
  try {
    if (!isPlainObject(JSON.parse(text))) return { error: t('notJson') }
  } catch {
    return { error: t('notJson') }
  }
  const result = await guard(() => importDocumentText(text))
  if ('error' in result) return result
  invalidate()
  return result
}

/**
 * Loads the packaged sample posts, series, category and tags (idempotent). The posts, series and taxonomy feed the public lists,
 * the sitemap and the feed, and the search results, so a success clears their tags; a failure clears nothing.
 */
export async function loadSampleContent(): Promise<SampleContentResult | SettingsError> {
  const result = await guard(() => requestSampleContent())
  if ('error' in result) return result
  for (const tag of ['posts', 'series', 'categories', 'tags', 'search']) updateTag(tag)
  return result
}

/** The avatar goes through the same media pipeline as every other image; the page saves the profile with the returned URL. */
export async function uploadAvatar(form: FormData): Promise<{ url: string } | SettingsError> {
  const t = await getTranslations('Admin.settings.errors')
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return { error: t('noFile') }
  if (file.size > MAX_UPLOAD_BYTES) return { error: t('fileTooLarge') }
  // Nothing in the content changed until the profile is saved: no cache clearing here.
  return guard(() => uploadAvatarFile(file))
}
