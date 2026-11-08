// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { base32Decode, nextFreshStep, stepAt, STEP_SECONDS, totpAt } from '../e2e/support/totp'
import * as script from '../scripts/e2e-stack.mjs'

/**
 * The E2E suite computes its own authenticator codes (e2e/support/totp.ts, and a copy in scripts/e2e-stack.mjs for the node scripts).
 * A test that borrowed the backend's code would agree with it even when both were wrong, so this pins the helper to the RFC 6238
 * appendix B vectors, to the backend's own known-answer test (backend/src/test/java/com/blog/auth/mfa/TotpTest.java: the same secret and
 * times give the same six digits), and the two copies to each other.
 */

/** The RFC 6238 appendix B secret for HMAC-SHA1: the ASCII bytes of 12345678901234567890, in base32. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

/** [time in seconds, the 8-digit value of the RFC]. The 6-digit code is the last six digits of the same truncation. */
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('e2e/support/totp.ts', () => {
  it('decodes base32 like RFC 4648: the RFC 6238 secret is the ASCII text 12345678901234567890', () => {
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890')
  })

  it('tolerates the spaces of the groups of four, hyphens, padding and lower case, and refuses anything else', () => {
    expect(base32Decode('gezd gnbv-GY3T QOJQ====').toString('ascii')).toBe('1234567890')
    expect(() => base32Decode('GEZD1')).toThrow('base32')
    expect(() => base32Decode('GEZD!')).toThrow('base32')
  })

  it.each(VECTORS)('time %i gives the RFC 6238 value (8 digits) and its last six digits (the product)', (time, expected) => {
    const step = stepAt(time * 1000)
    expect(totpAt(RFC_SECRET, step, 8)).toBe(expected)
    expect(totpAt(RFC_SECRET, step)).toBe(expected.slice(2))
  })

  it('a step is thirty seconds of epoch time', () => {
    expect(STEP_SECONDS).toBe(30)
    expect([0, 29_999, 30_000, 59_999].map(stepAt)).toEqual([0, 0, 1, 1])
  })

  it('keeps the leading zeros of a code', () => {
    // Time 1111111109 is 07081804 in 8 digits: the 6-digit code starts with a zero in nobody's mind but must in the text.
    expect(totpAt(RFC_SECRET, stepAt(1111111109 * 1000))).toBe('081804')
  })
})

describe('nextFreshStep: the one place the suite waits', () => {
  const at = (step: number, secondsIntoStep = 5) => step * STEP_SECONDS * 1000 + secondsIntoStep * 1000

  it('uses the current step at once when it is newer than the last one used', () => {
    expect(nextFreshStep(99, at(100))).toEqual({ step: 100, waitMs: 0 })
    expect(nextFreshStep(0, at(100))).toEqual({ step: 100, waitMs: 0 })
  })

  it('waits for the next period when the current one was used: the previous step is no help, the stack accepts only a newer step', () => {
    const { step, waitMs } = nextFreshStep(100, at(100, 5))
    expect(step).toBe(101)
    // 25 seconds to the boundary, plus the small margin.
    expect(waitMs).toBeGreaterThanOrEqual(25_000)
    expect(waitMs).toBeLessThanOrEqual(26_000)
  })

  it('never waits more than a period and a margin', () => {
    for (const second of [0, 1, 15, 29]) {
      expect(nextFreshStep(100, at(100, second)).waitMs).toBeLessThanOrEqual(30_250)
    }
  })

  it('a last step ahead of the clock waits for that step to pass, then uses the one after it', () => {
    const { step, waitMs } = nextFreshStep(102, at(100, 5))
    expect(step).toBe(103)
    expect(waitMs).toBeGreaterThan(30_000)
  })
})

describe('scripts/e2e-stack.mjs keeps a copy of the same functions', () => {
  it('gives the same answers on the RFC vectors', () => {
    for (const [time, expected] of VECTORS) {
      expect(script.totpAt(RFC_SECRET, script.stepAt(time * 1000), 8)).toBe(expected)
    }
  })

  it('gives the same answers as the TypeScript helper on many random keys and steps', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    for (let index = 0; index < 200; index += 1) {
      const secret = Array.from(randomBytes(32), (byte) => alphabet[byte % 32]).join('')
      const step = randomBytes(4).readUInt32BE() % 100_000_000
      expect(script.totpAt(secret, step)).toBe(totpAt(secret, step))
      expect(script.base32Decode(secret).equals(base32Decode(secret))).toBe(true)
    }
  })

  it('chooses the same step and wait as the TypeScript helper', () => {
    for (let index = 0; index < 200; index += 1) {
      const now = Date.now() + (randomBytes(4).readUInt32BE() % 1_000_000)
      const last = stepAt(now) + ((randomBytes(1)[0] ?? 0) % 5) - 3
      expect(script.nextFreshStep(last, now)).toEqual(nextFreshStep(last, now))
    }
  })
})
