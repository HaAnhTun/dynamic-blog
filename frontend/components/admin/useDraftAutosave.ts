'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  draftKey,
  isExpired,
  isStale,
  parseDraft,
  readRaw,
  removeDraft,
  writeDraft,
  type EditorSnapshot,
  type StoredDraft,
} from '@/lib/draft-storage'

/*
 * The post editor's local draft: on every keystroke, after one second, the version being edited is copied into the
 * browser's localStorage; when a post is reopened and there is a copy newer than the saved version, the editor offers
 * to restore it.
 *
 * ## Why localStorage, when the design rule says not to copy content into the browser without a clear reason
 *
 * The clear reason is this: before this feature, every character typed since the last Save lived only in the memory of the tab. `beforeunload`
 * and the leave-the-page prompt block deliberate page exits, but not a crashed tab, a closed browser,
 * a dead battery, or a hasty click on Leave. Only localStorage survives those things;
 * sessionStorage dies with the tab. The price, and how it is kept small:
 *  - only on the writer's machine, by the site's origin; sent nowhere;
 *  - only while there are unsaved changes, and deleted as soon as there are none (saved, typed back to the saved version, post created);
 *  - bound to the account that typed it: the key and the record carry the user id, so another account is never offered it (a session that
 *    simply expires keeps its drafts, on purpose, so that signing in again restores them);
 *  - older than 7 days it is cleaned up, and so is every draft of another account, when the admin shell opens;
 *  - every sign-out that the browser sees deletes every draft and stops the writes that are still pending, in this tab and in the other
 *    open tabs (lib/draft-storage.ts, lib/client-session-data.ts);
 *  - every access sits in try/catch: private Safari or blocked cookies throw even on a read, and then
 *    the editor runs as before this feature, with no draft.
 *
 * ## Key and content
 *
 * `bai-viet:nhap:<userId>:<id>` (new post: `...:moi`), value `{ v: 2, owner, base, at, snapshot }`: `owner` is the user id again, `base` is
 * the `updatedAt` of the server version the draft was written against, `at` is the write time, `snapshot` is the six boxes one
 * Save sends.
 *
 * ## When to offer a restore
 *
 * Only the copy present in storage WHEN the editor OPENS, and only if it is still worth it: not expired, not identical to the
 * server version, and the server version not newer than `base` (saved in another tab or machine afterwards means the draft is stale, dropped
 * silently rather than overwriting). While an offer is showing, that copy is not overwritten: the writer has not answered yet, and it may be
 * hours of text.
 */

export { sameSnapshot, type EditorSnapshot } from '@/lib/draft-storage'

export const DRAFT_DEBOUNCE_MS = 1000

/* --- The draft at editor open, as an external store --------------------------------------------- */

/**
 * The draft in storage when ONE editor opens, per opening (`instance`, from useId). Read once and
 * kept: the editor rewrites this very storage key every second, and useSyncExternalStore needs a snapshot that does not
 * change, not the latest write of the editor itself. Per opening and not per storage key: an editor
 * rebuilt after a restore (`key` changes) has the old and the new instance living in the same frame, and the new one
 * must read the storage as of its own opening. The entry is dropped from here when the editor closes.
 *
 * Read through useSyncExternalStore rather than useState + useEffect: React uses the server snapshot (`undefined`,
 * "not read yet") for the server render and the hydrate render, then re-renders by itself with the real value, so the HTML
 * never mismatches; and the repo's lint rule forbids setState in an effect (the same way ThemeToggle reads the theme).
 */
const initialDrafts = new Map<string, string | null>()

function initialDraftOf(instance: string, key: string, owner: string | null): string | null {
  if (!initialDrafts.has(instance)) {
    const raw = owner === null ? null : readRaw(key)
    const draft = owner === null ? null : parseDraft(raw, owner)
    initialDrafts.set(instance, draft !== null && !isExpired(draft, Date.now()) ? raw : null)
  }
  return initialDrafts.get(instance) ?? null
}

/** Nothing to subscribe to: the draft at open time does not change during the editor's life. */
function subscribeNever(): () => void {
  return () => {}
}

function notReadOnServer(): undefined {
  return undefined
}

export type DraftAutosave = {
  /** The draft being offered for restore, or null. */
  offer: StoredDraft | null
  /** Stop offering and return the draft so the editor can refill the boxes. */
  restore: () => EditorSnapshot | null
  /** Discard: delete the draft and stop offering. */
  discard: () => void
  /** A new post was just created (the editor is about to navigate): delete the draft and stop writing. */
  forget: () => void
}

export function useDraftAutosave({
  owner,
  postId,
  base,
  current,
  saved,
  dirty,
}: {
  /** The signed-in account (its id in the session token); null when it is not known: nothing is read or written then. */
  owner: string | null
  postId: string | null
  /** `updatedAt` of the server version being opened; null for a new post. */
  base: string | null
  current: EditorSnapshot
  /** The latest saved version (new post: all boxes empty). */
  saved: EditorSnapshot
  dirty: boolean
}): DraftAutosave {
  const key = draftKey(owner ?? '', postId)
  const instance = `${key} ${useId()}`
  const raw = useSyncExternalStore(subscribeNever, () => initialDraftOf(instance, key, owner), notReadOnServer)
  const [answered, setAnswered] = useState(false)
  const candidate = useMemo(() => (typeof raw === 'string' && owner !== null ? parseDraft(raw, owner) : null), [raw, owner])
  const offer = !answered && candidate !== null && !isStale(candidate, base, saved) ? candidate : null
  const offering = offer !== null
  // undefined: storage could not be read yet (rendering on the server or hydrating). Not read means nothing is written and
  // nothing deleted: deleting then would delete exactly the draft about to be offered.
  const ready = raw !== undefined && owner !== null

  // The version waiting to be written (so pagehide can write it at once), and the "stop writing" flag of forget(). Only read and written in an effect
  // and a handler.
  const pending = useRef<StoredDraft | null>(null)
  const stopped = useRef(false)

  useEffect(() => () => void initialDrafts.delete(instance), [instance])

  const serialized = JSON.stringify(current)
  useEffect(() => {
    if (!ready || offering || stopped.current) return
    if (!dirty) {
      pending.current = null
      removeDraft(key)
      return
    }
    const draft: StoredDraft = { v: 2, owner, base, at: '', snapshot: JSON.parse(serialized) as EditorSnapshot }
    pending.current = draft
    const timer = window.setTimeout(() => {
      pending.current = null
      if (!stopped.current) writeDraft(owner, key, { ...draft, at: new Date().toISOString() })
    }, DRAFT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [key, owner, ready, offering, dirty, base, serialized])

  // Closing or reloading the tab during the one-second wait: write at once, storage is synchronous so it finishes before the page disappears.
  useEffect(() => {
    function flush() {
      const draft = pending.current
      pending.current = null
      if (draft !== null && owner !== null && !stopped.current) writeDraft(owner, key, { ...draft, at: new Date().toISOString() })
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [key, owner])

  const restore = useCallback((): EditorSnapshot | null => {
    setAnswered(true)
    return offer === null ? null : offer.snapshot
  }, [offer])

  const discard = useCallback(() => {
    setAnswered(true)
    removeDraft(key)
  }, [key])

  const forget = useCallback(() => {
    stopped.current = true
    pending.current = null
    removeDraft(key)
  }, [key])

  return { offer, restore, discard, forget }
}
