/**
 * The "one specific comment" target of a notification link: `/posts/<slug>#binh-luan-<uuid>`.
 *
 * Comments are lazy-loaded by keyset page, so `#binh-luan-<uuid>` is not the id of any element in the
 * HTML: the browser cannot scroll to it by itself. CommentSection finds the target by itself in two ways:
 * - on mount, it reads the URL anchor (`parseCommentTarget(location.hash)`);
 * - when the reader clicks a notification of the post that is already open. `<Link>` only changes the hash with `pushState`:
 *   the comment area does not remount, and no `hashchange` fires. The click site calls `requestCommentTarget`,
 *   which emits the window event `blog:comment-target`; the comment area listens to it through `onCommentTarget`.
 *
 * Only UUIDs are accepted: `#binh-luan` (the returnTo target of the login invitation) and `#binh-luan-heading` are never
 * misread as a comment.
 */

export const COMMENT_TARGET_PREFIX = 'binh-luan-'

/** Window event name; `detail` is `CommentTargetDetail`. */
export const COMMENT_TARGET_EVENT = 'blog:comment-target'

export type CommentTargetDetail = { id: string }

const TARGET = new RegExp(`^#${COMMENT_TARGET_PREFIX}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, 'i')

/**
 * id of the target comment, lowercase as the server returns it (to match `data-comment-id`), or null when `hash`
 * is not in the form `#binh-luan-<uuid>`.
 */
export function parseCommentTarget(hash: string): string | null {
  const id = TARGET.exec(hash)?.[1]
  return id === undefined ? null : id.toLowerCase()
}

/** Asks the comment area of the open page to find comment `id`: it reloads the first page and then focuses it. */
export function requestCommentTarget(id: string): void {
  window.dispatchEvent(new CustomEvent<CommentTargetDetail>(COMMENT_TARGET_EVENT, { detail: { id } }))
}

/**
 * Listens to `requestCommentTarget` calls. An id that is not a UUID (or an event without a correctly shaped `detail`)
 * is dropped here, before reaching the listener. Returns the unsubscribe function, for the effect's cleanup.
 */
export function onCommentTarget(listener: (id: string) => void): () => void {
  function handle(event: Event) {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null
    if (detail === null || typeof detail !== 'object') return
    const { id } = detail as Record<string, unknown>
    const target = typeof id === 'string' ? parseCommentTarget(`#${COMMENT_TARGET_PREFIX}${id}`) : null
    if (target !== null) listener(target)
  }
  window.addEventListener(COMMENT_TARGET_EVENT, handle)
  return () => window.removeEventListener(COMMENT_TARGET_EVENT, handle)
}
