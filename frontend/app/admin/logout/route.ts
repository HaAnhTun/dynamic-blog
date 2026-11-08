import type { NextResponse } from 'next/server'
import { logoutResponse } from '@/lib/logout'

/**
 * Admin logout: same behavior as before (origin check, revoke the refresh token at the backend,
 * clear both cookies, return 200 `{ ok: true }`), now a thin wrapper around lib/logout.ts so the
 * reader endpoint (/api/auth/logout) uses exactly one logout implementation. Does not require JSON:
 * LogoutButton sends a bare POST.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return logoutResponse(request, { success: 'ok-json', requireJson: false })
}
