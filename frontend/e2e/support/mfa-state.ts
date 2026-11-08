import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nextFreshStep, totpAt } from './totp'

/**
 * What the suite knows about the two-step verification of the E2E stack's administrator, in `e2e/.auth/admin-mfa.json`.
 *
 * `scripts/e2e-bootstrap.mjs` writes it when it enrolls the administrator of a fresh stack: `secret` (the base32 key of the
 * authenticator), `recoveryCodes` (the ones not used yet) and `lastStep` (the last 30 second period of the stack in which a code of
 * this suite was accepted). Everything in it is a throw-away value of a throw-away stack. The directory is ignored by git and left out
 * of the Docker build context (test/e2e-auth-ignore.test.ts keeps both entries).
 *
 * The suite runs on one worker, and the global setup, the helpers and the scripts take turns, so a plain file is enough: no
 * two writers at once. `lastStep` is written BEFORE a code is returned, so a code that was computed but never accepted still
 * counts as used: waiting a period too long is cheaper than a sign-in refused as a replay.
 */

export const AUTH_DIR = join(__dirname, '..', '.auth')
export const MFA_STATE_FILE = join(AUTH_DIR, 'admin-mfa.json')

export type AdminMfaState = { secret: string; recoveryCodes: string[]; lastStep: number }

/**
 * The recovery codes a full run of the suite can spend: the global setup's API sign-in, and three per project (the sign-in and the
 * sign-out specs of login.spec.ts, the wrong-code spec of mfa.spec.ts), with a margin. The bootstrap and the global setup make ten
 * new codes whenever fewer than this are on record, so a run never starts short (scripts/e2e-bootstrap.mjs has the same number).
 */
export const RECOVERY_CODES_WANTED = 8

const MISSING =
  'The E2E administrator has no authenticator on record (e2e/.auth/admin-mfa.json). Run "node scripts/e2e-bootstrap.mjs" from the ' +
  'frontend folder against the stack first; on a stack that is already enrolled and whose file is gone, reset the stack or run the SQL ' +
  'reset in docs/SECURITY.md.'

export function readMfaState(): AdminMfaState {
  if (!existsSync(MFA_STATE_FILE)) throw new Error(MISSING)
  const state = JSON.parse(readFileSync(MFA_STATE_FILE, 'utf8')) as Partial<AdminMfaState>
  if (typeof state.secret !== 'string' || !Array.isArray(state.recoveryCodes) || typeof state.lastStep !== 'number') {
    throw new Error('e2e/.auth/admin-mfa.json is not in the shape the bootstrap writes; run the bootstrap again.')
  }
  return { secret: state.secret, recoveryCodes: state.recoveryCodes.map(String), lastStep: state.lastStep }
}

/** Written to a temporary file and moved over, so that a reader never sees half a file. */
export function writeMfaState(state: AdminMfaState): void {
  mkdirSync(dirname(MFA_STATE_FILE), { recursive: true })
  const temporary = `${MFA_STATE_FILE}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, MFA_STATE_FILE)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A code the stack has not accepted from the suite yet: the current period's if it is newer than the last one used, else the next
 * period's after waiting for it (at most 30 seconds, `nextFreshStep`). Marks the period as used before returning.
 */
export async function freshAdminCode(): Promise<string> {
  const state = readMfaState()
  const { step, waitMs } = nextFreshStep(state.lastStep, Date.now())
  writeMfaState({ ...state, lastStep: step })
  if (waitMs > 0) await sleep(waitMs)
  return totpAt(state.secret, step)
}

/** How many recovery codes are left to sign in with. */
export function recoveryCodesLeft(): number {
  return readMfaState().recoveryCodes.length
}

/** One recovery code, removed from the file at once (the stack burns it on use). Null when none is left. */
export function takeRecoveryCode(): string | null {
  const state = readMfaState()
  const [code, ...rest] = state.recoveryCodes
  if (code === undefined) return null
  writeMfaState({ ...state, recoveryCodes: rest })
  return code
}

/** Replaces the recovery codes after the page or the API generated new ones (the old ones no longer work). */
export function replaceRecoveryCodes(codes: string[]): void {
  writeMfaState({ ...readMfaState(), recoveryCodes: codes })
}

/** The authenticator was replaced (a new secret): the old one is gone from the stack. */
export function replaceSecret(secret: string, recoveryCodes: string[], step: number): void {
  writeMfaState({ secret, recoveryCodes, lastStep: step })
}
