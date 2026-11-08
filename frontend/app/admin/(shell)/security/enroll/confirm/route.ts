import { bodyOf, recoveryCodesReply, runSecurityCall } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/enroll/confirm `{ code }`: the first code of the new authenticator. Success turns two-step verification on, ends
 * every other session of the account and starts a new one for this browser (the cookies), and answers the ten recovery codes, shown once.
 *
 * The path must equal ENDPOINTS.enrollConfirm in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/mfa/enroll/confirm',
    method: 'POST',
    body: bodyOf({ code: { required: true, max: 64 } }),
    reissues: true,
    reply: recoveryCodesReply,
  })
}
