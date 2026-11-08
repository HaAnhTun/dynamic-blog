import 'server-only'
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import {
  accessCookieName,
  clearMfaChallengeCookie,
  clearSessionCookies,
  readSessionTokens,
  setSessionCookies,
} from './auth-cookies'
import { clientIp } from './client-ip'
import { allowSecurityAttempt, securityRetryAfter } from './rate-limit'
import { payloadTooLarge, readSmallBody } from './read-small-body'
import { assertSameOriginRequest } from './same-origin'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * The route handlers of the Security page (`/admin/security/*`): the changes a signed-in account makes to its own two-step
 * verification and password. They are JSON `fetch` calls from client components (`proxy.ts` answers 403 to a plain form post), and
 * they exist because a mutation may hand back a NEW session (the backend ends every session and reissues the caller's), which only a
 * route handler can put into the cookies.
 *
 * In this order:
 *   1. same origin and `application/json` (403/415);
 *   2. this IP's `security` bucket (429 with Retry-After): lib/rate-limit.ts;
 *   3. the access token of the request (`cookies()`: it sees the pair `proxy.ts` has just rotated, `request.cookies` would not);
 *   4. the body, at most 4 KB (413) and an object whose fields the call accepts (400);
 *   5. the backend, with the Bearer.
 *
 * The page gets `{ ok: true, ...}` or `{ error, code, ... }` with the sentence already in the admin's language. A 401 from the backend
 * is read BEFORE it is taken for an expired session: a wrong code or an old sign-in (`REAUTHENTICATION_REQUIRED`) must leave the
 * cookies alone and answer `reauthenticate: true`, so that the page offers "sign in again" instead of signing the person out.
 *
 * The tokens of a reissued session go into the cookies and never into the body. Nothing is logged: codes, passwords and recovery codes
 * only ever sit in local variables.
 */

const PRIVATE_NO_STORE = 'private, no-store'
const BODY_LIMIT = 4 * 1024
const TIMEOUT_MS = 20_000

/** Read at call time, not at module load: changing the env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

type Json = Record<string, unknown>

export type SecurityCall = {
  /** The backend path, for example `/api/v1/me/mfa/enroll/begin`. */
  path: string
  method: 'POST' | 'DELETE'
  /** The body the backend gets, from the page's JSON; null refuses the request with 400. */
  body: (input: Json) => Json | null
  /** Whether the backend answers a NEW session (a token pair) that replaces the caller's, which the route puts in the cookies. */
  reissues: boolean
  /** The `{ ok: true, ... }` fields for the page, from the backend's `data`; null means the answer broke the contract. */
  reply: (data: Json) => Json | null
}

function json(body: Json, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': PRIVATE_NO_STORE, ...extra } })
}

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

/** A string field of `input`, 1 to `max` characters; undefined when absent or empty, null when it is not a string or too long. */
export function textField(
  input: Json,
  name: string,
  max: number,
  { trim = true }: { trim?: boolean } = {},
): string | undefined | null {
  const value = input[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const text = trim ? value.trim() : value
  if (text.trim() === '') return undefined
  return text.length > max ? null : text
}

type FieldRule = {
  required: boolean
  max: number
  /** Passwords keep their spaces; codes are trimmed. Default true. */ trim?: boolean
}

/**
 * The `body` of a call from a table of the fields it accepts: each is a string within `max` characters, required or optional. Anything
 * else the page sent is dropped, so a field the backend does not know cannot be smuggled through; a missing required field, a field of
 * another type or a too long one refuses the request (400) before the backend is called.
 */
export function bodyOf(rules: Record<string, FieldRule>): SecurityCall['body'] {
  return (input) => {
    const out: Json = {}
    for (const [name, rule] of Object.entries(rules)) {
      const value = textField(input, name, rule.max, { trim: rule.trim ?? true })
      if (value === null || (value === undefined && rule.required)) return null
      if (value !== undefined) out[name] = value
    }
    return out
  }
}

/** The new secret of a begin call: the key to type and the link to open, once. */
export const secretReply: SecurityCall['reply'] = (data) => {
  const { secretBase32, otpauthUri, issuer, account } = data
  if (typeof secretBase32 !== 'string' || typeof otpauthUri !== 'string') return null
  return {
    secret: {
      secretBase32,
      otpauthUri,
      issuer: typeof issuer === 'string' ? issuer : '',
      account: typeof account === 'string' ? account : '',
    },
  }
}

/** Ten new recovery codes, shown once. */
export const recoveryCodesReply: SecurityCall['reply'] = (data) => {
  const { recoveryCodes } = data
  if (!Array.isArray(recoveryCodes) || recoveryCodes.length === 0 || !recoveryCodes.every((code) => typeof code === 'string'))
    return null
  return { recoveryCodes }
}

/** A call whose answer is the new session and nothing else the page needs. */
export const nothingReply: SecurityCall['reply'] = () => ({})

/** The 429 of this route's own bucket or of the backend: the wait in the sentence and in Retry-After when it is known. */
async function wait(seconds: number | null, code: string): Promise<NextResponse> {
  const t = await getTranslations('Admin.security.errors')
  if (seconds === null) return json({ error: t('busy'), code }, 429)
  const wanted = Math.max(1, seconds)
  return json({ error: t('tooMany', { minutes: Math.ceil(wanted / 60) }), code, retryAfter: wanted }, 429, {
    'retry-after': String(wanted),
  })
}

/** The sentence for a refused new password, from the stable message the backend gives (`newPassword: <reason>`), never its text. */
async function passwordSentence(message: string): Promise<string> {
  const t = await getTranslations('Admin.security')
  if (/too common or too easy to guess/.test(message)) return t('password.weak')
  if (/different from the current password/.test(message)) return t('password.same')
  return t('errors.invalid')
}

/** The answer for a refusal by the backend. Only a code and a translated sentence go out. */
async function refusal(upstream: Response): Promise<NextResponse> {
  const t = await getTranslations('Admin.security')
  const body = asRecord(await upstream.json().catch(() => null))
  const error = asRecord(body?.error)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = typeof error?.message === 'string' ? error.message : ''
  const details = asRecord(error?.details)

  switch (code) {
    case 'REAUTHENTICATION_REQUIRED':
      // The session is alive, only too old for this change: the cookies stay.
      return json({ error: t('reauth'), code, reauthenticate: true }, 401)
    case 'MFA_CODE_INVALID':
      return json({ error: t('errors.codeInvalid'), code }, 401)
    case 'INVALID_CREDENTIALS':
      return json({ error: t('errors.passwordInvalid'), code }, 401)
    case 'MFA_FROZEN':
      return json({ error: t('errors.frozen'), code }, 403)
    case 'MFA_REQUIRED':
      // An administrator asking to turn two-step verification off.
      return json({ error: t('adminRequired'), code }, 403)
    case 'PASSWORD_MANAGED_BY_ENVIRONMENT':
      return json({ error: t('password.managedByEnvironment'), code }, 409)
    case 'MFA_RATE_LIMITED':
    case 'RATE_LIMITED': {
      const seconds = details?.retryAfterSeconds
      return wait(typeof seconds === 'number' && seconds > 0 ? seconds : null, code)
    }
    case 'VALIDATION_ERROR':
      return json({ error: await passwordSentence(message), code }, 400)
    case 'FORBIDDEN':
      return json({ error: t('errors.forbidden'), code }, 403)
  }
  if (upstream.status === 401)
    return json({ error: t('errors.sessionExpired'), code: code ?? 'UNAUTHENTICATED', sessionExpired: true }, 401)
  if (upstream.status === 403) return json({ error: t('errors.forbidden'), code: code ?? 'FORBIDDEN' }, 403)
  if (upstream.status === 429) return wait(null, 'RATE_LIMITED')
  return json({ error: t('errors.failed'), code: code ?? 'FAILED' }, 502)
}

/** The checks every call of this page starts with; returns the refusal, or the token and what the caller needs. */
async function admit(request: Request): Promise<Response | { token: string; ip: string | null }> {
  const refused = assertSameOriginRequest(request)
  if (refused) return refused

  const ip = clientIp(request)
  if (!allowSecurityAttempt(ip)) {
    const seconds = Math.max(1, securityRetryAfter(ip))
    return wait(seconds, 'RATE_LIMITED')
  }

  const token = (await cookies()).get(accessCookieName())?.value
  if (!token) {
    const t = await getTranslations('Admin.security.errors')
    return json({ error: t('sessionExpired'), code: 'UNAUTHENTICATED', sessionExpired: true }, 401)
  }
  return { token, ip }
}

async function unreachable(): Promise<NextResponse> {
  const t = await getTranslations('Admin.security.errors')
  return json({ error: t('unreachable'), code: 'UNREACHABLE' }, 502)
}

export async function runSecurityCall(request: Request, call: SecurityCall): Promise<Response> {
  const admitted = await admit(request)
  if (admitted instanceof Response) return admitted

  const text = await readSmallBody(request, BODY_LIMIT)
  if (text === null) return payloadTooLarge()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }
  const input = asRecord(parsed)
  const body = input === null ? null : call.body(input)
  if (body === null) return json({ error: 'Invalid request' }, 400)

  let upstream: Response
  try {
    upstream = await fetch(`${apiBase()}${call.path}`, {
      method: call.method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${admitted.token}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return unreachable()
  }

  if (!upstream.ok) return refusal(upstream)

  const data = asRecord(asRecord(await upstream.json().catch(() => null))?.data)
  const fields = data === null ? null : call.reply(data)
  if (data === null || fields === null) {
    const t = await getTranslations('Admin.security.errors')
    return json({ error: t('failed'), code: 'UNUSABLE' }, 502)
  }

  const response = json({ ok: true, ...fields }, 200)
  if (call.reissues) {
    const tokens = readSessionTokens(data)
    if (tokens === null) {
      // The backend changed the account and ended every session, but the new one did not arrive: this browser holds a dead pair.
      const t = await getTranslations('Admin.security.errors')
      return json({ error: t('sessionExpired'), code: 'UNUSABLE', sessionExpired: true }, 502)
    }
    setSessionCookies(response, tokens)
  }
  return response
}

/**
 * "Sign out everywhere": the existing `POST /auth/sessions/revoke-all`, which ends every session of the account, this one included
 * (204), then both session cookies are cleared and the page is told where to go. A session that is already dead at the backend (401)
 * is the same outcome and clears the cookies too. A backend that does not answer keeps the cookies: the person is still signed in
 * and can try again.
 */
export async function signOutEverywhere(request: Request): Promise<Response> {
  const admitted = await admit(request)
  if (admitted instanceof Response) return admitted

  let upstream: Response
  try {
    upstream = await fetch(`${apiBase()}/api/v1/auth/sessions/revoke-all`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admitted.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return unreachable()
  }
  await upstream.body?.cancel()

  if (!upstream.ok && upstream.status !== 401) {
    const t = await getTranslations('Admin.security.errors')
    return json({ error: t('failed'), code: 'FAILED' }, 502)
  }
  const response = json({ ok: true, next: '/admin/login' }, 200)
  clearSessionCookies(response)
  clearMfaChallengeCookie(response)
  return response
}
