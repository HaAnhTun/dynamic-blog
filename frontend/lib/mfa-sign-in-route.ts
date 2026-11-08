import 'server-only'
import { getTranslations } from 'next-intl/server'
import { NextResponse } from 'next/server'
import {
  MFA_CHALLENGE_COOKIE,
  clearMfaChallengeCookie,
  readCookie,
  readSessionTokens,
  refreshCookieName,
  setSessionCookies,
} from './auth-cookies'
import { clientIp, clientIpHeaders } from './client-ip'
import { revokeRefreshToken } from './logout'
import { allowMfaAttempt, mfaRetryAfter, resetMfaAttempts } from './rate-limit'
import { payloadTooLarge, readSmallBody } from './read-small-body'
import { assertSameOriginRequest } from './same-origin'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * The shared frame of the three route handlers of the second step of a sign-in: `/admin/login/mfa/submit` (type a code),
 * `/admin/login/enroll/begin` and `/admin/login/enroll/confirm` (set up the authenticator the first time).
 *
 * In this order, so that a refusal never costs more than it must:
 *   1. same origin and `application/json` (403/415): the cookie is Lax, so a cross-site form post could carry it;
 *   2. the challenge cookie (401, the backend is not called): a request without one has no sign-in in progress;
 *   3. this IP's `mfa` bucket (429 with Retry-After, the backend is not called): lib/rate-limit.ts, separate from the password
 *      bucket and only a convenience, the backend's per-account brake is the guarantee;
 *   4. the body, at most 4 KB (413) and one object of strings (400);
 *   5. the backend call, with the visitor's address for its own per-address limit (`mfa-client`).
 *
 * Tokens never reach the body: a step that ends the sign-in puts them in the session cookies and clears the challenge cookie.
 * Nothing is logged here. The challenge, the code and the enrollment code only ever sit in a local variable.
 */

const PRIVATE_NO_STORE = 'private, no-store'
const BODY_LIMIT = 4 * 1024
const TIMEOUT_MS = 15_000
/** The backend's challenge: 256 random bits as base64url. Anything else in the cookie is not forwarded. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

/** Read at call time, not at module load: changing the env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

type Json = Record<string, unknown>

/** What a step tells the route when the backend said yes. */
export type StepSuccess = {
  /** The visitor's address as counted, for clearing the bucket when the sign-in ends. */
  ip: string | null
  /** The request, for reading the refresh cookie that this sign-in replaces. */
  request: Request
}

export type SignInStep = {
  /** The backend path, for example `/api/v1/auth/mfa/verify`. */
  path: string
  /** The body fields this step accepts, taken from the page's JSON; null refuses the request with 400. The challenge is added here. */
  fields: (body: Json) => Record<string, string> | null
  /** The response for a success, built from the backend's `data`; null means the answer broke the contract (502). */
  succeed: (data: Json, context: StepSuccess) => Promise<NextResponse | null> | NextResponse | null
}

function json(body: Json, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': PRIVATE_NO_STORE, ...extra } })
}

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

/** A string field of `body`, trimmed, 1 to `max` characters; undefined when absent or empty, null when it is not a string. */
export function stringField(body: Json, name: string, max: number): string | undefined | null {
  const value = body[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return undefined
  return text.length > max ? null : text
}

/** 429 with the wait in `Retry-After` and in the sentence; without a known wait, the sentence for "a moment". */
async function waitResponse(seconds: number | null, code: string): Promise<NextResponse> {
  const t = await getTranslations('Admin.login.mfa')
  if (seconds === null) return json({ error: t('busy'), code }, 429)
  const wait = Math.max(1, seconds)
  return json({ error: t('tooMany', { minutes: Math.ceil(wait / 60) }), code, retryAfter: wait }, 429, {
    'retry-after': String(wait),
  })
}

/**
 * The page's answer for a refusal by the backend. Only a code and a translated sentence go out: the backend's English message is
 * never shown, and a code is never echoed.
 */
async function refusal(upstream: Response): Promise<NextResponse> {
  const t = await getTranslations('Admin.login')
  const body = asRecord(await upstream.json().catch(() => null))
  const error = asRecord(body?.error)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const details = asRecord(error?.details)

  switch (code) {
    case 'MFA_CHALLENGE_INVALID': {
      const response = json({ error: t('mfa.expired'), code }, 401)
      clearMfaChallengeCookie(response)
      return response
    }
    case 'MFA_CODE_INVALID':
      return json({ error: t('mfa.invalid'), code }, 401)
    case 'ENROLLMENT_CODE_INVALID':
      return json({ error: t('enroll.codeInvalid'), code }, 403)
    case 'MFA_FROZEN':
      return json({ error: t('mfa.frozen'), code }, 403)
    case 'MFA_RATE_LIMITED':
    case 'RATE_LIMITED': {
      const seconds = details?.retryAfterSeconds
      return waitResponse(typeof seconds === 'number' && seconds > 0 ? seconds : null, code)
    }
  }
  if (upstream.status === 429) return waitResponse(null, 'RATE_LIMITED')
  if (upstream.status === 503) return json({ error: t('backendUnavailable'), code: code ?? 'UNAVAILABLE' }, 503)
  return json({ error: t('failed'), code: code ?? 'FAILED' }, 502)
}

/**
 * Ends a sign-in: the session cookies from the backend's token pair, the challenge cookie cleared, this IP's second-step attempts
 * forgotten, and the refresh token this browser held before revoked at the backend (it is about to be overwritten, so otherwise it
 * would live on for 30 days with nobody holding it). `payload` is the body of the page's answer, never the tokens.
 * Null when the backend's answer carries no usable pair.
 */
export async function finishSignIn(data: Json, payload: Json, context: StepSuccess): Promise<NextResponse | null> {
  const tokens = readSessionTokens(data)
  if (tokens === null) return null

  resetMfaAttempts(context.ip)
  const previous = readCookie(context.request, refreshCookieName())
  if (previous && previous !== tokens.refreshToken) await revokeRefreshToken(previous)

  const response = json({ ok: true, ...payload }, 200)
  setSessionCookies(response, tokens)
  clearMfaChallengeCookie(response)
  return response
}

export async function runSignInStep(request: Request, step: SignInStep): Promise<Response> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused

  const t = await getTranslations('Admin.login')
  const rawChallenge = readCookie(request, MFA_CHALLENGE_COOKIE)
  if (rawChallenge === undefined || !CHALLENGE_SHAPE.test(rawChallenge)) {
    return json({ error: t('mfa.expired'), code: 'MFA_CHALLENGE_INVALID' }, 401)
  }

  const ip = clientIp(request)
  if (!allowMfaAttempt(ip)) {
    const seconds = Math.max(1, mfaRetryAfter(ip))
    return json(
      { error: t('mfa.tooMany', { minutes: Math.ceil(seconds / 60) }), code: 'RATE_LIMITED', retryAfter: seconds },
      429,
      { 'retry-after': String(seconds) },
    )
  }

  const text = await readSmallBody(request, BODY_LIMIT)
  if (text === null) return payloadTooLarge()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }
  const body = asRecord(parsed)
  const fields = body === null ? null : step.fields(body)
  if (fields === null) return json({ error: 'Invalid request' }, 400)

  let upstream: Response
  try {
    upstream = await fetch(`${apiBase()}${step.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...clientIpHeaders(ip) },
      body: JSON.stringify({ challenge: rawChallenge, ...fields }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // "The API is not answering", which is what a developer sees when the backend is not started.
    return json({ error: t('apiUnreachable'), code: 'UNREACHABLE' }, 502)
  }

  if (!upstream.ok) return refusal(upstream)

  const data = asRecord(asRecord(await upstream.json().catch(() => null))?.data)
  const answer = data === null ? null : await step.succeed(data, { ip, request })
  return answer ?? json({ error: t('unusableSession'), code: 'UNUSABLE' }, 502)
}
