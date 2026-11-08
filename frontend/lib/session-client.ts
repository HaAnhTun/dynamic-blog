import { useSyncExternalStore } from 'react'
import { callBff } from './bff-client'
import { clearClientSessionData } from './client-session-data'
import type { SessionUser, UserRole } from './types'

/**
 * The reader's session, browser side. Used only in client components.
 *
 * Public pages never read the cookie (reading it makes the page dynamic and loses ISR), so every
 * island that needs to know "who is reading" — the account button in the header, /profile, the like button, the comments section —
 * asks here, and this place asks `/api/session` after hydration.
 *
 * - One call per page load: module state, only the first subscribe makes the call, every island
 *   shares the result. Client-side navigation does not call again; signing in is always a full page
 *   load (OAuth goes through GitHub), so the store always starts over after that.
 * - The server snapshot is `loading` (the ThemeToggle precedent): HTML rendered on the server, cached HTML included,
 *   never carries user data.
 * - A failed call (502, network error, odd payload) becomes anonymous: the header shows the sign-in button, not stuck on
 *   loading. A real session may still exist; the next page load asks again.
 */

export type Session =
  | { status: 'loading' }
  /**
   * `loggedOut`: the user just clicked "Sign out" in this page load (`logout()`), unlike
   * an expired session (`setAnonymous()`). The header relies on it to announce "Signed out" and send focus back to the
   * sign-in button; a 401 on a like click must not move focus anywhere.
   */
  | { status: 'anonymous'; loggedOut: boolean }
  | { status: 'authenticated'; user: SessionUser }

const LOADING: Session = { status: 'loading' }
const GUEST: Session = { status: 'anonymous', loggedOut: false }

let current: Session = LOADING
let requested = false
const listeners = new Set<() => void>()

function publish(next: Session): void {
  current = next
  for (const listener of listeners) listener()
}

const ROLES: readonly UserRole[] = ['ADMIN', 'AUTHOR', 'USER']

/**
 * The contract of `/api/session` (app/api/session/route.ts), re-checked here because the header sits on every
 * page: a payload off the contract that breaks the account button breaks every page.
 */
function isSessionUser(value: unknown): value is SessionUser {
  if (value === null || typeof value !== 'object') return false
  const user = value as Record<string, unknown>
  const nullableString = (field: unknown) => field === null || typeof field === 'string'
  return (
    typeof user.displayName === 'string' &&
    nullableString(user.githubLogin) &&
    nullableString(user.avatarUrl) &&
    ROLES.some((role) => role === user.role) &&
    typeof user.joinedAt === 'string' &&
    typeof user.canAccessAdmin === 'boolean'
  )
}

async function load(): Promise<void> {
  const result = await callBff<unknown>('/api/session')
  // A setAnonymous() or logout() while waiting wins over the late answer: what the user
  // just saw happen must not be reversed by a stale response.
  if (current !== LOADING) return
  publish(result.ok && isSessionUser(result.data) ? { status: 'authenticated', user: result.data } : GUEST)
}

/** Only the first subscribe (always in the browser, after hydration) calls `/api/session`. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!requested) {
    requested = true
    void load()
  }
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Session {
  return current
}

function getServerSnapshot(): Session {
  return LOADING
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * The session right now, for code outside React: the unread-notification store
 * (lib/notifications-client.ts) only starts asking once the session is `authenticated`. Read only: never
 * calls /api/session itself — that call still only comes from the first subscribe of `useSession`.
 */
export function getSessionSnapshot(): Session {
  return current
}

/**
 * The session is lost without the user doing anything: a BFF route returned 401 (cookie expired, revoked).
 * Every island switches to the anonymous UI. Already anonymous does nothing.
 */
export function setAnonymous(): void {
  if (current.status === 'anonymous') return
  publish(GUEST)
}

/**
 * Sign out (steps 1–2): POST `/api/auth/logout` (revokes the refresh token, deletes both cookies),
 * then the browser's own copies of the person's data are cleared and the session becomes "logged out". Returns false when the request fails: the cookie is then still in the
 * browser, so the UI keeps the session instead of lying that it signed out. The remaining steps
 * (go home from /profile, announce "Signed out", focus) are AccountMenu's job.
 */
export async function logout(): Promise<boolean> {
  const result = await callBff<null>('/api/auth/logout', { method: 'POST' })
  if (!result.ok) return false
  // The browser keeps nothing of the person who left: unsaved editor drafts, recent searches, comment drafts (lib/client-session-data.ts).
  clearClientSessionData()
  publish({ status: 'anonymous', loggedOut: true })
  return true
}
