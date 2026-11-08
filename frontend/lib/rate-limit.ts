import 'server-only'
import { createHash } from 'node:crypto'
import { clientIp } from './client-ip'

/**
 * Rate limit per IP, in process memory: the number of GitHub sign-in attempts, and also the admin password sign-in
 * and the view-count beacon (app/api/views).
 *
 * A fixed window per key: `{count, resetAt}`. Every bucket has a table of its own (a Map, which keeps insertion order), so a
 * flood of keys in one bucket (view beacons, search suggestions, CSP reports: anonymous calls that add a key per address) can
 * never push a running counter of another one out, the sign-in counters above all (issue 027). Within a table a window length
 * is the same for every key, so insertion order is expiry order and the first entry is the one that ends first: when the
 * table is full that one is dropped, and a NEW key is always served, never refused (the owner's sign-in must not depend on how
 * many addresses a crowd can invent; the backend's matching buckets evict the stalest key for the same reason, issue 115). The raw
 * IP is not stored (the key is a sha256), it is lost on restart, one copy per instance (the README says so: run one
 * instance, or accept a looser limit).
 */

const MAX_ENTRIES = 10_000
/** A full scan for expired keys, when the table is full and its first entry is still counting, runs at most this often. */
const SWEEP_INTERVAL_MS = 1_000

/**
 * Unknown IP (missing X-Forwarded-For, a list shorter than the hop count, or the chosen entry is not
 * an IP address — lib/client-ip.ts): all such requests share one key per bucket with a wider
 * limit. Fail soft, not fail open: no IP does not mean no limit. The buckets that guard a credential (the admin sign-in, the
 * second step, the Security page, GitHub sign-in, the first-run setup) pass their own per-IP limit instead, so a caller
 * who makes the address unreadable gets one caller's allowance in all, not ten times as much (issue 017).
 */
const UNKNOWN_LIMIT = 100
const UNKNOWN_WINDOW_MS = 10 * 60_000

/** start and callback count into one shared bucket. */
export const OAUTH_LIMIT = 20
export const OAUTH_WINDOW_MS = 10 * 60_000

/**
 * Admin password sign-in (/admin/login/submit). Every attempt counts, not only wrong ones:
 * the route blocks before knowing whether the password is right or wrong, that is before the backend spends an Argon2 hash.
 * On a successful sign-in the counter of that IP is cleared (resetLoginAttempts), so a site owner who mistypes a few times and
 * then gets it right does not have to wait.
 */
export const LOGIN_LIMIT = 10
export const LOGIN_WINDOW_MS = 10 * 60_000
const LOGIN_BUCKET = 'login'

/**
 * The second step of a sign-in (/admin/login/mfa/submit and /admin/login/enroll/*), a bucket of its own: ten password attempts
 * must not use up the codes of the person who got the password right, and the other way round. Every call counts, wrong or right
 * (begin, confirm and verify share it), and the final success of a sign-in clears it (resetMfaAttempts).
 *
 * Only a convenience against one source. The guarantee against guessing a code is the backend's per-account brake (reserve, then
 * verify; a delay after the fifth miss; a freeze at the hundredth), which an attacker cannot get around by changing address.
 */
export const MFA_LIMIT = 10
export const MFA_WINDOW_MS = 10 * 60_000
const MFA_BUCKET = 'mfa'

/**
 * The Security page of a signed-in account (/admin/security/*): a bucket of its own, 20 per 10 minutes per IP, every call counted.
 * A person changing their settings makes a handful of calls; this only stops one source from spending the backend's Argon2 hashes
 * and code checks. The per-account brakes (a delay after five wrong codes, five password changes per 10 minutes) are the backend's.
 */
export const SECURITY_LIMIT = 20
export const SECURITY_WINDOW_MS = 10 * 60_000
const SECURITY_BUCKET = 'security'

type Window = { count: number; resetAt: number }
type Table = { windows: Map<string, Window>; sweptAt: number }

const tables = new Map<string, Table>()

function tableOf(bucket: string): Table {
  let table = tables.get(bucket)
  if (table === undefined) {
    table = { windows: new Map(), sweptAt: 0 }
    tables.set(bucket, table)
  }
  return table
}

function keyOf(bucket: string, ip: string): string {
  return `${bucket}|${createHash('sha256').update(rateLimitSubject(ip)).digest('base64url')}`
}

/**
 * What is counted for an IP. IPv4 is the address itself. IPv6 is the whole /64 containing it: ISPs and VPS providers hand
 * out a whole /64 to one customer, so counting per address would give unlimited new hits just by changing the last 64 bits.
 * In exchange, machines in the same /64 (one household) share the limit, like behind an IPv4 NAT.
 * An IPv4 embedded as `::ffff:a.b.c.d` counts as IPv4. A string that cannot be parsed is kept as is (clientIp already filtered
 * everything that is not an IP; what is left is only keys set by tests or by code calling directly).
 */
export function rateLimitSubject(ip: string): string {
  const address = (ip.split('%')[0] ?? '').toLowerCase()
  if (!address.includes(':')) return address
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)
  if (mapped?.[1]) return mapped[1]
  const groups = ipv6Groups(address)
  return groups === null ? address : `${groups.slice(0, 4).join(':')}::/64`
}

/** The eight 16-bit groups of an IPv6 (already lower case), in hex without leading zeros; null if unreadable. */
function ipv6Groups(address: string): string[] | null {
  let text = address
  // An IPv4 embedded at the end (e.g. 64:ff9b::192.0.2.1) takes two groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => Number.parseInt(g, 16).toString(16))
}

function keyFor(bucket: string, ip: string | null): string {
  return ip === null ? `${bucket}|unknown` : keyOf(bucket, ip)
}

/**
 * Keeps one table within MAX_ENTRIES. Expired entries go first: the head of the Map, which is where they gather; and, when the
 * table is full and the head is still counting (the "unknown" key has a window of its own, so an expired entry can sit behind a
 * live one), one scan of the whole table, at most once a second so that a flood of new keys cannot make every request scan.
 * If every key is still counting, the entry that ends first goes: a running counter is lost only to a table of 10,000 other
 * running counters of the same bucket, and the new key is served.
 */
function prune(table: Table, now: number): void {
  const { windows } = table
  for (const [key, window] of windows) {
    if (window.resetAt > now) break
    windows.delete(key)
  }
  if (windows.size <= MAX_ENTRIES) return
  if (now - table.sweptAt >= SWEEP_INTERVAL_MS) {
    table.sweptAt = now
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key)
    }
  }
  while (windows.size > MAX_ENTRIES) {
    const first = windows.keys().next().value
    if (first === undefined) break
    windows.delete(first)
  }
}

/**
 * Records an attempt. Returns true while within the limit (may continue), false once exceeded.
 * A null `ip` goes into the "unknown" key of `bucket`, with `unknownLimit` (default 100 per 10 minutes) instead of `limit`.
 */
export function rateLimit(
  bucket: string,
  ip: string | null,
  limit: number,
  windowMs: number,
  unknownLimit: number = UNKNOWN_LIMIT,
): boolean {
  const key = keyFor(bucket, ip)
  const max = ip === null ? unknownLimit : limit
  const span = ip === null ? UNKNOWN_WINDOW_MS : windowMs
  const now = Date.now()
  const table = tableOf(bucket)
  const { windows } = table

  const current = windows.get(key)
  if (current !== undefined && current.resetAt > now) {
    current.count += 1
    return current.count <= max
  }

  // Delete before setting again so a key that just expired moves to the end of the insertion order.
  windows.delete(key)
  windows.set(key, { count: 1, resetAt: now + span })
  prune(table, now)
  return 1 <= max
}

/** One GitHub sign-in attempt (start or callback) from the request's IP. */
export function allowOAuthAttempt(request: Request): boolean {
  return rateLimit('oauth', clientIp(request), OAUTH_LIMIT, OAUTH_WINDOW_MS, OAUTH_LIMIT)
}

/**
 * One admin password sign-in attempt. Takes the chosen IP (clientIp), not the request: the route uses
 * the same value for this count, for Retry-After and for the reset on a successful sign-in.
 */
export function allowLoginAttempt(ip: string | null): boolean {
  return rateLimit(LOGIN_BUCKET, ip, LOGIN_LIMIT, LOGIN_WINDOW_MS, LOGIN_LIMIT)
}

/**
 * Seconds until the sign-in window of `ip` reopens, rounded up: the value of `Retry-After`. 0 when
 * that IP has no running window. A fixed window, so blocked attempts do not lengthen it.
 */
export function loginRetryAfter(ip: string | null): number {
  return retryAfterSeconds(LOGIN_BUCKET, ip)
}

/** Like `loginRetryAfter`, for any bucket (search also returns `Retry-After` the same way). */
export function retryAfterSeconds(bucket: string, ip: string | null): number {
  const window = tables.get(bucket)?.windows.get(keyFor(bucket, ip))
  const remaining = window === undefined ? 0 : window.resetAt - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

/**
 * Successful sign-in: forget that IP's attempts. `null` does nothing: the "unknown" bucket belongs to every
 * request with an unknown IP, not to anyone in particular, and clearing it because one person signs in gives the limit back
 * to everyone else.
 */
export function resetLoginAttempts(ip: string | null): void {
  if (ip !== null) tables.get(LOGIN_BUCKET)?.windows.delete(keyOf(LOGIN_BUCKET, ip))
}

/** One call of the second step of a sign-in from this IP (`clientIp(request)`). */
export function allowMfaAttempt(ip: string | null): boolean {
  return rateLimit(MFA_BUCKET, ip, MFA_LIMIT, MFA_WINDOW_MS, MFA_LIMIT)
}

/** Seconds until the second-step window of `ip` reopens, rounded up (the value of `Retry-After`); 0 when it has no running window. */
export function mfaRetryAfter(ip: string | null): number {
  return retryAfterSeconds(MFA_BUCKET, ip)
}

/** The second step succeeded: forget that IP's attempts. `null` does nothing, like resetLoginAttempts. */
export function resetMfaAttempts(ip: string | null): void {
  if (ip !== null) tables.get(MFA_BUCKET)?.windows.delete(keyOf(MFA_BUCKET, ip))
}

/** One call of the Security page from this IP (`clientIp(request)`). */
export function allowSecurityAttempt(ip: string | null): boolean {
  return rateLimit(SECURITY_BUCKET, ip, SECURITY_LIMIT, SECURITY_WINDOW_MS, SECURITY_LIMIT)
}

/** Seconds until the Security window of `ip` reopens, rounded up (the value of `Retry-After`); 0 when it has no running window. */
export function securityRetryAfter(ip: string | null): number {
  return retryAfterSeconds(SECURITY_BUCKET, ip)
}
