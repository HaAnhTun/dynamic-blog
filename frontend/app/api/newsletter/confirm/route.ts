import type { NextRequest } from 'next/server'
import { payloadTooLarge, readSmallBody } from '@/lib/read-small-body'
import { assertSameOriginRequest } from '@/lib/same-origin'
import { NEWSLETTER_BODY_LIMIT, allowAttempt, forwardToken, invalidToken, jsonObject, rateLimited } from '../newsletter-route'
import { newsletterToken } from '../token'

/**
 * POST /api/newsletter/confirm: the "Confirm subscription" button at /newsletter/confirm sends `{ token }`. Only
 * POST: opening the link (a mail scanner opens it too) changes nothing.
 */

const CONFIRM_LIMIT = 20

export async function POST(request: NextRequest): Promise<Response> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused
  const raw = await readSmallBody(request, NEWSLETTER_BODY_LIMIT)
  if (raw === null) return payloadTooLarge()
  const token = newsletterToken(jsonObject(raw)?.token)
  if (token === null) return invalidToken()
  if (!allowAttempt('newsletter-confirm', request, CONFIRM_LIMIT)) return rateLimited()
  return forwardToken('/api/v1/newsletter/confirm', token, 'CONFIRMED', request)
}
