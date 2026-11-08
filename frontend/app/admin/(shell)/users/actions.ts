'use server'

import { updateTag } from 'next/cache'
import { runAdminAction } from '@/lib/admin-action'
import { resetAuthorMfa, setUserRole, setUserStatus } from '@/lib/admin-api'
import type { AdminUser, UserRole } from '@/lib/types'

/*
 * The actions of the Users page: suspend and unsuspend a reader, change role.
 * The backend decides everything: only an account with the USER role can be suspended, never the caller (409
 * USER_NOT_SUSPENDABLE), and suspension revokes every refresh token of that person in the same transaction.
 *
 * Accounts appear in cached public data: the profile page /u/<slug> (tag 'users', a
 * suspended person is a 404). So a successful suspend or unsuspend refreshes that tag; a role change changes nothing on the profile.
 * The screen applies the result to the row itself (UserTable).
 */

export type UserOutcome = AdminUser | { error: string }

/** Signs that person out at the next refresh, and blocks every comment and like from now on. */
export async function suspendUser(id: string): Promise<UserOutcome> {
  const outcome = await runAdminAction(() => setUserStatus(id, 'SUSPENDED'))
  if (!('error' in outcome)) updateTag('users')
  return outcome
}

/** Returns no session: that person signs in again with GitHub. */
export async function unsuspendUser(id: string): Promise<UserOutcome> {
  const outcome = await runAdminAction(() => setUserStatus(id, 'ACTIVE'))
  if (!('error' in outcome)) updateTag('users')
  return outcome
}

/**
 * Retyping the login to confirm is only a UI step (UserTable); the real gate is the backend: ADMIN only, there is always
 * at least one active admin, rate limit per admin. A change to or from ADMIN, or a reader becoming AUTHOR, carries the CALLER's own
 * code, which the backend checks together with a recent sign-in before it writes anything (audit 111); a wrong code, a delay, a frozen
 * second step and an old sign-in come back as their sentences (lib/admin-action.ts).
 */
export async function changeUserRole(id: string, role: UserRole, code?: string): Promise<UserOutcome> {
  return runAdminAction(() => setUserRole(id, role, code))
}

export type MfaResetOutcome = { done: true } | { error: string }

/**
 * An administrator resets an AUTHOR's two-step verification (the author lost the device and the recovery codes): the enrollment and the
 * recovery codes go and the author's sessions end. The code is the CALLER's own (an authenticator code or a recovery code), and the
 * backend wants a sign-in within the last ten minutes. The backend refuses an administrator as the target; that is the server owner's
 * job. A wrong code, a delay, a frozen second step and an old sign-in come back as their sentences (lib/admin-action.ts).
 */
export async function resetUserMfa(id: string, code: string): Promise<MfaResetOutcome> {
  const outcome = await runAdminAction(() => resetAuthorMfa(id, code))
  return outcome === null ? { done: true } : outcome
}
