import { signOutEverywhere } from '@/lib/admin-security-bff'

/**
 * POST /admin/security/sign-out-everywhere: ends every session of the account, this one included, through the existing
 * `POST /auth/sessions/revoke-all`, then clears both session cookies and answers the sign-in path. It needs no recent sign-in:
 * ending sessions is never the dangerous direction.
 *
 * The path must equal ENDPOINTS.signOutEverywhere in components/admin/security/endpoints.ts.
 */
export function POST(request: Request): Promise<Response> {
  return signOutEverywhere(request)
}
