// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOGIN_LIMIT,
  LOGIN_WINDOW_MS,
  MFA_LIMIT,
  MFA_WINDOW_MS,
  OAUTH_LIMIT,
  SECURITY_LIMIT,
  SECURITY_WINDOW_MS,
  allowLoginAttempt,
  allowMfaAttempt,
  allowOAuthAttempt,
  allowSecurityAttempt,
  loginRetryAfter,
  mfaRetryAfter,
  rateLimit,
  rateLimitSubject,
  resetLoginAttempts,
  resetMfaAttempts,
  securityRetryAfter,
} from './rate-limit'

function fromXff(xff: string | null): Request {
  const headers = new Headers()
  if (xff !== null) headers.set('x-forwarded-for', xff)
  return new Request('http://localhost:3000/api/auth/github/start', { headers })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('rateLimit: fixed window per key', () => {
  it('allows exactly `limit` hits in the window, the next one is blocked', () => {
    const results = Array.from({ length: 4 }, () => rateLimit('t-basic', '10.0.0.1', 3, 60_000))
    expect(results).toEqual([true, true, true, false])
  })

  it('after the window ends, counting starts over', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    expect(rateLimit('t-window', '10.0.0.2', 1, 60_000)).toBe(true)
    expect(rateLimit('t-window', '10.0.0.2', 1, 60_000)).toBe(false)
    now.mockReturnValue(1_000_000 + 60_001)
    expect(rateLimit('t-window', '10.0.0.2', 1, 60_000)).toBe(true)
  })

  it('each bucket counts separately', () => {
    expect(rateLimit('t-a', '10.0.0.3', 1, 60_000)).toBe(true)
    expect(rateLimit('t-b', '10.0.0.3', 1, 60_000)).toBe(true)
    expect(rateLimit('t-a', '10.0.0.3', 1, 60_000)).toBe(false)
  })

  it('an unknown IP goes into one shared "unknown" bucket, limit 100 per 10 minutes', () => {
    // One shared limit rather than no limit: fail soft, not fail open.
    const results = Array.from({ length: 101 }, () => rateLimit('t-unknown', null, 1, 60_000))
    expect(results.slice(0, 100).every(Boolean)).toBe(true)
    expect(results[100]).toBe(false)
  })

  it('keeps at most 10 000 keys: beyond that the oldest key is dropped, the new key stays', () => {
    expect(rateLimit('t-evict', 'oldest', 1, 600_000)).toBe(true)
    expect(rateLimit('t-evict', 'oldest', 1, 600_000)).toBe(false)

    for (let i = 0; i < 10_000; i++) rateLimit('t-evict', `ip-${i}`, 1, 600_000)

    // The oldest key was dropped, so it is counted from scratch...
    expect(rateLimit('t-evict', 'oldest', 1, 600_000)).toBe(true)
    // ...while the key just added is still remembered: the oldest key is dropped, not the whole table cleared.
    expect(rateLimit('t-evict', 'ip-9999', 1, 600_000)).toBe(false)
  })

  // Issue 027: one table per bucket. Anonymous routes (view beacons, search suggestions, CSP reports) add a key per address; a
  // shared table let 10,000 of those push a running login counter out and give the address a fresh allowance.
  it('a flood of keys in other buckets cannot reset a running counter of the sign-in buckets', () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.60')
    expect(allowLoginAttempt('198.51.100.60')).toBe(false)
    for (let i = 0; i < MFA_LIMIT; i++) allowMfaAttempt('198.51.100.60')
    expect(allowMfaAttempt('198.51.100.60')).toBe(false)
    for (let i = 0; i < SECURITY_LIMIT; i++) allowSecurityAttempt('198.51.100.60')
    expect(allowSecurityAttempt('198.51.100.60')).toBe(false)

    for (let i = 0; i < 10_001; i++) {
      rateLimit('views', `203.0.113.${i % 250}-${i}`, 30, 60_000)
      rateLimit('csp-report', `view-${i}`, 100, 600_000)
      rateLimit('search', `search-${i}`, 120, 60_000)
    }

    expect(allowLoginAttempt('198.51.100.60')).toBe(false)
    expect(allowMfaAttempt('198.51.100.60')).toBe(false)
    expect(allowSecurityAttempt('198.51.100.60')).toBe(false)
  })

  it('a full table still serves a new key, in the sign-in bucket too', () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.61')
    for (let i = 0; i < 10_001; i++) allowLoginAttempt(`2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`)

    // The owner arrives from an address nobody has seen: served, whatever the crowd did.
    expect(allowLoginAttempt('192.0.2.200')).toBe(true)
  })
})

describe('rateLimitSubject: IPv6 counts by /64, IPv4 by address', () => {
  it('IPv6 collapses to its /64, in normalized form', () => {
    expect(rateLimitSubject('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(rateLimitSubject('2001:DB8:0001:0002::1')).toBe('2001:db8:1:2::/64')
    expect(rateLimitSubject('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitSubject('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitSubject('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    // An IPv4 embedded at the end takes two groups, and does not shift the /64 part before it.
    expect(rateLimitSubject('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64')
    expect(rateLimitSubject('1:2:3:4:5:6:192.0.2.1')).toBe('1:2:3:4::/64')
  })

  it('IPv4 and IPv4 embedded as ::ffff: are the same IPv4 address itself', () => {
    expect(rateLimitSubject('203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitSubject('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitSubject('::FFFF:203.0.113.7')).toBe('203.0.113.7')
  })

  it('changing the last 64 bits of an IPv6 gives no extra hits', () => {
    // ISPs and VPS providers hand out a whole /64 to one customer: counting per address would be unlimited hits.
    expect(rateLimit('t-v6', '2001:db8:aa:bb::1', 1, 60_000)).toBe(true)
    expect(rateLimit('t-v6', '2001:db8:aa:bb:ffff:ffff:ffff:ffff', 1, 60_000)).toBe(false)
    expect(rateLimit('t-v6', '2001:DB8:AA:BB:0:0:0:2', 1, 60_000)).toBe(false)
    // The neighbouring /64 is a different customer.
    expect(rateLimit('t-v6', '2001:db8:aa:bc::1', 1, 60_000)).toBe(true)
  })

  it('IPv4 still counts per address; the ::ffff: form shares the counter with its IPv4 address', () => {
    expect(rateLimit('t-v4', '198.51.100.40', 1, 60_000)).toBe(true)
    expect(rateLimit('t-v4', '198.51.100.41', 1, 60_000)).toBe(true)
    expect(rateLimit('t-v4', '::ffff:198.51.100.40', 1, 60_000)).toBe(false)
  })

  it('a successful sign-in clears the counter of the whole /64, not only that exact address', () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) expect(allowLoginAttempt(`2001:db8:cc:dd::${i + 1}`)).toBe(true)
    expect(allowLoginAttempt('2001:db8:cc:dd::99')).toBe(false)
    resetLoginAttempts('2001:db8:cc:dd::42')
    expect(allowLoginAttempt('2001:db8:cc:dd::99')).toBe(true)
  })
})

describe('allowOAuthAttempt: 20 per 10 minutes per IP', () => {
  it('the 21st is blocked', () => {
    const results = Array.from({ length: OAUTH_LIMIT + 1 }, () => allowOAuthAttempt(fromXff('198.51.100.20')))
    expect(OAUTH_LIMIT).toBe(20)
    expect(results.filter(Boolean)).toHaveLength(20)
    expect(results[20]).toBe(false)
  })

  it('changing the first X-Forwarded-For entry does not change the bucket', () => {
    // The sender chooses the first entry; the last is written by nginx. Changing the first entry each time still counts into one place.
    const results = Array.from({ length: OAUTH_LIMIT + 1 }, (_, i) => allowOAuthAttempt(fromXff(`10.66.${i}.1, 198.51.100.21`)))
    expect(results[20]).toBe(false)
  })

  it('an unreadable address has the allowance of one address (issue 017)', () => {
    const results = Array.from({ length: OAUTH_LIMIT + 1 }, () => allowOAuthAttempt(fromXff('not-an-ip')))
    expect(results.slice(0, OAUTH_LIMIT).every(Boolean)).toBe(true)
    expect(results[OAUTH_LIMIT]).toBe(false)
  })

  it('a different IP gives a different bucket', () => {
    for (let i = 0; i < OAUTH_LIMIT; i++) allowOAuthAttempt(fromXff('198.51.100.22'))
    expect(allowOAuthAttempt(fromXff('198.51.100.22'))).toBe(false)
    expect(allowOAuthAttempt(fromXff('198.51.100.23'))).toBe(true)
  })

  it('follows TRUSTED_PROXY_HOPS when picking the entry', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    for (let i = 0; i < OAUTH_LIMIT; i++) allowOAuthAttempt(fromXff(`x, 198.51.100.24, 172.16.0.${i}`))
    // The last entry (Cloudflare's IP) changes every time, but the key is the second entry from the right.
    expect(allowOAuthAttempt(fromXff('y, 198.51.100.24, 172.16.0.99'))).toBe(false)
  })
})

/**
 * Admin password sign-in. Takes the already chosen IP (the route calls clientIp once, used for
 * the count, Retry-After and the reset), so the X-Forwarded-For part is tested in
 * app/admin/login/submit/route.test.ts.
 */
describe('allowLoginAttempt: 10 per 10 minutes per IP, a successful sign-in resets', () => {
  it('the 11th is blocked: every attempt counts, not only wrong ones', () => {
    const results = Array.from({ length: LOGIN_LIMIT + 1 }, () => allowLoginAttempt('198.51.100.30'))
    expect(LOGIN_LIMIT).toBe(10)
    expect(LOGIN_WINDOW_MS).toBe(10 * 60_000)
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(results[10]).toBe(false)
  })

  it('a different IP gives a different bucket, separate from the GitHub sign-in limit of the same IP', () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.31')
    expect(allowLoginAttempt('198.51.100.31')).toBe(false)
    expect(allowLoginAttempt('198.51.100.32')).toBe(true)
    expect(allowOAuthAttempt(fromXff('198.51.100.31'))).toBe(true)
  })

  it("loginRetryAfter: seconds until that IP's window reopens, rounded up", () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    for (let i = 0; i <= LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.33')
    expect(loginRetryAfter('198.51.100.33')).toBe(600)

    now.mockReturnValue(2_000_000 + 4 * 60_000 + 500)
    expect(loginRetryAfter('198.51.100.33')).toBe(360)
    expect(allowLoginAttempt('198.51.100.33')).toBe(false)

    // Fixed window: a blocked attempt does not extend it.
    now.mockReturnValue(2_000_000 + LOGIN_WINDOW_MS)
    expect(loginRetryAfter('198.51.100.33')).toBe(0)
    expect(allowLoginAttempt('198.51.100.33')).toBe(true)
  })

  it('resetLoginAttempts clears the counter of exactly that IP: the site owner mistypes a few times, then signs in and has all 10 attempts again', () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.34')
    for (let i = 0; i < LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.35')

    resetLoginAttempts('198.51.100.34')

    const again = Array.from({ length: LOGIN_LIMIT + 1 }, () => allowLoginAttempt('198.51.100.34'))
    expect(again.slice(0, LOGIN_LIMIT).every(Boolean)).toBe(true)
    expect(again[LOGIN_LIMIT]).toBe(false)
    // The other IP is still blocked: one key is cleared, not the whole table.
    expect(allowLoginAttempt('198.51.100.35')).toBe(false)
  })

  it('unknown IP: one shared "unknown" key with the allowance of ONE address (10 per 10 minutes), and a successful sign-in does not reopen it', () => {
    // Issue 017: a caller who makes the address unreadable used to land in a bucket ten times as wide (100).
    const results = Array.from({ length: LOGIN_LIMIT + 1 }, () => allowLoginAttempt(null))
    expect(results.slice(0, LOGIN_LIMIT).every(Boolean)).toBe(true)
    expect(results[LOGIN_LIMIT]).toBe(false)

    // This bucket belongs to every request with an unknown IP, not to anyone in particular: clearing it because one person signs in
    // would give the limit back to everyone else.
    resetLoginAttempts(null)
    expect(allowLoginAttempt(null)).toBe(false)
    expect(loginRetryAfter(null)).toBeGreaterThan(0)
  })
})

/** The second step of a sign-in (/admin/login/mfa/submit, /admin/login/enroll/*): its own bucket, 10 per 10 minutes per IP. */
describe('allowMfaAttempt: 10 per 10 minutes per IP, separate from the password bucket', () => {
  it('the 11th is blocked, and the limits are the documented ones', () => {
    const results = Array.from({ length: MFA_LIMIT + 1 }, () => allowMfaAttempt('198.51.100.40'))
    expect(MFA_LIMIT).toBe(10)
    expect(MFA_WINDOW_MS).toBe(10 * 60_000)
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(results[10]).toBe(false)
  })

  it('ten password attempts do not use up the codes of the same IP, and the other way round', () => {
    for (let i = 0; i < LOGIN_LIMIT; i++) allowLoginAttempt('198.51.100.41')
    expect(allowLoginAttempt('198.51.100.41')).toBe(false)
    expect(allowMfaAttempt('198.51.100.41')).toBe(true)

    for (let i = 0; i < MFA_LIMIT; i++) allowMfaAttempt('198.51.100.42')
    expect(allowMfaAttempt('198.51.100.42')).toBe(false)
    expect(allowLoginAttempt('198.51.100.42')).toBe(true)
  })

  it("mfaRetryAfter: seconds until that IP's window reopens, 0 without a running window", () => {
    expect(mfaRetryAfter('198.51.100.43')).toBe(0)
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000)
    for (let i = 0; i <= MFA_LIMIT; i++) allowMfaAttempt('198.51.100.43')
    expect(mfaRetryAfter('198.51.100.43')).toBe(600)

    now.mockReturnValue(3_000_000 + MFA_WINDOW_MS)
    expect(mfaRetryAfter('198.51.100.43')).toBe(0)
  })

  it('resetMfaAttempts clears exactly that IP, and the shared unknown bucket stays', () => {
    for (let i = 0; i < MFA_LIMIT; i++) allowMfaAttempt('198.51.100.44')
    for (let i = 0; i < MFA_LIMIT; i++) allowMfaAttempt('198.51.100.45')

    resetMfaAttempts('198.51.100.44')

    expect(allowMfaAttempt('198.51.100.44')).toBe(true)
    expect(allowMfaAttempt('198.51.100.45')).toBe(false)

    // Issue 017: the unknown key has the allowance of one address (10), not ten times that.
    const unknown = Array.from({ length: MFA_LIMIT + 1 }, () => allowMfaAttempt(null))
    expect(unknown.slice(0, MFA_LIMIT).every(Boolean)).toBe(true)
    expect(unknown[MFA_LIMIT]).toBe(false)
    resetMfaAttempts(null)
    expect(allowMfaAttempt(null)).toBe(false)
  })
})

/** The Security page of a signed-in account (/admin/security/*): its own bucket, 20 per 10 minutes per IP. */
describe('allowSecurityAttempt: 20 per 10 minutes per IP, separate from the sign-in buckets', () => {
  it('the 21st is blocked, and the limits are the documented ones', () => {
    const results = Array.from({ length: SECURITY_LIMIT + 1 }, () => allowSecurityAttempt('198.51.100.50'))
    expect(SECURITY_LIMIT).toBe(20)
    expect(SECURITY_WINDOW_MS).toBe(10 * 60_000)
    expect(results.filter(Boolean)).toHaveLength(20)
    expect(results[20]).toBe(false)
  })

  it('does not share a count with the password or the second-step bucket of the same IP', () => {
    for (let i = 0; i < SECURITY_LIMIT; i++) allowSecurityAttempt('198.51.100.51')
    expect(allowSecurityAttempt('198.51.100.51')).toBe(false)
    expect(allowLoginAttempt('198.51.100.51')).toBe(true)
    expect(allowMfaAttempt('198.51.100.51')).toBe(true)
  })

  it('an unknown address has the allowance of one address, not ten times as much (issue 017)', () => {
    const results = Array.from({ length: SECURITY_LIMIT + 1 }, () => allowSecurityAttempt(null))
    expect(results.slice(0, SECURITY_LIMIT).every(Boolean)).toBe(true)
    expect(results[SECURITY_LIMIT]).toBe(false)
  })

  it("securityRetryAfter: seconds until that IP's window reopens, 0 without a running window", () => {
    expect(securityRetryAfter('198.51.100.52')).toBe(0)
    const now = vi.spyOn(Date, 'now').mockReturnValue(7_000_000)
    for (let i = 0; i <= SECURITY_LIMIT; i++) allowSecurityAttempt('198.51.100.52')
    expect(securityRetryAfter('198.51.100.52')).toBe(600)

    now.mockReturnValue(7_000_000 + SECURITY_WINDOW_MS)
    expect(securityRetryAfter('198.51.100.52')).toBe(0)
  })
})
