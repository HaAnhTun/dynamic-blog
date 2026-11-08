import 'server-only'
import type { NextRequest, NextResponse } from 'next/server'
import { BFF_BODY_LIMIT, payloadTooLarge, readSmallBody } from './read-small-body'
import { assertSameOriginRequest } from './same-origin'
import { bffError, forwardToApi } from './user-api'
import { isUuid } from './uuid'

/**
 * Shared frame of the BFF routes for comments, likes and notifications: parameter checks,
 * blocking cross-site writes, then forwarding to the backend through lib/user-api.ts.
 *
 * The backend path may ONLY be built from values that went through the check functions below. That is the barrier that keeps a
 * strange parameter (`..`, `/`, `?`, a string that is not a UUID) from ever changing the endpoint the BFF
 * calls with the reader's Bearer. Next's params are already decoded once before reaching here
 * (`%2F` becomes `/`), so check the decoded value, then encode again when building the URL.
 */

/** The backend's keyset cursor: base64url without padding. */
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/

const SLUG_MAX_LENGTH = 255

/** 400 VALIDATION_ERROR: an invalid path or query parameter. The backend is not called. */
export function invalidParameter(): NextResponse {
  return bffError(400, 'VALIDATION_ERROR', 'Invalid path or query parameter')
}

/**
 * `/api/v1/posts/<slug>` with the encoded slug, or null when the slug is invalid: empty, longer than 255
 * characters, containing `/`, or being `.`/`..`. The two dot segments do not get past `encodeURIComponent` (it leaves
 * the dot alone), and the fetch URL collapses `/posts/../like` into `/like` — a completely different endpoint.
 * The site's real slugs only have lowercase letters, digits and hyphens, so no post is blocked by mistake.
 */
export function postApiPath(slug: string): string | null {
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH || slug.includes('/')) return null
  if (slug === '.' || slug === '..') return null
  try {
    return `/api/v1/posts/${encodeURIComponent(slug)}`
  } catch {
    // Lone surrogate: encodeURIComponent throws URIError.
    return null
  }
}

/** `/api/v1/comments/<id>`, or null when the id is not a UUID. */
export function commentApiPath(id: string): string | null {
  return isUuid(id) ? `/api/v1/comments/${id}` : null
}

/** The notification inbox of the logged-in user in the backend. */
export const NOTIFICATIONS_API_PATH = '/api/v1/notifications'

/** `/api/v1/notifications/<id>`, or null when the id is not a UUID. */
export function notificationApiPath(id: string): string | null {
  return isUuid(id) ? `${NOTIFICATIONS_API_PATH}/${id}` : null
}

export function isCommentCursor(value: string): boolean {
  return CURSOR.test(value)
}

/** A read by the reader (GET, auth optional): guests can read too, and a logged-in user comes with a Bearer. */
export async function forwardRead(request: NextRequest, path: string | null): Promise<Response> {
  if (path === null) return invalidParameter()
  return forwardToApi(request, path, { method: 'GET' }, 'optional')
}

/**
 * A read of the reader's private data (GET, auth required): the notification inbox, the unread count.
 * A broken parameter gives 400, no session gives 401, neither calls the backend. No same-origin check like
 * `forwardWrite`: a GET changes nothing, and without CORS another site cannot read the response.
 */
export async function forwardPrivateRead(request: NextRequest, path: string | null): Promise<Response> {
  if (path === null) return invalidParameter()
  return forwardToApi(request, path, { method: 'GET' }, 'required')
}

/**
 * A write by the reader (auth required), in exactly this order:
 *   1. same origin, and `application/json` for POST/PUT (403/415) — before everything else, including the
 *      parameter check: a cross-site request must not learn anything more about the route;
 *   2. path parameters (400), before reading the body;
 *   3. body at most 16 KB, actually measured (413). Even routes that do not use a body (PUT/DELETE like,
 *      DELETE comment) read it: every write route has the same limit;
 *   4. forward to the backend: Bearer, refresh when needed, the backend's status and envelope come out intact.
 *
 * With `forwardBody: false` the body is dropped: the backend receives nothing besides the method and the path.
 */
export async function forwardWrite(
  request: NextRequest,
  path: string | null,
  method: 'POST' | 'PUT' | 'DELETE',
  { forwardBody }: { forwardBody: boolean },
): Promise<Response> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused
  if (path === null) return invalidParameter()
  const body = await readSmallBody(request, BFF_BODY_LIMIT)
  if (body === null) return payloadTooLarge()
  return forwardToApi(request, path, forwardBody ? { method, body } : { method }, 'required')
}
