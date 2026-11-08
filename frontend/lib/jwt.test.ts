import { describe, expect, it } from 'vitest'
import { decodeJwtPayload, isExpiringWithin, roleOf, subjectOf } from './jwt'
import { LONG_VI_NAME } from '@/test/fixtures/vi/collation'

/** Builds a token with a real base64url payload and a throwaway signature. */
function token(payload: Record<string, unknown>): string {
  const b64url = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'HS256' })}.${b64url(payload)}.signature-is-not-checked-here`
}

describe('decodeJwtPayload', () => {
  it('reads the claims', () => {
    const payload = decodeJwtPayload(token({ sub: 'u1', role: 'ADMIN', exp: 1_800_000_000 }))
    expect(payload).toEqual({ sub: 'u1', role: 'ADMIN', exp: 1_800_000_000 })
  })

  it('decodes a payload containing base64url-only characters', () => {
    // The real trap. Standard base64 uses + and /; base64url uses - and _, and `atob`
    // throws InvalidCharacterError on those. A payload whose bytes happen to encode to
    // a - or _ is not rare: any Vietnamese display name reaches that byte range, so
    // this breaks for a real user and never for an ASCII test fixture.
    //
    // The name is not arbitrary: a short Vietnamese name can encode without a + or a /, which exercises neither
    // replace() and passes against a decoder that omits both. This one puts both in the payload, and the
    // assertion below holds the fixture to that so a later rename cannot quietly neuter this test.
    const name = LONG_VI_NAME
    const segment = token({ sub: 'u1', name, exp: 1 }).split('.')[1]
    expect(segment).toContain('-')
    expect(segment).toContain('_')

    const payload = decodeJwtPayload(token({ sub: 'u1', name, exp: 1 }))
    expect(payload?.name).toBe(name)
  })

  it.each([
    ['empty', ''],
    ['not a jwt', 'abc'],
    ['two segments', 'a.b'],
    ['payload is not base64', 'a.!!!!.c'],
    ['payload is not json', `a.${Buffer.from('nope').toString('base64url')}.c`],
    ['payload is a json array', `a.${Buffer.from('[1,2]').toString('base64url')}.c`],
  ])('returns null for %s rather than throwing', (_label, value) => {
    // A cookie can hold anything — a truncated value, a leftover from an older format.
    // Middleware runs on every /admin request, so a throw here is a 500 on every page.
    expect(decodeJwtPayload(value)).toBeNull()
  })
})

describe('isExpiringWithin', () => {
  const inSeconds = (n: number) => Math.floor(Date.now() / 1000) + n

  it('is false for a token with plenty of life', () => {
    expect(isExpiringWithin(token({ exp: inSeconds(900) }), 30)).toBe(false)
  })

  it('is true inside the margin, so the token is never sent as it expires in flight', () => {
    expect(isExpiringWithin(token({ exp: inSeconds(10) }), 30)).toBe(true)
  })

  it('is true for an already-expired token', () => {
    expect(isExpiringWithin(token({ exp: inSeconds(-60) }), 30)).toBe(true)
  })

  it.each([
    ['no exp claim', token({ sub: 'u1' })],
    ['a non-numeric exp', token({ exp: 'soon' })],
    ['an undecodable token', 'garbage'],
  ])('treats %s as expiring, not as valid forever', (_label, value) => {
    // Fail closed. The alternative is that a malformed token is never refreshed and the
    // author is silently logged out at the API instead.
    expect(isExpiringWithin(value, 30)).toBe(true)
  })
})

describe('roleOf', () => {
  it('reads the role claim', () => {
    expect(roleOf(token({ role: 'ADMIN' }))).toBe('ADMIN')
  })

  it('is null when the claim is absent or not a string', () => {
    expect(roleOf(token({ sub: 'u1' }))).toBeNull()
    expect(roleOf(token({ role: 7 }))).toBeNull()
  })
})

describe('subjectOf', () => {
  it('reads `sub`: the user id the backend writes into the token', () => {
    expect(subjectOf(token({ sub: '11111111-1111-1111-1111-111111111111', role: 'ADMIN' }))).toBe(
      '11111111-1111-1111-1111-111111111111',
    )
  })

  it('null when missing, of the wrong type, empty or the token is unreadable', () => {
    expect(subjectOf(token({ role: 'ADMIN' }))).toBeNull()
    expect(subjectOf(token({ sub: 42 }))).toBeNull()
    expect(subjectOf(token({ sub: '' }))).toBeNull()
    expect(subjectOf('not-a-jwt')).toBeNull()
  })
})
