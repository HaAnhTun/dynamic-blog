'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useEffectEvent, useReducer, useRef, useState, type RefObject } from 'react'
import { callBff, type BffResult } from '@/lib/bff-client'
import { COMMENT_DRAFT_PREFIX, COMMENT_SLOT_DRAFT_PREFIX } from '@/lib/comment-draft-keys'
import { onCommentTarget, parseCommentTarget } from '@/lib/comment-target'
import { interactionMessage, needsLogin, type InteractionContext } from '@/lib/interaction-errors'
import { setAnonymous, useSession } from '@/lib/session-client'
import type { CommentPage, SessionUser } from '@/lib/types'
import type { Locale } from '@/i18n/config'
import { postPath } from '../ArticleJsonLd'
import { Container, type ContainerWidth } from '../Container'
import { GitHubLoginLink } from '../GitHubLoginLink'
import { FOCUS, FOCUS_RING, TRANSITION } from '../SectionHeading'
import { CommentForm, SECONDARY, type SubmitResult } from './CommentForm'
import { CommentItem, type ItemAction } from './CommentItem'
import {
  INITIAL_STATE,
  commentsReducer,
  focusAfterDelete,
  parseCommentPage,
  parseLikeState,
  parseVisibleComment,
} from './comment-state'

/**
 * The comments area at the end of a post (root comments, one-level replies, editing and deleting your own).
 *
 * A client island in the ISR post page: the server HTML (and every cached copy of it) only has the heading and a
 * loading frame — no comments, no form, nothing belonging to the reader. After hydration:
 *   1. wait for the session store to answer /api/session (same reason as LikeButton: two requests carrying the same refresh
 *      token about to expire would race to rotate it, the losing request continues as a guest and `mine` is wrong);
 *   2. wait for this area to come near the screen (IntersectionObserver, 800px; without it, load immediately);
 *   3. GET the first page through the BFF route (no-store); "load more comments" continues by the keyset cursor.
 *
 * Writes (post, reply, edit, delete) go through same-origin BFF routes and are never optimistic: only what
 * the server returned is shown. Errors become Vietnamese sentences (lib/interaction-errors.ts, the `comment` context); a
 * 401 sends every island back to the guest UI, and the text being sent — of the root form, a reply box or an edit box — is
 * kept across signing in again.
 *
 * Focus always has somewhere to go: a comment just posted or replied, the first
 * comment just loaded, the button that opened a form when the form closes, the neighboring comment (or the heading) after deleting. But
 * a late result only moves focus when focus is still where the reader pressed (or has fallen back to <body>):
 * someone who moved to type in another form while waiting is left alone — the live region still announces the result.
 *
 * While a reply, edit or delete waits for the server, the open spot is locked: the action buttons become
 * `aria-disabled` and ignore presses. The waiting form or confirmation must still be there to receive the result — closing
 * it midway leaves a 429 no place to show and the text is lost with it, as if it had been sent; opening another spot
 * makes the later success close the wrong new spot. The lock does not last forever: the BFF route only waits for the backend
 * 10 seconds (lib/user-api.ts).
 *
 * Liking a comment is also server-confirmed, but locks no spot: it opens or closes no form,
 * and the like button blocks double presses itself. A 401 on liking follows the same path as a 401 on writing.
 *
 * The target comment: the link of a notification points to `#binh-luan-<uuid>`. That anchor is there at mount,
 * or arrives through the `blog:comment-target` event when the reader presses a notification of the post that is currently open
 * (lib/comment-target.ts; then the first page is reloaded so the new reply shows — unless replacing the
 * list would sweep away a box the reader is writing in, see `reload`). A target comment that is on the loaded pages is
 * scrolled to and receives focus; if not, focus goes to the area heading — no further page is loaded to find it.
 * All of this is client-side state: the cached HTML of the post page does not change at all.
 */

/** The id of the area: the `#binh-luan` target of returnTo after signing in. Unaccented, like `luot-thich`. */
export const COMMENTS_ANCHOR = 'binh-luan'
const HEADING_ID = 'binh-luan-heading'

/** At most 30 replies per root. With 30 visible replies the thread is certainly full: no invitation to reply. */
const MAX_REPLIES = 30

/** Start loading when the area is this far from the screen. */
const PRELOAD_MARGIN = '800px 0px'

/** The sign-in invitation: the same shape as a secondary button, but as tall as its text — a long sentence wraps at 320px. */
const LOGIN_CTA = `inline-flex min-h-11 items-center gap-2 rounded-md border border-neutral-300 px-4 py-2 text-left text-sm font-medium text-neutral-700 hover:border-brand hover:text-brand sm:min-h-9 dark:border-neutral-700 dark:text-neutral-300 ${TRANSITION} ${FOCUS_RING}`

/** Where focus goes after the next render. Set right before dispatch, in the same beat. */
type FocusTarget =
  | { kind: 'comment'; id: string }
  | { kind: 'action'; id: string; action: ItemAction }
  | { kind: 'heading' }
  | { kind: 'more' }
  | { kind: 'login' }
  /** The target comment of a notification: scroll to it then focus; if not on the loaded pages, the heading. */
  | { kind: 'target'; id: string }

/**
 * The target comment waiting for its page. `force`: the reader just pressed a notification, so focus goes to the
 * target wherever it currently is; an anchor at mount does not steal the focus of someone who moved elsewhere while waiting.
 */
type PendingTarget = { id: string; force: boolean }

/** The open form or confirmation: a single spot for the whole area (one reply form at a time). */
type OpenSlot = { kind: ItemAction; id: string }

function commentsUrl(slug: string, after: string | null = null): string {
  const base = `/api/posts/${encodeURIComponent(slug)}/comments`
  return after === null ? base : `${base}?after=${encodeURIComponent(after)}`
}

function commentUrl(id: string): string {
  return `/api/comments/${encodeURIComponent(id)}`
}

function articleIn(root: ParentNode | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`article[data-comment-id="${CSS.escape(id)}"]`) ?? null
}

/**
 * Whether a late result may move focus: yes, when focus is still inside `zone` — where the reader pressed
 * submit, about to close or change text — or has fallen back to <body> (Safari does not focus a button on mouse click). Focus
 * anywhere else means the reader moved on to something else while waiting: leave it alone.
 */
function focusStayedIn(zone: Element | null): boolean {
  const current = document.activeElement
  return current === null || current === document.body || (zone !== null && zone.contains(current))
}

/** One page, or null when it could not load (network error, 5xx, a payload that breaks the contract). */
async function fetchPage(slug: string, after: string | null): Promise<CommentPage | null> {
  const result = await callBff<unknown>(commentsUrl(slug, after))
  return result.ok ? parseCommentPage(result.data) : null
}

/** The status and code of a failed call; a 2xx with a payload that breaks the contract counts as a failing server. */
function failureOf(result: BffResult<unknown>): { status: number; code: string } {
  return result.ok ? { status: 502, code: 'BAD_RESPONSE' } : { status: result.status, code: result.code }
}

/**
 * The target of a notification: scroll so it is in the middle of the screen (the part above it also visible), then focus without scrolling again.
 * A comment taller than the screen (2000 characters in the ~230px column of a reply at 320px) has its top at the top
 * edge: centering would push the name, date and time and the edited label off the screen, and the reader would land in the middle of a block of
 * text. The sticky header does not cover the top edge: scrollIntoView takes the scroll-padding-top of <html>
 * (the header height, app/globals.css).
 */
function reveal(element: HTMLElement): void {
  const fits = element.getBoundingClientRect().height <= window.innerHeight
  element.scrollIntoView({ block: fits ? 'center' : 'start' })
  element.focus({ preventScroll: true })
}

/* The draft of the root form, across a session expiry (401). The design says "an error keeps the text", but a 401
   sends the area to the guest UI and the form disappears; the text goes to the sessionStorage of this tab, tied to exactly that
   author, and returns to the form when that person finishes signing in (returning to `#binh-luan`). Reading it deletes it. */

function ownerOf(user: SessionUser): string {
  return user.githubLogin !== null ? `gh:${user.githubLogin}` : `ten:${user.displayName}`
}

function saveDraft(slug: string, owner: string, text: string): void {
  try {
    sessionStorage.setItem(`${COMMENT_DRAFT_PREFIX}${slug}`, JSON.stringify({ owner, text }))
  } catch {
    // Storage blocked (old private mode): the draft is lost, as before it existed.
  }
}

function readDraft(slug: string, owner: string): string {
  try {
    const raw = sessionStorage.getItem(`${COMMENT_DRAFT_PREFIX}${slug}`)
    const draft: unknown = raw === null ? null : JSON.parse(raw)
    if (draft === null || typeof draft !== 'object') return ''
    const { owner: savedBy, text } = draft as Record<string, unknown>
    return savedBy === owner && typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

function dropDraft(slug: string): void {
  try {
    sessionStorage.removeItem(`${COMMENT_DRAFT_PREFIX}${slug}`)
  } catch {
    // Xem saveDraft.
  }
}

/* The draft of one spot (a reply box, an edit box) across a 401: the same way as the root form, plus which
   comment is the target. After signing in again, that spot reopens with exactly that text once the target comment has loaded —
   on the first page, or after "load more" if it is further away. Reading deletes it, whoever it belongs to. */

type SlotTarget = { kind: 'reply' | 'edit'; id: string }
type SlotDraft = SlotTarget & { text: string }

function saveSlotDraft(slug: string, owner: string, draft: SlotDraft): void {
  try {
    sessionStorage.setItem(`${COMMENT_SLOT_DRAFT_PREFIX}${slug}`, JSON.stringify({ owner, ...draft }))
  } catch {
    // Xem saveDraft.
  }
}

function takeSlotDraft(slug: string, owner: string): SlotDraft | null {
  try {
    const key = `${COMMENT_SLOT_DRAFT_PREFIX}${slug}`
    const raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    const draft: unknown = raw === null ? null : JSON.parse(raw)
    if (draft === null || typeof draft !== 'object') return null
    const { owner: savedBy, kind, id, text } = draft as Record<string, unknown>
    if (savedBy !== owner || (kind !== 'reply' && kind !== 'edit') || typeof id !== 'string') return null
    return typeof text === 'string' ? { kind, id, text } : null
  } catch {
    return null
  }
}

/** The spot of a draft that can still be reopened on the page just loaded: a root that still accepts replies, or your own comment that is still shown. */
function canReopen(draft: SlotDraft, loaded: CommentPage): boolean {
  for (const { comment: root, replies } of loaded.threads) {
    if (draft.kind === 'reply') {
      if (root.id === draft.id) return root.status === 'VISIBLE' && replies.length < MAX_REPLIES
      continue
    }
    const target = root.id === draft.id ? root : replies.find((reply) => reply.id === draft.id)
    if (target !== undefined) return target.status === 'VISIBLE' && target.mine
  }
  return false
}

export function CommentSection({
  slug,
  language,
  width = 'prose',
}: {
  slug: string
  language?: Locale
  /** The frame: `prose` by default, `bare` inside the post page's end slot, which is already a column. */
  width?: ContainerWidth
}) {
  // `key`: switching post (client-side navigation) is a brand new area, no request of the old post can touch
  // the new one. The same way as LikeButton.
  return <Comments key={slug} slug={slug} language={language} width={width} />
}

function Comments({ slug, language, width }: { slug: string; language?: Locale; width: ContainerWidth }) {
  const t = useTranslations('Site.comments')
  const tErrors = useTranslations('Errors.interaction')
  const session = useSession()
  const sessionKnown = session.status !== 'loading'
  const authenticated = session.status === 'authenticated'
  const [state, dispatch] = useReducer(commentsReducer, INITIAL_STATE)
  // The reference for "3 minutes ago": set whenever data arrives, and once a minute.
  const [now, setNow] = useState(0)
  const [open, setOpen] = useState<OpenSlot | null>(null)
  // A reply, edit or delete is waiting for the server: the open spot is locked. A ref blocks even the next
  // press (state only changes on the next render); state draws the action buttons `aria-disabled`.
  const writing = useRef(false)
  const [locked, setLocked] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  // A write just hit a 401: the sign-in invitation with the "session expired…" sentence.
  const [expired, setExpired] = useState(false)
  const section = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const login = useRef<HTMLAnchorElement>(null)
  // Where the reader pressed submit or load more (see focusStayedIn): the root form, a reply box, the "load more" button.
  const composer = useRef<HTMLDivElement>(null)
  const replyBox = useRef<HTMLDivElement>(null)
  const moreBox = useRef<HTMLDivElement>(null)
  const focusTarget = useRef<FocusTarget | null>(null)
  // The latest state for async functions (focus after deleting is computed on the data at the time the server answers).
  const latest = useRef(state)
  // A reply or edit draft already taken out of storage, still waiting for the target comment to load (see takeSlotDraft).
  const pendingDraft = useRef<SlotDraft | null>(null)
  // Pre-filled text for exactly the spot just reopened from a draft. Opening or closing any spot discards it.
  const [restored, setRestored] = useState<SlotDraft | null>(null)
  // The spot that is open right now, for async functions: a draft must not close, and a reload must not
  // sweep away, a box the reader is half-way through writing.
  const openNow = useRef(open)
  // The target comment of a notification, waiting for the first page (or the reloaded page) to arrive.
  const pendingTarget = useRef<PendingTarget | null>(null)
  // The number of the latest reload: the answer of an older one (a notification pressed twice) is dropped.
  const reloadSeq = useRef(0)
  // The generation of the list: increases when a reloaded first page is APPLIED, not when loading starts. A "load
  // more" that started in the previous generation carries the cursor of the old list: its result is dropped. A failed (or
  // unapplied) reload leaves the list as it was, and a "load more" in flight is still valid.
  const listEpoch = useRef(0)
  // The "load more" in flight, carrying the generation of the list it continues; null when none. It only blocks another press
  // on the SAME list: after a reload the button is usable at once even if the old call has not returned.
  const moreInFlight = useRef<number | null>(null)

  useEffect(() => {
    latest.current = state
  }, [state])

  useEffect(() => {
    openNow.current = open
  }, [open])

  const onFirstPage = useEffectEvent((loaded: CommentPage) => {
    settleFirstPage(loaded)
  })

  // The anchor `#binh-luan-<uuid>` at mount (the link of a notification): the area scrolls itself into view — which also
  // triggers the lazy load of the first page — and when the first page arrives it looks for the target comment.
  useEffect(() => {
    const id = parseCommentTarget(window.location.hash)
    if (id === null) return
    pendingTarget.current = { id, force: false }
    section.current?.scrollIntoView({ block: 'start' })
  }, [])

  const onTargetRequest = useEffectEvent((id: string) => {
    pendingTarget.current = { id, force: true }
    const { status } = latest.current
    if (status === 'idle' || status === 'loading') {
      // The first page has not returned (the area is far from the screen, or the request is in flight): scroll to the area so it loads. When the
      // first page arrives it looks for the target as with an anchor at mount.
      section.current?.scrollIntoView({ block: 'start' })
      return
    }
    void reload()
  })

  // The reader pressed a notification of this very post (lib/comment-target.ts): no remount, no hashchange.
  useEffect(() => onCommentTarget((id) => onTargetRequest(id)), [])

  // The first page: once the session is known and the area has come near the screen.
  useEffect(() => {
    if (!sessionKnown) return
    let active = true
    let observer: IntersectionObserver | null = null
    function load() {
      void fetchPage(slug, null).then((page) => {
        if (!active) return
        setNow(Date.now())
        dispatch(page === null ? { type: 'failed', more: false } : { type: 'page', page })
        if (page !== null) onFirstPage(page)
      })
    }
    const target = section.current
    if (typeof IntersectionObserver === 'undefined' || target === null) {
      load()
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          load()
        },
        { rootMargin: PRELOAD_MARGIN },
      )
      observer.observe(target)
    }
    return () => {
      active = false
      observer?.disconnect()
    }
  }, [sessionKnown, slug])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // Move focus to the arranged spot, once that element has entered the DOM.
  useEffect(() => {
    const target = focusTarget.current
    const root = section.current
    if (target === null || root === null) return
    focusTarget.current = null
    const element = resolveFocus(root, target, heading, login)
    if (element === null) return
    if (target.kind === 'target') reveal(element)
    else element.focus()
  })

  // The session turned into a guest (signed out in the header, a 401 somewhere): no more "mine", no form open.
  // Derived at render time instead of clearing state: nothing to synchronize, and nothing comes back to life in the wrong place.
  const active = authenticated ? open : null

  function openSlot(id: string, action: ItemAction) {
    if (writing.current) return
    setRestored(null)
    setOpen({ kind: action, id })
  }

  /** Cancel, Escape, or pressing "Reply" again: closes that spot, focus returns to the button that opened it. */
  function closeSlot(id: string, action: ItemAction) {
    if (writing.current) return
    focusTarget.current = { kind: 'action', id, action }
    closeIfOpen(id, action)
  }

  /** Closes exactly the spot `{action, id}` if it is still open; another spot is left alone. */
  function closeIfOpen(id: string, action: ItemAction) {
    setRestored(null)
    setOpen((current) => (current !== null && current.id === id && current.kind === action ? null : current))
  }

  /**
   * After signing in again: take the reply or edit draft of exactly this person out of storage (once),
   * then reopen its spot if the target comment is on the page just loaded — unless the reader is writing in
   * another spot (that box is not closed abruptly). Returns true when it reopened.
   */
  function restoreDraft(loaded: CommentPage): boolean {
    if (session.status === 'authenticated' && pendingDraft.current === null) {
      pendingDraft.current = takeSlotDraft(slug, ownerOf(session.user))
    }
    const draft = pendingDraft.current
    if (draft === null || writing.current || openNow.current !== null || !canReopen(draft, loaded)) return false
    pendingDraft.current = null
    setRestored(draft)
    setOpen({ kind: draft.kind, id: draft.id })
    return true
  }

  /**
   * The first page just arrived (a lazy load or "Retry"). If a draft can be reopened its box takes focus by itself and
   * the target comment (if any) is dropped: do not pull the reader away from text they are half-way through writing.
   */
  function settleFirstPage(loaded: CommentPage) {
    if (restoreDraft(loaded)) pendingTarget.current = null
    else aimAtTarget()
  }

  /**
   * Take the pending target comment (once). null when there is none, or when the target came from an anchor at mount and the
   * reader moved focus somewhere outside the area while waiting: do not steal their focus.
   */
  function takeTarget(): string | null {
    const target = pendingTarget.current
    pendingTarget.current = null
    if (target === null || (!target.force && !focusStayedIn(section.current))) return null
    return target.id
  }

  /** Arrange focus on the target comment after the next render. Set right before dispatching the page, in the same beat. */
  function aimAtTarget() {
    const id = takeTarget()
    if (id !== null) focusTarget.current = { kind: 'target', id }
  }

  /** A write into the open spot (reply, edit, delete): locks every spot until there is a result, including an error. */
  async function inSlot(write: () => Promise<SubmitResult>): Promise<SubmitResult> {
    writing.current = true
    setLocked(true)
    try {
      return await write()
    } finally {
      writing.current = false
      setLocked(false)
    }
  }

  /**
   * A failed write: the error sentence for the form. On a 401 the session is gone: save the draft (`text`; of the root form, or of
   * the reply or edit box `target` — those boxes disappear with the signed-in UI), send every
   * island to the guest UI, and move focus — if it is inside this area, i.e. on a button about to disappear —
   * to the sign-in link that just appeared.
   */
  function failed(result: BffResult<unknown>, text?: string, target?: SlotTarget): SubmitResult {
    const { status, code } = failureOf(result)
    if (needsLogin(code, status) && text !== undefined && session.status === 'authenticated') {
      const owner = ownerOf(session.user)
      if (target === undefined) saveDraft(slug, owner, text)
      else saveSlotDraft(slug, owner, { ...target, text })
    }
    return refused(status, code, 'comment')
  }

  /**
   * The error sentence for a failed write or like. 401: the sign-in invitation with the "session expired…" sentence,
   * focus to that link if it is inside the area, and every island to the guest UI.
   */
  function refused(status: number, code: string, context: InteractionContext): SubmitResult {
    if (needsLogin(code, status)) {
      if (section.current?.contains(document.activeElement)) focusTarget.current = { kind: 'login' }
      setExpired(true)
      setAnonymous()
    }
    return { ok: false, message: interactionMessage(tErrors, code, status, context) }
  }

  async function postRoot(text: string): Promise<SubmitResult> {
    setAnnouncement('')
    const result = await callBff<unknown>(commentsUrl(slug), { method: 'POST', body: JSON.stringify({ content: text }) })
    const created = result.ok ? parseVisibleComment(result.data) : null
    if (created === null) return failed(result, text)
    // `now` does not need to change: a just-created comment has a time after the reference being held, and relativeTime reads every
    // negative or under-a-minute interval as "just now". The root form is not a "spot": posting locks nothing,
    // so while waiting the reader may already have opened a reply box and be typing in it.
    if (focusStayedIn(composer.current)) focusTarget.current = { kind: 'comment', id: created.id }
    dispatch({ type: 'root-added', comment: created })
    setAnnouncement(t('announce.posted'))
    return { ok: true }
  }

  function postReply(rootId: string, text: string): Promise<SubmitResult> {
    return inSlot(async () => {
      setAnnouncement('')
      const result = await callBff<unknown>(`${commentUrl(rootId)}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: text }),
      })
      const created = result.ok ? parseVisibleComment(result.data) : null
      if (created === null) return failed(result, text, { kind: 'reply', id: rootId })
      if (focusStayedIn(replyBox.current)) focusTarget.current = { kind: 'comment', id: created.id }
      closeIfOpen(rootId, 'reply')
      dispatch({ type: 'reply-added', rootId, reply: created })
      setAnnouncement(t('announce.replied'))
      return { ok: true }
    })
  }

  function saveEdit(id: string, text: string): Promise<SubmitResult> {
    return inSlot(async () => {
      setAnnouncement('')
      const result = await callBff<unknown>(commentUrl(id), { method: 'PUT', body: JSON.stringify({ content: text }) })
      const saved = result.ok ? parseVisibleComment(result.data) : null
      if (saved === null || saved.id !== id) return failed(result, text, { kind: 'edit', id })
      if (focusStayedIn(articleIn(section.current, id))) focusTarget.current = { kind: 'action', id, action: 'edit' }
      closeIfOpen(id, 'edit')
      dispatch({ type: 'edited', comment: saved })
      setAnnouncement(t('announce.saved'))
      return { ok: true }
    })
  }

  /**
   * Like or unlike comment `id`: PUT or DELETE by the state at press time, then show exactly the
   * `{ liked, count }` the server returns — which may differ from "old plus one" when someone else also just liked. Errors are read
   * by the `like` context (a "this comment no longer exists" sentence, a "you are acting a bit fast" sentence).
   */
  async function toggleLike(id: string, likedNow: boolean): Promise<SubmitResult> {
    // Clear before every press: a sentence identical to the previous one is still a change of the live region, so it is still read.
    setAnnouncement('')
    const result = await callBff<unknown>(`${commentUrl(id)}/like`, { method: likedNow ? 'DELETE' : 'PUT' })
    const like = result.ok ? parseLikeState(result.data) : null
    if (like === null) {
      const { status, code } = failureOf(result)
      return refused(status, code, 'like')
    }
    dispatch({ type: 'liked', id, like })
    setAnnouncement(like.liked ? t('announce.liked') : t('announce.unliked'))
    return { ok: true }
  }

  function remove(id: string): Promise<SubmitResult> {
    return inSlot(async () => {
      setAnnouncement('')
      const result = await callBff<null>(commentUrl(id), { method: 'DELETE' })
      if (!result.ok) return failed(result)
      if (focusStayedIn(articleIn(section.current, id))) {
        const next = focusAfterDelete(latest.current, id)
        focusTarget.current = next === null ? { kind: 'heading' } : { kind: 'comment', id: next }
      }
      closeIfOpen(id, 'delete')
      dispatch({ type: 'deleted', id })
      setAnnouncement(t('announce.deleted'))
      return { ok: true }
    })
  }

  function retry() {
    // The retry button is about to give way to the loading frame: focus goes to the heading, not into <body>.
    heading.current?.focus()
    dispatch({ type: 'retry' })
    void fetchPage(slug, null).then((page) => {
      setNow(Date.now())
      dispatch(page === null ? { type: 'failed', more: false } : { type: 'page', page })
      if (page !== null) settleFirstPage(page)
    })
  }

  /**
   * The reader just pressed a notification of this very post: reload the first page — the new reply of
   * a thread on the first page is in it — replacing every loaded page, then look for the target comment.
   *
   * The list stays as it is, and the target is looked for right in it, when the reload fails, or when the new first page would
   * sweep away the spot where the reader is writing (`keepsOpenSlot`): replacing the list then loses the text being typed and
   * the result of a pending write has nowhere to show.
   */
  async function reload() {
    reloadSeq.current += 1
    const seq = reloadSeq.current
    const page = await fetchPage(slug, null)
    // A newer reload has started (a notification pressed twice): it will decide.
    if (seq !== reloadSeq.current) return
    if (page === null || !keepsOpenSlot(page)) {
      revealInPlace()
      return
    }
    // From here it is the new list: any "load more" still in flight carries the cursor of the old list.
    listEpoch.current += 1
    setNow(Date.now())
    aimAtTarget()
    dispatch({ type: 'reloaded', page })
  }

  /**
   * Whether the new first page can still keep the open spot. Yes, when no spot is open (and no write
   * is waiting), or when the comment of that spot is on the page: its thread is still in the new list so its `<li
   * key>` is still there, and the form and the text in it are not lost. An edit box or delete confirmation also needs the comment
   * to still be VISIBLE (a placeholder has no form). No: a thread loaded by "load more", or a comment just posted
   * in place when the first page is not yet the last page — both leave the list when it is replaced.
   */
  function keepsOpenSlot(loaded: CommentPage): boolean {
    const slot = openNow.current
    if (slot === null) return !writing.current
    for (const { comment: root, replies } of loaded.threads) {
      if (root.id === slot.id) return slot.kind === 'reply' || root.status === 'VISIBLE'
      const reply = replies.find((candidate) => candidate.id === slot.id)
      if (reply !== undefined) return reply.status === 'VISIBLE'
    }
    return false
  }

  /** Find the target comment right in the existing DOM: no render follows for a focus effect to run. */
  function revealInPlace() {
    const id = takeTarget()
    const element = id === null ? null : (articleIn(section.current, id) ?? heading.current)
    if (element !== null) reveal(element)
  }

  async function loadMore() {
    const cursor = latest.current.nextCursor
    const epoch = listEpoch.current
    if (moreInFlight.current === epoch || cursor === null) return
    moreInFlight.current = epoch
    dispatch({ type: 'more' })
    const page = await fetchPage(slug, cursor)
    // Only release the lock of this very call: after a reload, the lock may already belong to a newer one.
    if (moreInFlight.current === epoch) moreInFlight.current = null
    // The first page was reloaded while waiting: this cursor belongs to the old list, drop its result. That
    // reload already returned the button to its normal state (the "load more" of the new list).
    if (epoch !== listEpoch.current) return
    if (page === null) {
      dispatch({ type: 'failed', more: true })
      return
    }
    setNow(Date.now())
    // A draft is waiting for a comment on this page: its box reopens and takes focus by itself, pulling it nowhere else.
    const reopened = restoreDraft(page)
    // Loading more locks nothing: while waiting the reader may already have opened a reply box and be typing.
    if (!reopened && focusStayedIn(moreBox.current)) {
      const first = page.threads[0]
      focusTarget.current = first === undefined ? { kind: 'more' } : { kind: 'comment', id: first.comment.id }
    }
    dispatch({ type: 'page', page })
  }

  /** The text of the draft just reopened, only for exactly its own spot. */
  function draftFor(kind: SlotTarget['kind'], id: string): string | undefined {
    return restored !== null && restored.kind === kind && restored.id === id ? restored.text : undefined
  }

  const threads = [...state.threads, ...state.appended]
  const pendingFirst = state.status === 'idle' || state.status === 'loading'

  const block = (
    <section
      ref={section}
      id={COMMENTS_ANCHOR}
      aria-labelledby={HEADING_ID}
      className="border-t border-neutral-200 py-10 dark:border-neutral-800"
    >
      <h2 ref={heading} id={HEADING_ID} tabIndex={-1} className={`text-xl font-semibold tracking-tight ${FOCUS}`}>
        {t('heading')}
      </h2>

      {session.status === 'authenticated' ? (
        <div ref={composer} className="mt-6">
          <RootComposer slug={slug} owner={ownerOf(session.user)} onSubmit={postRoot} />
        </div>
      ) : session.status === 'anonymous' ? (
        <LoginPrompt slug={slug} language={language} expired={expired} linkRef={login} />
      ) : null}

      {pendingFirst ? <LoadingSkeleton /> : null}
      {state.status === 'error' ? (
        <div className="mt-8">
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {t('loadFailed')}
          </p>
          <button type="button" onClick={retry} className={`${SECONDARY} mt-3`}>
            {t('retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && threads.length === 0 ? (
        <p className="mt-8 text-neutral-600 dark:text-neutral-400">{t('empty')}</p>
      ) : null}

      {threads.length > 0 ? (
        <ol aria-busy={state.more === 'loading' || undefined} className="mt-8 space-y-8">
          {threads.map(({ comment: root, replies }) => {
            const slot = active?.id === root.id ? active.kind : null
            const replying = slot === 'reply'
            return (
              <li key={root.id}>
                <CommentItem
                  comment={root}
                  now={now}
                  mine={authenticated && root.mine}
                  canLike={authenticated}
                  canReply={authenticated && root.status === 'VISIBLE' && replies.length < MAX_REPLIES}
                  replyOpen={replying}
                  locked={locked}
                  mode={slot === 'edit' || slot === 'delete' ? slot : 'view'}
                  editDraft={draftFor('edit', root.id)}
                  onOpen={(action) => openSlot(root.id, action)}
                  onClose={(action) => closeSlot(root.id, action)}
                  onSave={(text) => saveEdit(root.id, text)}
                  onDelete={() => remove(root.id)}
                  onLike={(likedNow) => toggleLike(root.id, likedNow)}
                />
                {replies.length > 0 ? (
                  // Little indent on a phone (16px), more from sm: at 320px the text column of a reply still
                  // has ~230px. The left rule connects the replies to their root.
                  <ol className="mt-4 space-y-4 border-s border-neutral-200 ps-4 sm:ps-10 dark:border-neutral-800">
                    {replies.map((reply) => {
                      const replySlot = active?.id === reply.id ? active.kind : null
                      return (
                        <li key={reply.id}>
                          <CommentItem
                            comment={reply}
                            reply
                            now={now}
                            mine={authenticated && reply.mine}
                            canLike={authenticated}
                            locked={locked}
                            mode={replySlot === 'edit' || replySlot === 'delete' ? replySlot : 'view'}
                            editDraft={draftFor('edit', reply.id)}
                            onOpen={(action) => openSlot(reply.id, action)}
                            onClose={(action) => closeSlot(reply.id, action)}
                            onSave={(text) => saveEdit(reply.id, text)}
                            onDelete={() => remove(reply.id)}
                            onLike={(likedNow) => toggleLike(reply.id, likedNow)}
                          />
                        </li>
                      )
                    })}
                  </ol>
                ) : null}
                {replying ? (
                  <div ref={replyBox} className="mt-4 ps-4 sm:ps-10">
                    <CommentForm
                      label={t('replyForm.label')}
                      submitLabel={t('replyForm.submit')}
                      rows={3}
                      autoFocus
                      initialText={draftFor('reply', root.id)}
                      onCancel={() => closeSlot(root.id, 'reply')}
                      onSubmit={(text) => postReply(root.id, text)}
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}

      {state.nextCursor !== null ? (
        <div ref={moreBox} className="mt-8">
          {state.more === 'error' ? (
            <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-300">
              {t('loadFailed')}
            </p>
          ) : null}
          <button
            type="button"
            data-more=""
            onClick={() => {
              void loadMore()
            }}
            aria-disabled={state.more === 'loading' || undefined}
            className={SECONDARY}
          >
            {state.more === 'loading' ? t('loadingMore') : t('loadMore')}
          </button>
        </div>
      ) : null}

      {/* Always present, empty when there is nothing to say: a live region must exist BEFORE its text changes. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  )

  // print:hidden: the printout is the post, not the comments area.
  return width === 'bare' ? (
    <div className="print:hidden">{block}</div>
  ) : (
    <Container width={width} className="print:hidden">
      {block}
    </Container>
  )
}

function resolveFocus(
  root: HTMLElement,
  target: FocusTarget,
  heading: RefObject<HTMLHeadingElement | null>,
  login: RefObject<HTMLAnchorElement | null>,
): HTMLElement | null {
  const article = (id: string) => articleIn(root, id)
  switch (target.kind) {
    case 'comment':
    case 'target':
      return article(target.id) ?? heading.current
    case 'action':
      return article(target.id)?.querySelector<HTMLElement>(`[data-action="${target.action}"]`) ?? article(target.id)
    case 'more': {
      const more = root.querySelector<HTMLElement>('[data-more]')
      const articles = root.querySelectorAll<HTMLElement>('article[data-comment-id]')
      return more ?? articles[articles.length - 1] ?? heading.current
    }
    case 'heading':
      return heading.current
    case 'login':
      return login.current
  }
}

/**
 * The root form of a signed-in person. Opens with the draft left over from a session expiry (if it is the
 * right author), then deletes that draft from storage: it has returned to the form, and must not come back next time.
 */
function RootComposer({
  slug,
  owner,
  onSubmit,
}: {
  slug: string
  owner: string
  onSubmit: (text: string) => Promise<SubmitResult>
}) {
  const t = useTranslations('Site.comments')
  const [draft] = useState(() => readDraft(slug, owner))

  useEffect(() => {
    dropDraft(slug)
  }, [slug])

  return (
    <CommentForm
      label={t('rootForm.label')}
      submitLabel={t('rootForm.submit')}
      initialText={draft}
      clearOnSuccess
      onSubmit={onSubmit}
    />
  )
}

/**
 * Guest: the invitation to sign in with GitHub, returning to exactly this area. After a 401, the "session
 * expired…" sentence stands above it in `role="alert"`.
 */
function LoginPrompt({
  slug,
  language,
  expired,
  linkRef,
}: {
  slug: string
  language?: Locale
  expired: boolean
  linkRef: RefObject<HTMLAnchorElement | null>
}) {
  const t = useTranslations('Site.comments')
  const tErrors = useTranslations('Errors.interaction')
  return (
    <div className="mt-6">
      {expired ? (
        <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-300">
          {interactionMessage(tErrors, 'UNAUTHENTICATED', 401, 'comment')}
        </p>
      ) : null}
      <GitHubLoginLink ref={linkRef} locale={language} returnTo={`${postPath(slug)}#${COMMENTS_ANCHOR}`} className={LOGIN_CTA}>
        {t('loginPrompt')}
      </GitHubLoginLink>
    </div>
  )
}

/** The loading frame: a placeholder in the shape of two comments, `aria-busy`, and a sentence for screen readers. */
function LoadingSkeleton() {
  const t = useTranslations('Site.comments')
  return (
    <div aria-busy="true" className="mt-8 space-y-6">
      <p className="sr-only">{t('loading')}</p>
      {[0, 1].map((row) => (
        <div key={row} aria-hidden="true" className="flex items-start gap-3">
          <span className="h-8 w-8 shrink-0 rounded-full bg-neutral-100 dark:bg-neutral-900" />
          <span className="flex-1 space-y-2">
            <span className="block h-4 w-32 max-w-full rounded bg-neutral-100 dark:bg-neutral-900" />
            <span className="block h-4 w-full rounded bg-neutral-100 dark:bg-neutral-900" />
          </span>
        </div>
      ))}
    </div>
  )
}
