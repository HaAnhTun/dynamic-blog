import { bodyOf, runSecurityCall, secretReply } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/enroll/begin `{ currentPassword? }`: an author starts turning two-step verification on. The backend stores a
 * new secret as pending and answers it once; nothing about the account changes until the first code (enroll/confirm). An account
 * with a password also sends it. A sign-in older than ten minutes is refused with `reauthenticate: true`.
 *
 * The path must equal ENDPOINTS.enrollBegin in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/mfa/enroll/begin',
    method: 'POST',
    body: bodyOf({ currentPassword: { required: false, max: 512, trim: false } }),
    reissues: false,
    reply: secretReply,
  })
}
