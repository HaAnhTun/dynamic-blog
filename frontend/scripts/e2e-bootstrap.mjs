/**
 * Prepares a fresh E2E stack for the Playwright suite (docs/DEVELOPMENT.md, "E2E"; the CI `e2e` job runs the same command):
 *
 *   node scripts/e2e-bootstrap.mjs                    enroll the administrator's authenticator
 *   node scripts/e2e-bootstrap.mjs --sample-content   ... and load the packaged sample content
 *   node scripts/e2e-bootstrap.mjs --code             print a fresh code of the recorded authenticator and do nothing else
 *
 * The administrator cannot sign in with a password alone: two-step verification is mandatory. On a new stack the first sign-in is an
 * enrollment, so this script signs in through the API (a 202 with a challenge), enrolls an authenticator through
 * `mfa/enroll/begin` and `mfa/enroll/confirm`, and writes what the suite needs to `e2e/.auth/admin-mfa.json`: the key, the ten recovery
 * codes and the last 30 second period it used. Those are throw-away values of a throw-away stack; the directory is ignored by git and
 * left out of the Docker build context.
 *
 * On a stack that is already enrolled it reuses the file and signs in with a code (and makes new recovery codes when fewer than eight
 * are left, which is what a full run of the suite can spend). If the stack is enrolled but the file is gone there is no way in from here: reset the stack, or run the SQL reset in
 * docs/SECURITY.md, then run this again.
 *
 * It enrolls without an enrollment code, which only a stack that opts in to development defaults allows (APP_ALLOW_DEV_DEFAULTS=true and
 * a loopback SITE_URL, as the E2E stack is started). `E2E_MFA_ENROLLMENT_CODE` supplies one for a stack that asks.
 *
 * Environment: `E2E_API_URL` (default http://localhost:8081), `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`. Prints no key, code or token.
 */
import {
  PASSWORD,
  STATE_FILE,
  call,
  completeSecondStep,
  freshCode,
  login,
  readState,
  stepAt,
  totpAt,
  writeState,
} from './e2e-stack.mjs'

/** The recovery codes a full run of the suite can spend (e2e/support/mfa-state.ts, RECOVERY_CODES_WANTED): fewer than this are renewed. */
const KEEP_RECOVERY_CODES = 8

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function enroll({ challenge, enrollmentCodeRequired }, previous) {
  const begun = await call('POST', '/api/v1/auth/mfa/enroll/begin', null, {
    challenge,
    ...(process.env.E2E_MFA_ENROLLMENT_CODE ? { enrollmentCode: process.env.E2E_MFA_ENROLLMENT_CODE } : {}),
  })
  if (begun.status !== 200 || typeof begun.data?.secretBase32 !== 'string') {
    fail(
      `Enrollment was refused (HTTP ${begun.status} ${begun.code ?? ''}).` +
        (enrollmentCodeRequired || begun.code === 'ENROLLMENT_CODE_INVALID'
          ? ' This stack asks for the enrollment code: it is not started with APP_ALLOW_DEV_DEFAULTS=true and a loopback SITE_URL (docs/DEVELOPMENT.md), or pass E2E_MFA_ENROLLMENT_CODE.'
          : ''),
    )
  }
  const secret = begun.data.secretBase32
  const step = stepAt(Date.now())
  const confirmed = await call('POST', '/api/v1/auth/mfa/enroll/confirm', null, { challenge, code: totpAt(secret, step) })
  if (confirmed.status !== 200 || !Array.isArray(confirmed.data?.recoveryCodes)) {
    fail(`Enrollment could not be confirmed (HTTP ${confirmed.status} ${confirmed.code ?? ''}).`)
  }
  writeState({ secret, recoveryCodes: confirmed.data.recoveryCodes, lastStep: step })
  console.log(
    `Enrolled the administrator's authenticator${previous ? ' (replacing an old record of another stack)' : ''}; recorded in e2e/.auth/admin-mfa.json.`,
  )
  return confirmed.data.accessToken
}

/** Signs in with a code of the recorded authenticator; new recovery codes when few are left. Returns the access token. */
async function reuse(state, challenge) {
  const token = await completeSecondStep(challenge)
  if (state.recoveryCodes.length >= KEEP_RECOVERY_CODES) {
    console.log(`The administrator is already enrolled; ${state.recoveryCodes.length} recovery codes on record.`)
    return token
  }
  // A recovery code is a valid proof for this call and costs no wait for the next period.
  const [proof] = state.recoveryCodes
  const code = proof ?? (await freshCode(readState()))
  const renewed = await call('POST', '/api/v1/me/mfa/recovery-codes/regenerate', token, { code, currentPassword: PASSWORD })
  if (renewed.status !== 200 || !Array.isArray(renewed.data?.recoveryCodes)) {
    fail(`New recovery codes could not be made (HTTP ${renewed.status} ${renewed.code ?? ''}).`)
  }
  writeState({ ...readState(), recoveryCodes: renewed.data.recoveryCodes })
  console.log(`Made new recovery codes (${state.recoveryCodes.length} were left).`)
  return token
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--code')) {
    const state = readState()
    if (state === null) fail('No authenticator on record (e2e/.auth/admin-mfa.json); run the bootstrap first.')
    console.log(await freshCode(state))
    return
  }

  const state = readState()
  const sign = await login()
  let token
  if (sign.purpose === 'ENROLL') {
    token = await enroll(sign, state !== null)
  } else if (state === null) {
    fail(
      'The administrator is already enrolled on this stack, but the authenticator is not on record here (' +
        `${STATE_FILE.replace(/\\/g, '/').split('/frontend/').pop()} is missing): reset the stack or run the SQL reset in docs/SECURITY.md.`,
    )
  } else {
    token = await reuse(state, sign.challenge)
  }

  if (args.includes('--sample-content')) {
    const loaded = await call('POST', '/api/v1/admin/sample-content', token)
    if (loaded.status < 200 || loaded.status >= 300)
      fail(`Loading the sample content failed (HTTP ${loaded.status} ${loaded.code ?? ''}).`)
    console.log('Sample content loaded.')
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
