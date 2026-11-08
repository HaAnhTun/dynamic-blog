import 'server-only'
import { createHash } from 'node:crypto'
import { readSessionTokens } from './auth-cookies'
import { clientIpHeaders } from './client-ip'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * Session refresh for route handlers OUTSIDE /admin. proxy.ts still matches only
 * /admin and keeps its own refresh code; Server Components never refresh.
 *
 * Four outcomes, and each tells the caller what to do with the cookie:
 *   - ok:          use the new pair, set both cookies on the final response.
 *   - revoked:     REFRESH_TOKEN_REVOKED — almost certainly lost a rotation race with another
 *                  request carrying the same token. Do NOT clear the cookie: the winner's response is setting
 *                  the new pair, clearing here would overwrite it and sign the reader out.
 *   - rejected:    any other 4xx (INVALID, EXPIRED, USER_SUSPENDED): the session is really dead, clear the cookie.
 *   - unavailable: network error, timeout, 5xx: keep the cookie, retry next time.
 *
 * Single-flight and memo, keyed by the sha256 of the token (the raw token is not kept as a key):
 *   - While the backend call is in flight, everyone presenting the same token waits for it and gets the same answer: a few
 *     requests that arrive together (a page load fires several) get EXACTLY one new pair instead of each rotating by itself
 *     and all but one getting REVOKED.
 *   - A new pair is NOT kept after the call resolves (audit 078). From then on the token is revoked, and the answer for
 *     whoever presents it later is the one the backend gives (REVOKED, a lost rotation race within its reuse grace period):
 *     the pair went to the browser in the response of the request that won. Handing it out again would give the whole session
 *     to anyone presenting the retired token, which the backend itself refuses, and would hide a replayed token from its reuse
 *     detection. The retired token is remembered as revoked for 60 seconds, so it does not hit the backend on every request.
 *   - revoked/rejected are remembered for 60 seconds, so a dead token does not hit the backend on every request.
 *   - unavailable is not remembered.
 *
 * The memo is module state: one copy per server bundle, per instance. Correctness does NOT depend on
 * sharing it (with proxy.ts, with other routes, or across instances): the request that loses the race gets
 * revoked, leaves the cookie alone, and continues as anonymous (optional) or returns 401 (required).
 */

export type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; refreshToken: string; refreshExpiresIn?: number }
  | { kind: 'revoked' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

const DEAD_TTL_MS = 60_000
const MAX_ENTRIES = 1_000
const TIMEOUT_MS = 10_000

/** `settled` is what a caller arriving after the call resolved gets; the callers that waited for it get `promise`. */
type Entry = { promise: Promise<RefreshOutcome>; settled: RefreshOutcome | null; expiresAt: number }

const memo = new Map<string, Entry>()

/** Read at call time, not at module load: changing the env needs no rebuild, and tests can change it. */
function apiBase(): string {
  return apiBaseUrl()
}

function keyOf(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url')
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  return typeof body?.error?.code === 'string' ? body.error.code : undefined
}

/** Never rejects: every error becomes `unavailable`. */
async function callRefresh(refreshToken: string, clientIp: string | null): Promise<RefreshOutcome> {
  let res: Response
  try {
    res = await fetch(`${apiBase()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...clientIpHeaders(clientIp) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { kind: 'unavailable' }
  }

  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null
    const rotated = readSessionTokens(body?.data)
    if (rotated !== null) return { kind: 'ok', ...rotated }
    // Off the contract: we do not know whether the old token was rotated, so the cookie is not cleared because of it.
    return { kind: 'unavailable' }
  }

  // A 408/429 from a proxy in between means "retry later", not "the session is dead".
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    await res.body?.cancel()
    return { kind: 'unavailable' }
  }
  return (await errorCode(res)) === 'REFRESH_TOKEN_REVOKED' ? { kind: 'revoked' } : { kind: 'rejected' }
}

/** Drops expired entries, then the oldest entry (insertion order) until there is room for a new one. */
function prune(now: number): void {
  for (const [key, entry] of memo) {
    if (entry.expiresAt <= now) memo.delete(key)
  }
  while (memo.size >= MAX_ENTRIES) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
}

/**
 * `clientIp` is the visitor's address (lib/client-ip.ts, `null` when unknown): the backend counts refreshes per address. It
 * only matters for the call that actually reaches the backend; callers sharing one in-flight call share its address.
 */
export async function refreshSession(refreshToken: string, clientIp: string | null = null): Promise<RefreshOutcome> {
  const key = keyOf(refreshToken)
  const now = Date.now()
  const hit = memo.get(key)
  if (hit !== undefined && hit.expiresAt > now) return hit.settled ?? hit.promise

  // While in flight it does not expire: everyone calling with the same token waits on one shared backend call.
  const entry: Entry = {
    promise: Promise.resolve({ kind: 'unavailable' }),
    settled: null,
    expiresAt: Number.POSITIVE_INFINITY,
  }
  entry.promise = callRefresh(refreshToken, clientIp).then((outcome) => {
    if (outcome.kind === 'unavailable') {
      if (memo.get(key) === entry) memo.delete(key)
    } else {
      // A rotated pair is handed to the callers that were waiting and to nobody after them: the token is revoked now.
      entry.settled = outcome.kind === 'ok' ? { kind: 'revoked' } : outcome
      entry.expiresAt = Date.now() + DEAD_TTL_MS
    }
    return outcome
  })

  memo.delete(key)
  prune(now)
  memo.set(key, entry)
  return entry.promise
}
