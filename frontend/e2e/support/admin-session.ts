import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Cookie } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_URL, BASE_URL } from './env'
import {
  AUTH_DIR,
  RECOVERY_CODES_WANTED,
  freshAdminCode,
  recoveryCodesLeft,
  replaceRecoveryCodes,
  takeRecoveryCode,
} from './mfa-state'
import { ACCESS_COOKIE, REFRESH_COOKIE } from './session-cookies'

/**
 * The administrator's sessions, which the whole suite shares.
 *
 * The administrator cannot sign in with a password alone any more (two-step verification is mandatory), and a TOTP code works once
 * per 30 second period (replay protection), so a suite of dozens of admin pages cannot sign in again for each one. Instead it holds
 * two sessions, made once by the global setup (e2e/global-setup.ts) and kept in `e2e/.auth/`:
 *
 * - `admin-session.json`, in Playwright's storageState shape: the pair that browser contexts are given (`loginAsAdmin`);
 * - `admin-api-session.json`: the pair of `support/backend.ts`, which calls the API directly.
 *
 * They are separate sessions, so that a context that rotates its refresh token never breaks the other. A pair is used as it is while its
 * access token has minutes left and the backend still knows the session; when it is close to its end it is refreshed through
 * `POST /auth/refresh`, which the app itself calls (and the new pair is written back, because a refresh token works once: reusing a
 * rotated one later ends every session of the account, which is the backend's theft defence); when the session is gone (a spec that
 * changed the password or signed out everywhere) the administrator signs in again through the API with a recovery code, or a fresh
 * authenticator code when few recovery codes are left.
 *
 * Calls go to the backend directly with Node's `fetch`, the way support/backend.ts does: they are setup, not the thing under test.
 */

export const SESSION_FILE = join(AUTH_DIR, 'admin-session.json')
export const API_SESSION_FILE = join(AUTH_DIR, 'admin-api-session.json')

export type Pair = { accessToken: string; refreshToken: string }

/** Below this many recovery codes the sign-in uses an authenticator code, so that the codes last for the specs that need them. */
const KEEP_RECOVERY_CODES = 3
/** A pair whose access token has less than this many seconds left is refreshed before it is handed out. */
const MIN_SECONDS_LEFT = 300

const REFRESH_COOKIE_SECONDS = 30 * 24 * 60 * 60

// --- Talking to the backend ---------------------------------------------------------------------

type Reply = { status: number; body: { data?: Record<string, unknown>; error?: { code?: string } } | null }

async function post(path: string, body: unknown, accessToken?: string): Promise<Reply> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as Reply['body'] }
}

function pairOf(data: Record<string, unknown> | undefined): Pair | null {
  const accessToken = data?.accessToken
  const refreshToken = data?.refreshToken
  return typeof accessToken === 'string' && typeof refreshToken === 'string' ? { accessToken, refreshToken } : null
}

/** The seconds an access token still lives, from its `exp` claim (read without checking the signature). */
export function secondsLeft(accessToken: string): number {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp - Date.now() / 1000 : 0
  } catch {
    return 0
  }
}

/** Whether the backend still knows this session (an access token whose session was revoked is refused before it expires). */
async function isAlive(accessToken: string): Promise<boolean> {
  const response = await fetch(`${API_URL}/api/v1/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } })
  await response.body?.cancel()
  return response.status === 200
}

/** A new pair for a refresh token, or null when the backend refuses it (revoked, expired, the session ended). */
async function refresh(refreshToken: string): Promise<Pair | null> {
  const { status, body } = await post('/api/v1/auth/refresh', { refreshToken })
  if (status === 200) return pairOf(body?.data)
  if (status === 401 || status === 403) return null
  throw new Error(`POST /auth/refresh answered HTTP ${status}`)
}

/**
 * The administrator signs in through the API: password, then the second step. `how` chooses the proof: a recovery code (kept for
 * sign-ins that must not wait for a period) or a fresh authenticator code. Never prints a code or a token.
 */
export async function signInViaApi(
  how: 'recovery' | 'totp' = recoveryCodesLeft() >= KEEP_RECOVERY_CODES ? 'recovery' : 'totp',
): Promise<Pair> {
  const login = await post('/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  const challenge = login.body?.data?.challenge
  if (login.status !== 202 || typeof challenge !== 'string' || login.body?.data?.purpose !== 'VERIFY') {
    throw new Error(
      `The administrator's password sign-in answered HTTP ${login.status}${login.body?.data?.purpose === 'ENROLL' ? ' and asks to enroll an authenticator (run scripts/e2e-bootstrap.mjs)' : ''}.`,
    )
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = (how === 'recovery' && attempt === 0 ? takeRecoveryCode() : null) ?? (await freshAdminCode())
    const verify = await post('/api/v1/auth/mfa/verify', { challenge, code })
    const pair = verify.status === 200 ? pairOf(verify.body?.data) : null
    if (pair !== null) return pair
    // A code refused for being wrong: the file was a period behind the stack, so the next period's code is tried once.
    if (verify.body?.error?.code !== 'MFA_CODE_INVALID') {
      throw new Error(`POST /auth/mfa/verify answered HTTP ${verify.status} ${verify.body?.error?.code ?? ''}`.trim())
    }
  }
  throw new Error(
    "The administrator's second step was refused twice (a wrong code, or the stack's authenticator is not the one in e2e/.auth/admin-mfa.json).",
  )
}

/** A session kept for the role changes of a run: the backend wants a sign-in from the last 10 minutes, this one is reused for 8. */
let roleChangeSession: { pair: Pair; signedInAt: number } | null = null
const ROLE_CHANGE_SESSION_MS = 8 * 60_000

/**
 * What a role change asks for (audit 111): a session that signed in minutes ago, and a code of the administrator's own. The shared
 * sessions of the suite are older than that, so one more session is made (and kept for 8 minutes, for the next change), and the proof
 * is a recovery code, which waits for no 30 second period; when few are left, new ones are made with this very session.
 */
export async function roleChangeProof(): Promise<{ accessToken: string; code: string }> {
  if (roleChangeSession === null || Date.now() - roleChangeSession.signedInAt > ROLE_CHANGE_SESSION_MS) {
    roleChangeSession = { pair: await signInViaApi(), signedInAt: Date.now() }
  }
  const { accessToken } = roleChangeSession.pair
  if (recoveryCodesLeft() < 2) await ensureRecoveryCodes(accessToken)
  return { accessToken, code: takeRecoveryCode() ?? (await freshAdminCode()) }
}

/**
 * Makes ten new recovery codes when fewer than a full run needs are on record (`RECOVERY_CODES_WANTED`): the specs that sign in with a
 * recovery code burn them, and a run that starts short would end in the middle. Needs a session that signed in minutes ago (the
 * change needs a recent sign-in), which is what the global setup has just made; a recovery code is the proof, so no period is waited for.
 */
export async function ensureRecoveryCodes(accessToken: string): Promise<void> {
  if (recoveryCodesLeft() >= RECOVERY_CODES_WANTED) return
  const proof = takeRecoveryCode() ?? (await freshAdminCode())
  const { status, body } = await post(
    '/api/v1/me/mfa/recovery-codes/regenerate',
    { code: proof, currentPassword: ADMIN_PASSWORD },
    accessToken,
  )
  const codes = body?.data?.recoveryCodes
  if (status !== 200 || !Array.isArray(codes)) {
    throw new Error(`New recovery codes could not be made: HTTP ${status} ${body?.error?.code ?? ''}`.trim())
  }
  replaceRecoveryCodes(codes.map(String))
}

// --- The two stored pairs ------------------------------------------------------------------------

type StorageState = { cookies: Cookie[]; origins: unknown[] }

/** The cookies a browser context is given for a pair: what lib/auth-cookies.ts sets (httpOnly, Secure, Lax, Path=/). */
export function sessionCookies(pair: Pair): Cookie[] {
  const domain = new URL(BASE_URL).hostname
  const common = { domain, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const }
  return [
    { name: ACCESS_COOKIE, value: pair.accessToken, expires: -1, ...common },
    {
      name: REFRESH_COOKIE,
      value: pair.refreshToken,
      expires: Math.floor(Date.now() / 1000) + REFRESH_COOKIE_SECONDS,
      ...common,
    },
  ]
}

/** The pair in a list of cookies (a context's `cookies()`), or null when either is missing. */
export function pairFromCookies(cookies: readonly Cookie[]): Pair | null {
  const accessToken = cookies.find((cookie) => cookie.name === ACCESS_COOKIE)?.value
  const refreshToken = cookies.find((cookie) => cookie.name === REFRESH_COOKIE)?.value
  return accessToken && refreshToken ? { accessToken, refreshToken } : null
}

function writeFileAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
}

function read(kind: 'browser' | 'api'): Pair | null {
  const file = kind === 'browser' ? SESSION_FILE : API_SESSION_FILE
  if (!existsSync(file)) return null
  const stored = JSON.parse(readFileSync(file, 'utf8')) as StorageState | Partial<Pair>
  return 'cookies' in stored
    ? pairFromCookies(stored.cookies)
    : stored.accessToken && stored.refreshToken
      ? (stored as Pair)
      : null
}

function write(kind: 'browser' | 'api', pair: Pair): void {
  if (kind === 'browser') {
    const state: StorageState = { cookies: sessionCookies(pair), origins: [] }
    writeFileAtomically(SESSION_FILE, `${JSON.stringify(state, null, 2)}\n`)
  } else {
    writeFileAtomically(API_SESSION_FILE, `${JSON.stringify(pair, null, 2)}\n`)
  }
}

/** Stores a pair that a test or the global setup obtained (for example the cookies of the form sign-in). */
export function saveAdminPair(kind: 'browser' | 'api', pair: Pair): void {
  write(kind, pair)
}

/**
 * A pair of this kind that works now: the stored one when the backend knows its session and its access token has minutes left; its
 * refresh when the session is alive but the token is near its end (or has run out); a new sign-in when the session has ended. `force`
 * skips the first step (a caller that was just refused with 401 knows the stored access token is no good).
 */
export async function liveAdminPair(kind: 'browser' | 'api', { force = false }: { force?: boolean } = {}): Promise<Pair> {
  const stored = read(kind)
  if (stored !== null) {
    const left = secondsLeft(stored.accessToken)
    // An access token with time left that the backend refuses belongs to a session that ended. Its refresh token is revoked, and
    // presenting a revoked refresh token again is taken for theft, which ends every session of the account (the other stored pair
    // included): so only a live session, or a token that merely ran out, is refreshed.
    const alive = left > 0 && (await isAlive(stored.accessToken))
    if (alive && !force && left > MIN_SECONDS_LEFT) return stored
    if (alive || left <= 0) {
      const refreshed = await refresh(stored.refreshToken)
      if (refreshed !== null) {
        write(kind, refreshed)
        return refreshed
      }
    }
  }
  const fresh = await signInViaApi()
  write(kind, fresh)
  return fresh
}

/** The access token of the API administrator (support/backend.ts). */
export async function adminAccessToken(options: { force?: boolean } = {}): Promise<string> {
  return (await liveAdminPair('api', options)).accessToken
}

/**
 * Both stored sessions are alive again. For a spec that ended the administrator's sessions (a password change, "Sign out everywhere"):
 * call it in `finally`, so the specs after it do not pay for it one by one. A no-op when they are alive.
 */
export async function restoreAdminSession(): Promise<void> {
  await liveAdminPair('browser')
  await liveAdminPair('api')
}
