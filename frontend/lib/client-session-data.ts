import { clearRecent } from '@/components/site/search/recent-searches'
import { COMMENT_DRAFT_PREFIX, COMMENT_SLOT_DRAFT_PREFIX } from './comment-draft-keys'
import { clearLocalDrafts } from './draft-storage'

/**
 * What this browser keeps for the person who is signing out, other than the cookies (those are the server's to clear): the post
 * editor's unsaved drafts (and the writes still pending), the recent searches, and the comment drafts kept across a session expiry. A shared
 * or borrowed machine must not hand them to the next person. The theme and the per-tab view marks are not about the person and stay.
 *
 * Called on every sign-out the browser performs: the public Sign out (`logout()` in lib/session-client.ts), the admin Sign out button and
 * Sign out everywhere. A session that merely expires is not a sign-out: the drafts stay, bound to their account, so that signing in again
 * restores them (components/admin/useDraftAutosave.ts). Never throws.
 */
export function clearClientSessionData(): void {
  clearLocalDrafts()
  clearRecent()
  clearSessionKeys([COMMENT_DRAFT_PREFIX, COMMENT_SLOT_DRAFT_PREFIX])
}

function clearSessionKeys(prefixes: readonly string[]): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index)
      if (key !== null && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key)
    }
    for (const key of keys) window.sessionStorage.removeItem(key)
  } catch {
    // Storage blocked: there is nothing stored to clear, and a sign-out must carry on.
  }
}
