/**
 * Shared by the two scripts that talk to an E2E stack's backend before or besides the Playwright suite (e2e-bootstrap.mjs,
 * e2e-seed-english.mjs): the administrator of the stack signs in through both steps, with the authenticator on record in
 * `e2e/.auth/admin-mfa.json`.
 *
 * Plain ESM with no dependency (`node scripts/e2e-bootstrap.mjs`): it cannot import the TypeScript of e2e/support/, so the ten lines of
 * TOTP below are a copy of e2e/support/totp.ts. test/e2e-totp.test.ts keeps the two in step by running both on the RFC 6238 vectors and on
 * many random inputs.
 *
 * Nothing here prints a code, a key or a token.
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const API = (process.env.E2E_API_URL ?? 'http://localhost:8081').replace(/\/+$/, '')
export const EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@blog.local'
export const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin12345'
export const STATE_FILE = fileURLToPath(new URL('../e2e/.auth/admin-mfa.json', import.meta.url))

const STEP_SECONDS = 30
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 (spaces, hyphens, `=` and lower case tolerated). A copy of e2e/support/totp.ts. */
export function base32Decode(text) {
  const bytes = []
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

/** The code of `step`, `digits` long (HMAC-SHA1, RFC 4226 dynamic truncation). */
export function totpAt(secret, step, digits = 6) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function stepAt(epochMs) {
  return Math.floor(epochMs / 1000 / STEP_SECONDS)
}

/** Which step to use and how long to wait for it: the current one if newer than the last used, else the next period's. */
export function nextFreshStep(lastStep, nowMs) {
  const current = stepAt(nowMs)
  if (current > lastStep) return { step: current, waitMs: 0 }
  const step = Math.max(current, lastStep) + 1
  return { step, waitMs: Math.max(0, step * STEP_SECONDS * 1000 - nowMs) + 250 }
}

// --- The state file -------------------------------------------------------------------------------

/** `{ secret, recoveryCodes, lastStep }`, or null when the file is not there. */
export function readState() {
  if (!existsSync(STATE_FILE)) return null
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  if (typeof state.secret !== 'string' || !Array.isArray(state.recoveryCodes) || typeof state.lastStep !== 'number') {
    throw new Error('e2e/.auth/admin-mfa.json is not in the shape the bootstrap writes; delete it and run the bootstrap again.')
  }
  return state
}

export function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const temporary = `${STATE_FILE}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, STATE_FILE)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A code the stack has not accepted from the suite yet; the period is marked as used before the code is returned. */
export async function freshCode(state) {
  const { step, waitMs } = nextFreshStep(state.lastStep, Date.now())
  state.lastStep = step
  writeState(state)
  if (waitMs > 0) await sleep(waitMs)
  return totpAt(state.secret, step)
}

// --- The API ---------------------------------------------------------------------------------------

/** One call. Returns `{ status, data, code }`: the `data` of the envelope and the stable error code, if any. Never throws on an HTTP status. */
export async function call(method, path, token, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = await response.json().catch(() => null)
  return { status: response.status, data: parsed?.data ?? null, code: parsed?.error?.code ?? null }
}

/** The first step: the answer is a `202` with a challenge for an account that needs a second one. */
export async function login() {
  const answer = await call('POST', '/api/v1/auth/login', null, { email: EMAIL, password: PASSWORD })
  if (answer.status !== 202 || typeof answer.data?.challenge !== 'string') {
    throw new Error(`The administrator's password sign-in answered HTTP ${answer.status}; a 202 with a challenge was expected.`)
  }
  return {
    challenge: answer.data.challenge,
    purpose: answer.data.purpose,
    enrollmentCodeRequired: answer.data.enrollmentCodeRequired === true,
  }
}

/** The second step of a sign-in: a fresh code of the recorded authenticator. Returns the access token. */
export async function completeSecondStep(challenge) {
  const state = readState()
  if (state === null) {
    throw new Error('No authenticator on record (e2e/.auth/admin-mfa.json). Run "node scripts/e2e-bootstrap.mjs" first.')
  }
  const verified = await call('POST', '/api/v1/auth/mfa/verify', null, { challenge, code: await freshCode(state) })
  if (verified.status !== 200 || typeof verified.data?.accessToken !== 'string') {
    throw new Error(
      `The second step answered HTTP ${verified.status} ${verified.code ?? ''}. Is e2e/.auth/admin-mfa.json the authenticator of THIS stack?`.trim(),
    )
  }
  return verified.data.accessToken
}

/**
 * The administrator's access token: password, then a fresh authenticator code from the state file. A stack that still has to enroll
 * the administrator (or whose file is gone) is reported with the way out, not enrolled here: that is e2e-bootstrap.mjs.
 */
export async function adminToken() {
  const { challenge, purpose } = await login()
  if (purpose !== 'VERIFY') {
    throw new Error('The administrator has no authenticator on this stack yet. Run "node scripts/e2e-bootstrap.mjs" first.')
  }
  return completeSecondStep(challenge)
}
