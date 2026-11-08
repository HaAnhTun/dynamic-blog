import 'server-only'
import { NextResponse } from 'next/server'
import { clientIp } from '@/lib/client-ip'
import { rateLimit } from '@/lib/rate-limit'
import { PRIVATE_NO_STORE, bffError, callApi, unreachable } from '@/lib/user-api'

/**
 * Shared part of the three newsletter routes. The backend is called as a guest (`callApi(…, null)`): no
 * cookie, no Bearer, no reader header. The response body is built by the route itself, not the backend body passed through,
 * so no address, token or backend message reaches the browser. Nothing is logged.
 */

/** A real `{"email":"…"}` or `{"token":"…"}` is under 300 bytes; a one-click form (RFC 8058) is even shorter. */
export const NEWSLETTER_BODY_LIMIT = 1024

const HOUR_MS = 60 * 60_000

/** One attempt from the request IP (lib/client-ip.ts) in `bucket`, one-hour window; false once exceeded. */
export function allowAttempt(bucket: string, request: Request, limit: number): boolean {
  return rateLimit(bucket, clientIp(request), limit, HOUR_MS)
}

export function rateLimited(): NextResponse {
  return bffError(429, 'RATE_LIMITED', 'Too many requests, try again later')
}

/** One sentence for every wrong, expired or already used token: no way to tell which case it was. */
export function invalidToken(): NextResponse {
  return bffError(400, 'NEWSLETTER_TOKEN_INVALID', 'The link is invalid or has expired')
}

/** The backend returned a status outside the contract (404 when the endpoint is missing, 5xx…). */
export function upstreamFailed(): NextResponse {
  return bffError(502, 'UPSTREAM_UNAVAILABLE', 'The API could not complete the request')
}

/** The fixed success body of the route: identical every time. */
export function succeeded(status: 200 | 202, state: string): NextResponse {
  return NextResponse.json({ data: { status: state } }, { status, headers: { 'cache-control': PRIVATE_NO_STORE } })
}

/** The object of a JSON body, or null when the body is not a JSON object. */
export function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * POST JSON to the backend as a guest. Returns the status (body discarded unread), or null when the backend is unreachable.
 * `request` is the visitor's own request: the address derived from it (lib/client-ip.ts) goes to the backend, which limits
 * contact and newsletter calls per address too (it believes the address only because of the shared `CLIENT_IP_TOKEN`).
 */
export async function postAnonymously(path: string, body: Record<string, string>, request: Request): Promise<number | null> {
  const res = await callApi(path, { method: 'POST', body: JSON.stringify(body), clientIp: clientIp(request) }, null)
  if (res === null) return null
  await res.body?.cancel()
  return res.status
}

/** Confirm or cancel with a shape-checked token: 2xx → `state`, 400 → the generic sentence, 429 → 429, anything else 502. */
export async function forwardToken(path: string, token: string, state: string, request: Request): Promise<NextResponse> {
  const status = await postAnonymously(path, { token }, request)
  if (status === null) return unreachable()
  if (status >= 200 && status < 300) return succeeded(200, state)
  if (status === 400) return invalidToken()
  if (status === 429) return rateLimited()
  return upstreamFailed()
}
