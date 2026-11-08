import { finishSignIn, runSignInStep, stringField } from '@/lib/mfa-sign-in-route'

/**
 * POST /admin/login/mfa/submit `{ code }`: the second step of a sign-in. The code is a 6-digit authenticator code or a recovery code
 * (the backend decides by shape); the challenge comes from the `mfa_challenge` cookie that the first step set, never from the page.
 *
 * Success: the session cookies, the challenge cookie cleared, and `{ ok: true, recoveryCodesRemaining, usedRecoveryCode }` so that
 * the page can say how many recovery codes are left. The tokens are not in the body (lib/mfa-sign-in-route.ts).
 *
 * The path must equal MFA_ENDPOINT in app/admin/login/mfa/MfaForm.tsx and SIGN_IN_STEP_PATHS in proxy.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return runSignInStep(request, {
    path: '/api/v1/auth/mfa/verify',
    fields: (body) => {
      const code = stringField(body, 'code', 64)
      return typeof code === 'string' ? { code } : null
    },
    succeed: (data, context) => {
      const remaining = data.recoveryCodesRemaining
      return finishSignIn(
        data,
        {
          recoveryCodesRemaining: typeof remaining === 'number' ? remaining : 0,
          usedRecoveryCode: data.usedRecoveryCode === true,
        },
        context,
      )
    },
  })
}
