import type { NextRequest } from 'next/server'
import { isLocale } from '@/i18n/config'
import { payloadTooLarge, readSmallBody } from '@/lib/read-small-body'
import { assertSameOriginRequest } from '@/lib/same-origin'
import { bffError, unreachable } from '@/lib/user-api'
import {
  NEWSLETTER_BODY_LIMIT,
  allowAttempt,
  jsonObject,
  postAnonymously,
  rateLimited,
  succeeded,
  upstreamFailed,
} from '../newsletter-route'

/**
 * POST /api/newsletter/subscribe: the form at /newsletter sends `{ email, locale }`. Every well-formed address gets exactly
 * one answer (202, same body), whether the address is new, pending, confirmed, unsubscribed or has hit the per-address quota at the
 * backend: nobody can probe who is subscribed.
 */

/** The RFC 5321 limit, the same number the backend checks. */
const EMAIL_MAX_LENGTH = 254
const SUBSCRIBE_LIMIT = 5

function invalidEmail() {
  return bffError(400, 'VALIDATION_ERROR', 'Invalid email address')
}

export async function POST(request: NextRequest): Promise<Response> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused
  const raw = await readSmallBody(request, NEWSLETTER_BODY_LIMIT)
  if (raw === null) return payloadTooLarge()
  const body = jsonObject(raw)
  const value = body?.email
  const email = typeof value === 'string' ? value.trim() : ''
  // Only checks type and length; the address format is the backend's call, and its 400 becomes exactly this generic sentence.
  if (email === '' || email.length > EMAIL_MAX_LENGTH) return invalidEmail()
  if (!allowAttempt('newsletter-subscribe', request, SUBSCRIBE_LIMIT)) return rateLimited()

  // The page locale decides the language of the mails; an unknown value is left out and the backend uses the default locale.
  const locale = body?.locale
  const status = await postAnonymously(
    '/api/v1/newsletter/subscriptions',
    isLocale(locale) ? { email, locale } : { email },
    request,
  )
  if (status === null) return unreachable()
  if (status >= 200 && status < 300) return succeeded(202, 'PENDING_CONFIRMATION')
  if (status === 400) return invalidEmail()
  if (status === 429) return rateLimited()
  return upstreamFailed()
}
