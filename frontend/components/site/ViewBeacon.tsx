'use client'

import { useEffect, useRef } from 'react'

/** app/api/views/route.ts: receives the slug (an optional second line is the previous page's host) as text/plain, returns 204. */
const ENDPOINT = '/api/views'

/** The sessionStorage key: one key per post, living until the tab closes. */
function storageKey(slug: string): string {
  return `viewed:${slug}`
}

/**
 * Storage can throw when merely touched (a browser blocking cookies, old private mode), so every
 * read/write is wrapped. If it cannot be read, treat it as not counted: counting one view too many is
 * a lighter fault than losing the views of a whole group of browsers entirely.
 */
function countedThisSession(slug: string): boolean {
  try {
    return sessionStorage.getItem(storageKey(slug)) !== null
  } catch {
    return false
  }
}

function rememberCounted(slug: string): void {
  try {
    sessionStorage.setItem(storageKey(slug), '1')
  } catch {
    // Xem countedThisSession.
  }
}

/**
 * The host of the page right before this post, never the whole URL; null when absent or not http(s).
 * `document.referrer` only speaks of the page just loaded: after client-side navigation (a path already different from the loaded page)
 * the previous page is the site itself.
 */
function referrerHost(): string | null {
  try {
    const loaded = performance.getEntriesByType?.('navigation')[0]?.name
    if (loaded && new URL(loaded).pathname !== location.pathname) return location.hostname
    const { protocol, hostname } = new URL(document.referrer)
    return (protocol === 'http:' || protocol === 'https:') && hostname !== '' ? hostname : null
  } catch {
    return null
  }
}

/**
 * `sendBeacon` first: the browser sends it even while the reader is leaving the page, and does not hold the page
 * waiting. The body is a string (the slug, possibly plus a host line) so the Content-Type is text/plain — a "simple
 * request", no preflight.
 * Without `sendBeacon`, or when it refuses to queue (returns false when the queue is full), `fetch` with
 * `keepalive`, the same properties. Network errors are swallowed: a view count is approximate, not worth
 * an error in the reader's console.
 */
function send(body: string): void {
  try {
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, body)) return
  } catch {
    // Some browsers throw instead of returning false; fall through to fetch.
  }
  fetch(ENDPOINT, {
    method: 'POST',
    body,
    keepalive: true,
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
  }).catch(() => {})
}

/**
 * Counts one view for the post being opened: once per session per post.
 *
 * Two guards against double counting, each for a different cause:
 * - `sessionStorage`: reloading the page, or returning to the post with the Back button, in the same tab.
 * - `ref`: StrictMode runs the effect twice (mount, fake unmount, mount again) on the SAME instance,
 *   so the ref still holds the first run's value. When storage is broken, the ref is the only guard left. The ref holds
 *   the slug, not a boolean: client-side navigation to another post may reuse this instance
 *   with a new slug, and the new post must still be counted.
 *
 * Draws nothing. The bot filter, the same-origin check and deduplication by IP live in the route handler.
 */
export function ViewBeacon({ slug }: { slug: string }) {
  const sentFor = useRef<string | null>(null)

  useEffect(() => {
    if (sentFor.current === slug) return
    sentFor.current = slug
    if (countedThisSession(slug)) return
    rememberCounted(slug)
    const host = referrerHost()
    send(host === null ? slug : `${slug}\n${host}`)
  }, [slug])

  return null
}
