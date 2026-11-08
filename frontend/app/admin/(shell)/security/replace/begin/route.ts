import { bodyOf, runSecurityCall, secretReply } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/replace/begin `{ code, currentPassword? }`: a new authenticator waits next to the current one, which keeps
 * working until the new one's first code is confirmed. The code is an authenticator code or a recovery code (the phone may be the
 * thing that was lost); an account with a password also sends it. The new secret is answered once.
 *
 * The path must equal ENDPOINTS.replaceBegin in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/mfa/replace/begin',
    method: 'POST',
    body: bodyOf({ code: { required: true, max: 64 }, currentPassword: { required: false, max: 512, trim: false } }),
    reissues: false,
    reply: secretReply,
  })
}
