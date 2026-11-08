import type { NextResponse } from 'next/server'
import { logoutResponse } from '@/lib/logout'

/**
 * POST /api/auth/logout: the reader logs out. Checks same origin and JSON,
 * revokes the refresh token at the backend, clears both cookies, returns 204. The "Sign out" button in the header calls it
 * through callBff, which sends `content-type: application/json` with every POST: logout is a change,
 * and a logout GET could be triggered by any `<img>` tag pointing at it.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return logoutResponse(request, { requireJson: true })
}
