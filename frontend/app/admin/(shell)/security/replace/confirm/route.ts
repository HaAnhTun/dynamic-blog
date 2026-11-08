import { bodyOf, recoveryCodesReply, runSecurityCall } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/replace/confirm `{ code }`: the first code of the NEW authenticator. Success swaps the secret, voids the old
 * recovery codes, ends every other session and starts a new one for this browser (the cookies), and answers ten new recovery codes,
 * shown once.
 *
 * The path must equal ENDPOINTS.replaceConfirm in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/mfa/replace/confirm',
    method: 'POST',
    body: bodyOf({ code: { required: true, max: 64 } }),
    reissues: true,
    reply: recoveryCodesReply,
  })
}
