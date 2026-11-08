import { bodyOf, recoveryCodesReply, runSecurityCall } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/recovery-codes `{ code, currentPassword? }`: ten new recovery codes; the old ones stop working. The code is an
 * authenticator code or a recovery code (a person who lost the phone has nothing else), and an account with a password also sends
 * it. The session is not touched, so no cookie changes. The codes are answered once.
 *
 * The path must equal ENDPOINTS.recoveryCodes in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/mfa/recovery-codes/regenerate',
    method: 'POST',
    body: bodyOf({ code: { required: true, max: 64 }, currentPassword: { required: false, max: 512, trim: false } }),
    reissues: false,
    reply: recoveryCodesReply,
  })
}
