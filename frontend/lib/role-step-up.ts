import type { UserRole } from './types'

/**
 * Whether a change of role from `from` to `to` asks for the administrator's own code (and a sign-in from the last minutes): to or
 * from ADMIN, and a reader becoming AUTHOR (audit 111). Granting or taking away privilege is what a stolen admin session would use
 * to leave a durable foothold, so those changes want proof that the person at the keyboard holds the authenticator. Taking an
 * author back to reader needs none. The backend decides (RoleChangeService); this only chooses whether the screen shows the field,
 * so a mistake here costs a refusal with a sentence, never a wrong change.
 */
export function roleChangeNeedsCode(from: UserRole, to: UserRole): boolean {
  if (from === to) return false
  return from === 'ADMIN' || to === 'ADMIN' || (from === 'USER' && to === 'AUTHOR')
}
