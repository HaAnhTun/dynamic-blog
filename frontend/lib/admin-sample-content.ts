import 'server-only'
import { cookies } from 'next/headers'
import { SessionExpiredError } from './admin-api'
import { ApiError } from './api'
import { accessCookieName } from './auth-cookies'
import { apiBaseUrl } from '@/lib/api-base-url'

/*
 * Admin call of the sample content endpoint (POST /api/v1/admin/sample-content). Same rules as admin-site-content.ts: the
 * token comes from the cookie, nothing is cached, 401 is SessionExpiredError.
 */

const BASE_URL = apiBaseUrl()
const PATH = '/api/v1/admin/sample-content'

/** What one call created; `skipped` counts the items that already existed. */
export type SampleContentResult = { posts: number; series: number; categories: number; tags: number; skipped: number }

/** Creates the sample posts, series, category and tags that are missing. Safe to repeat: nothing is created twice. */
export async function requestSampleContent(): Promise<SampleContentResult> {
  const token = (await cookies()).get(accessCookieName())?.value
  if (!token) throw new SessionExpiredError()
  const res = await fetch(`${BASE_URL}${PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    const message = body.error?.message ?? `API responded ${res.status} for ${PATH}`
    if (res.status === 401) throw new SessionExpiredError(message)
    throw new ApiError(res.status, body.error?.code, message)
  }
  const body = (await res.json().catch(() => null)) as { data?: SampleContentResult } | null
  if (body === null || body.data === undefined) throw new ApiError(502, undefined, `API answered ${PATH} with no content`)
  return body.data
}
