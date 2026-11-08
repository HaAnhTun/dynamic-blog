/**
 * The sessionStorage keys of the comment form's drafts (components/site/comments/CommentSection.tsx), shared with the sign-out cleanup
 * (lib/client-session-data.ts) so that the two cannot drift apart. The root form keeps `<prefix><post slug>`, a reply or edit box
 * `<slot prefix><post slug>`.
 */
export const COMMENT_DRAFT_PREFIX = 'binh-luan:nhap:'
export const COMMENT_SLOT_DRAFT_PREFIX = 'binh-luan:nhap-cho:'
