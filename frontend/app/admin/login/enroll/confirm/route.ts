import { finishSignIn, runSignInStep, stringField } from '@/lib/mfa-sign-in-route'

/**
 * POST /admin/login/enroll/confirm `{ code }`: the first code of the new authenticator. Success makes the enrollment active, signs
 * every other session of the account out and starts this one: the session cookies, the challenge cookie cleared, and
 * `{ ok: true, recoveryCodes }`, the ten recovery codes that are shown once and never again.
 *
 * The path must equal ENROLL_CONFIRM_ENDPOINT in app/admin/login/enroll/EnrollForm.tsx and SIGN_IN_STEP_PATHS in proxy.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return runSignInStep(request, {
    path: '/api/v1/auth/mfa/enroll/confirm',
    fields: (body) => {
      const code = stringField(body, 'code', 64)
      return typeof code === 'string' ? { code } : null
    },
    succeed: (data, context) => {
      const { recoveryCodes } = data
      if (!Array.isArray(recoveryCodes) || !recoveryCodes.every((code) => typeof code === 'string')) return null
      return finishSignIn(data, { recoveryCodes }, context)
    },
  })
}
