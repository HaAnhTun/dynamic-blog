'use server'

import { runAdminAction } from '@/lib/admin-action'
import { approveAuthorApplication, rejectAuthorApplication } from '@/lib/admin-api'
import type { AdminAuthorApplication } from '@/lib/types'

/*
 * Actions of the Author applications page. Retyping the login to confirm an approval is only a UI step
 * (AuthorApplicationList); the real gate is the backend: ADMIN only, nobody approves their own application, the approval goes
 * through the role-change service (lock, session revocation, per-admin rate limit). NO updateTag: applications do not appear in
 * any cached public data.
 */

export type ApplicationOutcome = AdminAuthorApplication | { error: string }

/** Approving makes a reader an author, which asks for the CALLER's own code and a recent sign-in (audit 111). */
export async function approveApplication(id: string, code?: string): Promise<ApplicationOutcome> {
  return runAdminAction(() => approveAuthorApplication(id, code))
}

export async function rejectApplication(id: string): Promise<ApplicationOutcome> {
  return runAdminAction(() => rejectAuthorApplication(id))
}
