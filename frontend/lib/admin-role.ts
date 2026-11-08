import 'server-only'
import { cookies } from 'next/headers'
import { getVerifiedRole } from './admin-api'
import { ApiError } from './api'
import { accessCookieName } from './auth-cookies'
import { roleOf } from './jwt'

/** Roles allowed into /admin. */
export type AdminRole = 'ADMIN' | 'AUTHOR'

export function isAdminRole(role: string | null): role is AdminRole {
  return role === 'ADMIN' || role === 'AUTHOR'
}

/**
 * The role in the request's access token, only used to choose the UI. The backend reads the current role from the DB on every admin
 * request, so a stale or forged claim only opens a shell whose data is still refused (403).
 */
export async function adminRole(): Promise<AdminRole | null> {
  const token = (await cookies()).get(accessCookieName())?.value
  const role = token ? roleOf(token) : null
  return isAdminRole(role) ? role : null
}

/**
 * The role the BACKEND confirms for the request's access token, for a route handler that has no backend call of its own and so would
 * otherwise rest on the unsigned claim `adminRole()` reads: a forged token with a role of ADMIN is a 401 there. Throws SessionExpiredError
 * when there is no session (no cookie, or the backend refuses the token); null for a role outside /admin and for a suspended account (403);
 * any other failure is passed on.
 */
export async function verifiedAdminRole(): Promise<AdminRole | null> {
  let role: string | null
  try {
    role = await getVerifiedRole()
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return null
    throw error
  }
  return isAdminRole(role) ? role : null
}
