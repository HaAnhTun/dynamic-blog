import { createHmac } from 'node:crypto'

/**
 * TOTP (RFC 6238) for the E2E suite: HMAC-SHA1, 6 digits, 30 seconds, the only parameters every authenticator app and the backend
 * (`com.blog.auth.mfa.Totp`) support. It is the test's own implementation on purpose: a test that borrowed the backend's would agree
 * with it even when both were wrong. `test/e2e-totp.test.ts` pins it to the RFC 6238 appendix B vectors and to the backend's
 * known-answer test, and compares it with the copy the node scripts use (scripts/e2e-stack.mjs).
 *
 * No dependency: Node has no base32 decoder, so the ten-line one below stands in.
 */

export const STEP_SECONDS = 30
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding, as the backend shows the key (spaces, hyphens, `=` and lower case are tolerated). */
export function base32Decode(text: string): Buffer {
  const bytes: number[] = []
  let value = 0
  let bits = 0
  for (const char of text.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) throw new Error('The secret is not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(bytes)
}

/** The code of `step` (the number of 30 second periods since the epoch), `digits` long. */
export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** The period that contains `epochMs`. */
export function stepAt(epochMs: number): number {
  return Math.floor(epochMs / 1000 / STEP_SECONDS)
}

/**
 * Which step to use now, given the last one this stack accepted from the suite, and how long to wait for it.
 *
 * The backend accepts the current step and the one before it, but only a step GREATER than the last accepted one (replay protection:
 * RFC 6238 section 5.2). So when the current step is newer than the last one, it is used at once; when it is not, no step of the
 * accepted window is left, and the only way forward is to wait for the next period. This is the one place the suite waits, and
 * at most 30 seconds. The small margin keeps the code from being computed in the last millisecond of a period.
 */
export function nextFreshStep(lastStep: number, nowMs: number): { step: number; waitMs: number } {
  const current = stepAt(nowMs)
  if (current > lastStep) return { step: current, waitMs: 0 }
  const step = Math.max(current, lastStep) + 1
  return { step, waitMs: Math.max(0, step * STEP_SECONDS * 1000 - nowMs) + 250 }
}
