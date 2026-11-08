/*
 * The post editor's local drafts in the browser's localStorage, without React: the editor hook (components/admin/useDraftAutosave.ts)
 * writes and reads them, and every place that ends a session clears them (lib/client-session-data.ts), including the public sign-out,
 * which must not load the editor to do it.
 *
 * ## Whose draft it is
 *
 * A draft belongs to the account that typed it: the key is `bai-viet:nhap:<userId>:<postId|moi>` (new post: `moi`) and the record
 * repeats the owner (`{ v: 2, owner, base, at, snapshot }`). A reader of the storage asks for its own account's key and also checks the
 * owner in the record, so the next person who signs in on the same browser is never offered, and cannot restore, what the last one left.
 * Version 1 records (no owner) are never read; the sweep deletes them.
 *
 * ## Who may write
 *
 * Only the account the admin shell is open for (`bindDraftOwner`, called by the shell on mount with the id in the session token). Signing
 * out (`clearLocalDrafts`) unbinds it first, so a debounce timer or a `pagehide` flush that is still pending in the open editor can no
 * longer put the text back, and tells the other tabs of this browser to do the same (a BroadcastChannel; a browser without one only
 * loses that last part). The next shell mount, a new sign-in, binds again.
 *
 * Every access sits in try/catch: private Safari or blocked cookies throw even on a read, and then the editor runs with no draft.
 */

/** The six boxes one Save sends; different from the saved version means there are unsaved changes. */
export type EditorSnapshot = {
  title: string
  slug: string
  excerpt: string
  content: string
  categoryId: string
  tagIds: string[]
  /** Absent in a draft stored before posts had a language: it then matches any language. */
  language?: string
}

export function sameSnapshot(a: EditorSnapshot, b: EditorSnapshot): boolean {
  return (
    a.title === b.title &&
    a.slug === b.slug &&
    a.excerpt === b.excerpt &&
    a.content === b.content &&
    a.categoryId === b.categoryId &&
    (a.language === undefined || b.language === undefined || a.language === b.language) &&
    a.tagIds.length === b.tagIds.length &&
    [...a.tagIds].sort().join(',') === [...b.tagIds].sort().join(',')
  )
}

export type StoredDraft = { v: 2; owner: string; base: string | null; at: string; snapshot: EditorSnapshot }

export const DRAFT_PREFIX = 'bai-viet:nhap:'
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The channel on which a sign-out in one tab tells the other tabs to stop writing drafts. */
export const SIGN_OUT_CHANNEL = 'blog:sign-out'

/** The account the admin shell of this tab is open for, or null: after a sign-out nobody may write a draft. */
let boundOwner: string | null = null

export function draftKey(owner: string, postId: string | null): string {
  return `${DRAFT_PREFIX}${owner}:${postId ?? 'moi'}`
}

const SNAPSHOT_TEXT = ['title', 'slug', 'excerpt', 'content', 'categoryId'] as const

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** A valid draft of version 2 that belongs to `owner`, or null. Trust nothing: storage is something anyone can edit. */
export function parseDraft(raw: string | null, owner: string): StoredDraft | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { v, owner: recordOwner, base, at, snapshot } = value as Record<string, unknown>
  if (v !== 2 || recordOwner !== owner || !isTime(at) || (base !== null && !isTime(base))) return null
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const fields = snapshot as Record<string, unknown>
  if (!SNAPSHOT_TEXT.every((name) => typeof fields[name] === 'string')) return null
  if (!Array.isArray(fields.tagIds) || !fields.tagIds.every((id) => typeof id === 'string')) return null
  return {
    v: 2,
    owner,
    base,
    at,
    snapshot: {
      title: fields.title as string,
      slug: fields.slug as string,
      excerpt: fields.excerpt as string,
      content: fields.content as string,
      categoryId: fields.categoryId as string,
      tagIds: [...(fields.tagIds as string[])],
      ...(typeof fields.language === 'string' ? { language: fields.language } : {}),
    },
  }
}

export function isExpired(draft: StoredDraft, now: number): boolean {
  return now - Date.parse(draft.at) > DRAFT_TTL_MS
}

/**
 * A draft no longer worth offering: identical to the server version, or the server version is newer than the draft was written
 * against. An existing post (`serverUpdatedAt` not null) whose draft has no `base` cannot be compared: dropped.
 */
export function isStale(draft: StoredDraft, serverUpdatedAt: string | null, server: EditorSnapshot): boolean {
  if (sameSnapshot(draft.snapshot, server)) return true
  if (serverUpdatedAt === null) return false
  if (draft.base === null) return true
  const serverAt = Date.parse(serverUpdatedAt)
  return Number.isNaN(serverAt) || serverAt > Date.parse(draft.base)
}

/* --- localStorage, every access inside try/catch ------------------------------------------------ */

export function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Writes only while `owner` is the account the shell is bound to: after a sign-out nothing may put a draft back. */
export function writeDraft(owner: string, key: string, draft: StoredDraft): void {
  if (boundOwner !== owner) return
  try {
    window.localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Blocked or full (QuotaExceededError): no draft this time, the editor still runs as before.
  }
}

export function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // See writeDraft.
  }
}

function draftKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null && key.startsWith(DRAFT_PREFIX)) keys.push(key)
  }
  return keys
}

/**
 * Keeps only the unexpired drafts of `owner` under their own key and deletes the rest: expired or broken records, drafts of any other
 * account, and the version 1 records that had no owner. A post opened once and then abandoned does not keep its text forever, and a
 * person who signs in on a browser someone else used finds none of that person's text there.
 */
export function sweepDrafts(owner: string, now: number): void {
  try {
    const own = `${DRAFT_PREFIX}${owner}:`
    for (const key of draftKeys()) {
      const draft = key.startsWith(own) ? parseDraft(readRaw(key), owner) : null
      if (draft === null || isExpired(draft, now)) removeDraft(key)
    }
  } catch {
    // See writeDraft.
  }
}

/* --- Who may write: the account the shell is bound to ----------------------------------------- */

/** True while `owner` is the account the admin shell is open for. The editor asks before it reads or writes anything. */
export function canWriteDrafts(owner: string): boolean {
  return boundOwner === owner
}

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(SIGN_OUT_CHANNEL) : null
  } catch {
    return null
  }
}

/**
 * The admin shell is open for `owner` (the id in the session token): that account may write drafts, the drafts of every other account
 * and the expired ones are deleted, and a sign-out in another tab unbinds this one. Returns the undo for the shell's unmount. Never throws.
 */
export function bindDraftOwner(owner: string, now: number = Date.now()): () => void {
  boundOwner = owner
  sweepDrafts(owner, now)
  const channel = openChannel()
  if (channel !== null) {
    channel.onmessage = () => {
      boundOwner = null
    }
  }
  return () => {
    try {
      channel?.close()
    } catch {
      // See writeDraft.
    }
    if (boundOwner === owner) boundOwner = null
  }
}

/**
 * Stops draft writes in this tab while a sign-out request is in flight and returns the undo for when the request fails (the session
 * is then still alive and the editor must go on saving). Does not touch the stored drafts or the other tabs.
 */
export function suspendDraftWrites(): () => void {
  const owner = boundOwner
  boundOwner = null
  return () => {
    if (boundOwner === null) boundOwner = owner
  }
}

/**
 * Deletes every editor draft in this browser and stops writing, here and in the other tabs. Called when a session ends on purpose: a
 * shared machine must not keep the unpublished text of the person who just left, and an editor still open must not put it back.
 * Never throws.
 */
export function clearLocalDrafts(): void {
  boundOwner = null
  try {
    for (const key of draftKeys()) removeDraft(key)
  } catch {
    // See writeDraft.
  }
  const channel = openChannel()
  try {
    channel?.postMessage('sign-out')
    channel?.close()
  } catch {
    // See writeDraft.
  }
}
