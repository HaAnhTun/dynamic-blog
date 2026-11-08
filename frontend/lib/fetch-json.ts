import 'server-only'
import { ApiError, NotFoundError } from './api'
import type { PageMeta } from './types'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * Shared transport layer for the new read modules (series, gallery, stats, popular).
 *
 * Why not add a function to lib/api.ts: the post page test mocks `@/lib/api` by spreading
 * `importOriginal`, so a new export there that the post page calls would fire a real request to
 * :8080 in tests. A separate module is only mocked by the tests that need it.
 *
 * The error convention is identical to `request` in lib/api.ts, and uses ITS OWN two error classes rather
 * than redefining them: any page that does `instanceof NotFoundError` to call notFound() must recognize
 * errors from here. Two same-named classes in two modules make `instanceof` silently wrong — the page returns 500
 * instead of 404.
 *
 * `init` is passed through unchanged: the cache window and tag are decisions of each read module, not
 * of the transport layer.
 */

const BASE_URL = apiBaseUrl()

export type Envelope<T> = { data: T; pagination?: PageMeta }
type ErrorEnvelope = { error?: { code?: string; message?: string } }

export async function getJson<T>(path: string, init: RequestInit): Promise<Envelope<T>> {
  const res = await fetch(`${BASE_URL}${path}`, init)

  if (!res.ok) {
    // The error body may not be JSON (a proxy's HTML page, for example): it still throws an
    // error with a status, not a confusing SyntaxError.
    const body = (await res.json().catch(() => ({}))) as ErrorEnvelope
    const code = body.error?.code
    const message = body.error?.message ?? `API responded ${res.status} for ${path}`
    if (res.status === 404) throw new NotFoundError(code, message)
    throw new ApiError(res.status, code, message)
  }

  return (await res.json()) as Envelope<T>
}
