import { bodyOf, nothingReply, runSecurityCall } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/disable `{ code }`: an author turns two-step verification off (the backend method is DELETE /me/mfa; the page
 * posts JSON like every other call here). An administrator is refused with 403 `MFA_REQUIRED`. Success ends every other session
 * and starts a new one for this browser (the cookies).
 *
 * The path must equal ENDPOINTS.disable in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return runSecurityCall(request, {
    path: '/api/v1/me/mfa',
    method: 'DELETE',
    body: bodyOf({ code: { required: true, max: 64 } }),
    reissues: true,
    reply: nothingReply,
  })
}
