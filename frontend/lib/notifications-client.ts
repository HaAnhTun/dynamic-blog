import { useSyncExternalStore } from 'react'
import { callBff, type BffResult } from './bff-client'
import { needsLogin } from './interaction-errors'
import { getSessionSnapshot, setAnonymous } from './session-client'

/**
 * The unread-notification count, browser side: the bell in the header, the dot on the avatar below sm, the
 * "Notifications (n)" item in the account panel, the "Mark all as read" button. Used only in
 * client components. No websocket, no push: it asks `/api/notifications/unread-count` on page load, when
 * returning to the tab and every 60 seconds. Module-level store like lib/session-client.ts: every island shares one
 * number and one polling beat.
 *
 * Who may start asking. `useUnreadCount()` may only be called in a component already under an `authenticated` session
 * (AccountDisclosure, BellControl, the inbox of /notifications). One more guard here:
 * subscribing only starts when `getSessionSnapshot()` is `authenticated`, and every ask re-checks. Anonymous visitors
 * and the time while the session is still being fetched send no notification request at all. When the session becomes
 * anonymous those components unmount; the last unsubscribe stops every timer.
 *
 * The polling beat:
 * - One request in flight at a time: a call made while one exists shares its promise.
 * - A 15 second brake on every automatic ask (at start, return to tab, every minute): StrictMode subscribe →
 *   unsubscribe → subscribe gives only one request, and the `visibilitychange` + `focus` pair on returning to the tab
 *   also gives just one. `refreshUnread()` (the reader just opened the panel or the notifications page) is not braked.
 * - Every 60 seconds while the tab is visible; a hidden tab drops the timer. On becoming visible again, or when the
 *   window gets `focus`: ask (through the 15 second brake) and reset the timer.
 * - Ordering: `writeEpoch` increases on every application of a write's number (mark read, mark all,
 *   delete). A request remembers the epoch at its start and drops its answer if the epoch changed: an old answer
 *   never brings back a badge that was just cleared.
 * - 401 or 403 while asking (a refresh losing a race, USER_SUSPENDED, the backend's `denyAll` before it restarted):
 *   stop automatic asking for this page load and set the number to null — the badge disappears. NEVER
 *   call `setAnonymous()` from a background ask: the user did nothing. Their next action
 *   (open the panel, open the page, click a notification) meets the same status, and that path calls `setAnonymous()`.
 *   A correct number coming from a reader action (a write, `refreshUnread()`) lets automatic asking
 *   resume: the session has proved it is still usable.
 * - Any other error (network, 5xx, payload off the contract): keep the old number, retry on the next beat.
 */

const UNREAD_URL = '/api/notifications/unread-count'
const POLL_MS = 60_000
const THROTTLE_MS = 15_000

let count: number | null = null
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
/** `Date.now()` when the most recent ask started. */
let lastFetchAt = Number.NEGATIVE_INFINITY
let writeEpoch = 0
/** A 401/403 while asking: no more automatic asking until a reader action returns a correct number. */
let stopped = false
let timer: ReturnType<typeof setInterval> | null = null
/** `visibilitychange` and `focus` are attached. */
let watching = false

function publish(next: number | null): void {
  if (next === count) return
  count = next
  for (const listener of listeners) listener()
}

/** The count from `{ count }` (`UnreadCountResponse`): a safe integer, not negative. Null when off the contract. */
export function parseUnreadCount(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const { count: candidate } = value as Record<string, unknown>
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
}

function signedIn(): boolean {
  return getSessionSnapshot().status === 'authenticated'
}

function tabVisible(): boolean {
  return document.visibilityState !== 'hidden'
}

function stopTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/** (Re)sets the 60 second beat: only while someone listens, the tab is visible and it is not stopped. */
function restartTimer(): void {
  stopTimer()
  if (stopped || listeners.size === 0 || !tabVisible()) return
  timer = setInterval(poll, POLL_MS)
}

function settle(result: BffResult<unknown>): void {
  if (result.ok) {
    const next = parseUnreadCount(result.data)
    if (next !== null) accept(next)
    return
  }
  if (result.status === 401 || result.status === 403) {
    stopped = true
    stopTimer()
    publish(null)
  }
}

/** A correct number from the server: automatic asking (if stopped) runs again. */
function accept(next: number): void {
  if (stopped) {
    stopped = false
    restartTimer()
  }
  publish(next)
}

/** Ask for the unread count now. A request already in flight is shared; when not signed in it does not ask. */
function fetchCount(): Promise<void> {
  if (inFlight !== null) return inFlight
  if (!signedIn()) return Promise.resolve()
  lastFetchAt = Date.now()
  const epoch = writeEpoch
  inFlight = callBff<unknown>(UNREAD_URL).then((result) => {
    inFlight = null
    // A write answered while waiting: its number is newer than this answer.
    if (epoch === writeEpoch) settle(result)
  })
  return inFlight
}

/** An automatic ask: goes through the 15 second brake, does not ask once stopped. */
function poll(): void {
  if (stopped || Date.now() - lastFetchAt < THROTTLE_MS) return
  void fetchCount()
}

function onVisibilityChange(): void {
  if (!tabVisible()) {
    stopTimer()
    return
  }
  poll()
  restartTimer()
}

function onFocus(): void {
  poll()
  restartTimer()
}

function start(): void {
  if (watching || !signedIn()) return
  watching = true
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onFocus)
  if (tabVisible()) poll()
  restartTimer()
}

function stop(): void {
  stopTimer()
  if (!watching) return
  watching = false
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onFocus)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

function getSnapshot(): number | null {
  return count
}

/** Server: null. HTML rendered on the server (and every cache of it) never carries anybody's number. */
function getServerSnapshot(): number | null {
  return null
}

/**
 * The unread-notification count, 0..100; null when unknown (not yet answered, or stopped after a 401/403). Call it only
 * in a component already under an `authenticated` session: the first mount starts asking.
 */
export function useUnreadCount(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Applies the number a write just returned (mark read, mark all, delete). Every request in flight is dropped. */
export function applyUnread(next: number): void {
  if (!Number.isSafeInteger(next) || next < 0) return
  writeEpoch += 1
  accept(next)
}

/**
 * Ask again at once, skipping the 15 second brake (still sharing a request already in flight): the reader just opened
 * the panel or the notifications page, and the number must match the list they are about to see. Never throws.
 */
export function refreshUnread(): Promise<void> {
  return fetchCount()
}

/**
 * The reader just opened a notification (clicked it): POST `/api/notifications/<id>/read` with `keepalive`, because
 * the page is navigating away to the post, then applies the number the server returns. Fire-and-forget style; never throws.
 * A 401 comes after a reader action, so the session becomes anonymous like every other 401.
 */
export async function markNotificationRead(id: string): Promise<void> {
  const result = await callBff<unknown>(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    keepalive: true,
  })
  if (result.ok) {
    const next = parseUnreadCount(result.data)
    if (next !== null) applyUnread(next)
    return
  }
  if (needsLogin(result.code, result.status)) setAnonymous()
}
