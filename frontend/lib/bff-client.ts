/**
 * Calls the site's BFF route handlers from the browser. Never throws: every
 * outcome is a value, so a component needs only one `if (!result.ok)` branch.
 *
 * - 2xx: `{ ok: true, data }`, `data` taken from the `{ data }` envelope; for 204 `data` is null.
 * - error: `{ ok: false, status, code }`. The backend's `message` is dropped here, deliberately: the sentence shown
 *   to the reader comes from lib/interaction-errors.ts, never from the backend.
 * - network error: `code: 'NETWORK'`, `status: 0`.
 */

export type BffResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string }

/** Code when an error response carries no `{ error: { code } }` envelope (the error page of a proxy). */
const UNKNOWN = 'UNKNOWN'

function needsJsonType(init: RequestInit): boolean {
  if (typeof init.body === 'string') return true
  // The BFF write routes require `application/json` for every POST/PUT (lib/same-origin.ts), including the PUT
  // like, which has no body.
  const method = (init.method ?? 'GET').toUpperCase()
  return method === 'POST' || method === 'PUT'
}

export async function callBff<T>(url: string, init: RequestInit = {}): Promise<BffResult<T>> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (needsJsonType(init) && !headers.has('content-type')) headers.set('content-type', 'application/json')

  let res: Response
  try {
    res = await fetch(url, { ...init, headers, cache: 'no-store', credentials: 'same-origin' })
  } catch {
    return { ok: false, status: 0, code: 'NETWORK' }
  }

  if (res.ok) {
    if (res.status === 204) return { ok: true, data: null as T }
    try {
      const body = (await res.json()) as { data?: T }
      return { ok: true, data: (body.data ?? null) as T }
    } catch {
      return { ok: false, status: 502, code: 'BAD_RESPONSE' }
    }
  }

  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  const code = typeof body?.error?.code === 'string' && body.error.code !== '' ? body.error.code : UNKNOWN
  return { ok: false, status: res.status, code }
}
