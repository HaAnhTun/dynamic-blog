import type { NextRequest } from 'next/server'
import { payloadTooLarge, readSmallBody } from '@/lib/read-small-body'
import { bffError } from '@/lib/user-api'
import { NEWSLETTER_BODY_LIMIT, allowAttempt, forwardToken, invalidToken, jsonObject, rateLimited } from '../newsletter-route'
import { newsletterToken } from '../token'

/**
 * POST /api/newsletter/unsubscribe, two ways to call it: the /newsletter/unsubscribe page sends JSON `{ token }`;
 * a mail provider sends a one-click POST (RFC 8058) from their own machine: form body `List-Unsubscribe=One-Click`, token in
 * `?token=`. Repeating it is still 200.
 */

// No assertSameOriginRequest: a one-click POST always comes from elsewhere. The token is the authority; the route reads no cookie and
// sends no session to the backend, so a cross-site forged request borrows nothing of the reader.

const UNSUBSCRIBE_LIMIT = 20

/** RFC 8058 §3.1: the body should be multipart/form-data, and may be urlencoded. */
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data'])

async function isOneClickBody(contentType: string, raw: string): Promise<boolean> {
  try {
    const form = await new Response(raw, { headers: { 'content-type': contentType } }).formData()
    return form.get('List-Unsubscribe') === 'One-Click'
  } catch {
    return false
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? ''
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase()
  const json = mediaType === 'application/json'
  if (!json && !FORM_TYPES.has(mediaType)) {
    return bffError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be JSON or a form')
  }
  const raw = await readSmallBody(request, NEWSLETTER_BODY_LIMIT)
  if (raw === null) return payloadTooLarge()

  let token: string | null
  if (json) {
    token = newsletterToken(jsonObject(raw)?.token)
  } else {
    if (!(await isOneClickBody(contentType, raw))) {
      return bffError(400, 'VALIDATION_ERROR', 'Expected List-Unsubscribe=One-Click')
    }
    token = newsletterToken(new URL(request.url).searchParams.get('token'))
  }
  if (token === null) return invalidToken()
  if (!allowAttempt('newsletter-unsubscribe', request, UNSUBSCRIBE_LIMIT)) return rateLimited()
  return forwardToken('/api/v1/newsletter/unsubscribe', token, 'UNSUBSCRIBED', request)
}
