import { NextResponse } from 'next/server'
import { clientIp } from '@/lib/client-ip'
import { rateLimit, retryAfterSeconds } from '@/lib/rate-limit'
import { BFF_BODY_LIMIT, payloadTooLarge, readSmallBody } from '@/lib/read-small-body'
import { assertSameOriginRequest } from '@/lib/same-origin'
import { postSetup, type SetupErrorCode } from '@/lib/setup-api'

const PRIVATE_NO_STORE = 'private, no-store'
const SETUP_BUCKET = 'setup'
const SETUP_LIMIT = 10
const SETUP_WINDOW_MS = 10 * 60_000

const MAX_CODE = 256
const MAX_EMAIL = 120
const MIN_PASSWORD = 12
const MAX_PASSWORD = 128
const MAX_NAME = 60

function failure(code: SetupErrorCode, status: number, extra: Record<string, string> = {}): Response {
  return NextResponse.json({ ok: false, error: code }, { status, headers: { 'cache-control': PRIVATE_NO_STORE, ...extra } })
}

function within(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

/**
 * First-run setup: the form posts here, never to the backend directly. No body, setup code or password is logged, and the
 * backend's own message is never forwarded: the answer is `{ ok: true }` or `{ ok: false, error: <stable code> }`.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused

  const ip = clientIp(request)
  // The unknown-address key gets the allowance of one address as well (issue 017), not the wider default.
  if (!rateLimit(SETUP_BUCKET, ip, SETUP_LIMIT, SETUP_WINDOW_MS, SETUP_LIMIT)) {
    return failure('RATE_LIMITED', 429, { 'retry-after': String(Math.max(1, retryAfterSeconds(SETUP_BUCKET, ip))) })
  }

  const raw = await readSmallBody(request, BFF_BODY_LIMIT)
  if (raw === null) return payloadTooLarge()
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return failure('VALIDATION_ERROR', 400)
    body = parsed as Record<string, unknown>
  } catch {
    return failure('VALIDATION_ERROR', 400)
  }

  const { setupCode, email, password, displayName } = body
  if (
    !within(setupCode, 1, MAX_CODE) ||
    !within(email, 3, MAX_EMAIL) ||
    !within(password, MIN_PASSWORD, MAX_PASSWORD) ||
    !within(displayName, 1, MAX_NAME)
  ) {
    return failure('VALIDATION_ERROR', 400)
  }

  const result = await postSetup({ setupCode, email, password, displayName }, ip)
  if (!result.ok) return failure(result.code, result.status)
  return NextResponse.json({ ok: true }, { headers: { 'cache-control': PRIVATE_NO_STORE } })
}
