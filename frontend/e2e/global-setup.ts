import { chromium } from '@playwright/test'
import { ensureRecoveryCodes, saveAdminPair, pairFromCookies, signInViaApi } from './support/admin-session'
import { signInAsAdminThroughForm } from './support/admin'
import { BASE_URL } from './support/env'
import { readMfaState } from './support/mfa-state'
import { prepareContext } from './support/network'

/**
 * Runs once before the suite. The administrator needs a second factor to sign in, so the suite signs in twice here and keeps both
 * sessions (support/admin-session.ts says how they are used and kept alive):
 *
 * 1. through the REAL sign-in form, with an authenticator code: the cookies the browser holds after it go to
 *    `e2e/.auth/admin-session.json` (Playwright's storageState shape), and are what `loginAsAdmin` gives every context. If the form, the
 *    second-step page or the cookie handling is broken, the suite stops here with that failure instead of failing a hundred specs;
 * 2. through the API, with a recovery code: the pair that support/backend.ts uses to call the admin API. Then, if fewer recovery
 *    codes are on record than a full run spends, ten new ones are made.
 *
 * Needs the authenticator on record that `node scripts/e2e-bootstrap.mjs` writes when it enrolls the stack's administrator.
 *
 * Under `E2E_PSEUDO=1` the first step is skipped: a stack built with `PSEUDO_LOCALE=1` shows every label accented and padded, so the
 * form cannot be found by its catalog text, and the only spec that runs against such a stack (pseudo-locale.spec.ts) reads public pages
 * and the sign-in page without signing in through the form. The API session is still made (its `backend` fixture reads a post).
 */
export default async function globalSetup(): Promise<void> {
  readMfaState()

  if (process.env.E2E_PSEUDO !== '1') {
    const browser = await chromium.launch({ channel: 'chrome' })
    try {
      const context = await browser.newContext({ baseURL: BASE_URL })
      await prepareContext(context)
      const page = await context.newPage()
      await signInAsAdminThroughForm(page, { proof: 'totp' })
      const pair = pairFromCookies(await context.cookies(BASE_URL))
      if (pair === null) throw new Error('The sign-in form left no session cookies in the browser.')
      saveAdminPair('browser', pair)
    } finally {
      await browser.close()
    }
  }

  const api = await signInViaApi('recovery')
  saveAdminPair('api', api)
  // Last, with the session just made: the specs that sign in with a recovery code burn them, and a run must not start short.
  await ensureRecoveryCodes(api.accessToken)
}
