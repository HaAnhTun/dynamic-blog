import { bodyOf, nothingReply, runSecurityCall } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/password `{ currentPassword, newPassword, code? }`: changes the password of an account that has one. An
 * account with two-step verification also sends a code. The backend refuses while `ADMIN_PASSWORD` is set (409
 * `PASSWORD_MANAGED_BY_ENVIRONMENT`) and checks the password policy. Success ends every other session and starts a new one for this
 * browser (the cookies). The passwords are not trimmed: a space can be part of one.
 *
 * The path must equal ENDPOINTS.password in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/password',
    method: 'POST',
    body: bodyOf({
      currentPassword: { required: true, max: 512, trim: false },
      newPassword: { required: true, max: 512, trim: false },
      code: { required: false, max: 64 },
    }),
    reissues: true,
    reply: nothingReply,
  })
}
