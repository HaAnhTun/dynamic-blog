import type { NextRequest } from 'next/server'
import { isLocale } from '@/i18n/config'
import { CONTACT_EMAIL_SHAPE, CONTACT_LIMITS } from '@/lib/contact-limits'
import { BFF_BODY_LIMIT, payloadTooLarge, readSmallBody } from '@/lib/read-small-body'
import { assertSameOriginRequest } from '@/lib/same-origin'
import { bffError, unreachable } from '@/lib/user-api'
import { allowAttempt, jsonObject, postAnonymously, rateLimited, succeeded, upstreamFailed } from '../newsletter/newsletter-route'

/**
 * POST /api/contact: the form of the Contact section sends `{ name, email, subject, message, website, locale }`. The backend is
 * called as a guest and the answer is a constant: no submitted field is echoed and nothing is logged.
 *
 * `website` is the honeypot, an input people never see. A filled one is answered with the normal success and the backend is not
 * called, so a bot learns nothing from the answer.
 */

const CONTACT_LIMIT_PER_HOUR = 5
const CONTACT_BUCKET = 'contact'

function invalidMessage() {
  return bffError(400, 'VALIDATION_ERROR', 'Invalid contact message')
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : null
}

/** Anything but a missing, null, empty or blank value counts as filled. */
function honeypotFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return typeof value !== 'string' || value.trim() !== ''
}

export async function POST(request: NextRequest): Promise<Response> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused
  const raw = await readSmallBody(request, BFF_BODY_LIMIT)
  if (raw === null) return payloadTooLarge()
  const body = jsonObject(raw)
  if (body === null) return invalidMessage()

  if (honeypotFilled(body.website)) return succeeded(202, 'RECEIVED')

  const name = text(body.name)
  const email = text(body.email)
  const subject = text(body.subject)
  const message = text(body.message)
  if (name === null || email === null || subject === null || message === null) return invalidMessage()
  if (name === '' || name.length > CONTACT_LIMITS.nameMax) return invalidMessage()
  if (email.length > CONTACT_LIMITS.emailMax || !CONTACT_EMAIL_SHAPE.test(email)) return invalidMessage()
  if (subject.length > CONTACT_LIMITS.subjectMax) return invalidMessage()
  if (message.length < CONTACT_LIMITS.messageMin || message.length > CONTACT_LIMITS.messageMax) return invalidMessage()
  if (!allowAttempt(CONTACT_BUCKET, request, CONTACT_LIMIT_PER_HOUR)) return rateLimited()

  // The page locale picks the language of the owner's mail; an unknown value is left out.
  const locale = body.locale
  const payload: Record<string, string> = { name, email, subject, message }
  if (isLocale(locale)) payload.locale = locale
  const status = await postAnonymously('/api/v1/contact/messages', payload, request)
  if (status === null) return unreachable()
  if (status >= 200 && status < 300) return succeeded(202, 'RECEIVED')
  if (status === 400) return invalidMessage()
  if (status === 429) return rateLimited()
  return upstreamFailed()
}
