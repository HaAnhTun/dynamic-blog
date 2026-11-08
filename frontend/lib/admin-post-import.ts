import 'server-only'
import { cookies } from 'next/headers'
import type { Locale } from '@/i18n/config'
import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { accessCookieName } from './auth-cookies'
import type { PostApplyResult, PostArticlePreview, PostManifestItem, PostPreview } from './post-import'
import { apiBaseUrl } from '@/lib/api-base-url'

/*
 * Admin calls of the post import endpoints (/api/v1/admin/post-import/**): Markdown files that become draft posts. Same rules as
 * admin-site-import.ts: the token comes from the cookie, nothing is cached, 401 is SessionExpiredError. The types and the limits
 * live in post-import.ts, which the page imports too.
 */

const BASE_URL = apiBaseUrl()
const ROOT = '/api/v1/admin/post-import'

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

function fileParts(files: readonly File[]): FormData {
  const body = new FormData()
  for (const file of files) body.append('file', file, file.name)
  return body
}

/** Uploads the files (one part each, in order) and returns what applying them would do. Nothing is written. */
export function previewPostFiles(files: readonly File[]): Promise<PostPreview> {
  return data(`${ROOT}/preview`, { method: 'POST', body: fileParts(files) })
}

/**
 * The article of ONE file (a Markdown file or a ZIP package) with the images of a package inlined, for the page that shows it as it
 * will look. Nothing is written. It counts as one use of the preview's rate limit, so the page asks only for the files it needs.
 */
export function previewPostArticle(file: File): Promise<PostArticlePreview> {
  return data(`${ROOT}/article-preview`, { method: 'POST', body: fileParts([file]) })
}

/**
 * The same files in the same order, plus ONE text part: the manifest, a JSON array with one item per file (the hash the preview
 * reported, whether the file is ticked, the opaque preview state). File names are not in it.
 */
export function applyPostFiles(args: {
  files: readonly File[]
  manifest: readonly PostManifestItem[]
}): Promise<PostApplyResult> {
  const body = fileParts(args.files)
  body.append('manifest', JSON.stringify(args.manifest))
  return data(`${ROOT}/apply`, { method: 'POST', body })
}

/** The raw backend response of the template download, to be passed on to the browser. */
export function fetchPostTemplate(language: Locale): Promise<Response> {
  return call(`${ROOT}/template?language=${encodeURIComponent(language)}`)
}
