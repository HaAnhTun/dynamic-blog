import type { Translator } from '@/i18n/translator'
import type { AuthorApplicationStatus, CommentStatus, UserRole, UserStatus } from '@/lib/types'

/*
 * Label keys and text colors of the statuses beyond posts: comments on the Comments page,
 * accounts and roles on the Users page. POST statuses stay in ui.ts (`postStatusLabel`), which the three
 * post screens have used from before. The tables hold keys of the `Admin.statuses` namespace; the look functions
 * take its translator as the last argument.
 *
 * The same rules as posts: color is never the only information (text always goes with it, see ToneBadge in
 * primitives.tsx), text is no paler than slate-500 (4.76:1 on white), and an unknown value — the backend
 * adding a status later — shows its name verbatim rather than becoming an empty cell.
 */

export type StatusLook = { label: string; tone: string }
type StatusEntry = { labelKey: string; tone: string }

const UNKNOWN_TONE = 'text-slate-600'

export const COMMENT_STATUS: Record<CommentStatus, StatusEntry> = {
  VISIBLE: { labelKey: 'comment.VISIBLE', tone: 'text-emerald-700' },
  HIDDEN: { labelKey: 'comment.HIDDEN', tone: 'text-amber-700' },
  DELETED: { labelKey: 'comment.DELETED', tone: 'text-slate-500' },
}

/**
 * The status is phrased as a state ("Currently …"), never the same text as a button: the suspend / unsuspend labels are actions (the buttons in
 * UserTable), while the suspended label is a state (the label on the Users page, the filter box, and beside the author name on the
 * Comments page). With identical text, a row labeled with the suspend word would sit right above a row with a suspend-word button.
 */
export const USER_STATUS: Record<UserStatus, StatusEntry> = {
  ACTIVE: { labelKey: 'user.ACTIVE', tone: 'text-emerald-700' },
  SUSPENDED: { labelKey: 'user.SUSPENDED', tone: 'text-red-700' },
}

/** In the filter box order: readers (the most numerous) first. */
export const USER_ROLE: Record<UserRole, string> = {
  USER: 'role.USER',
  AUTHOR: 'role.AUTHOR',
  ADMIN: 'role.ADMIN',
}

/** Author application: the label of the filter tab on the Author applications page, and of an application just decided. */
export const AUTHOR_APPLICATION_STATUS: Record<AuthorApplicationStatus, StatusEntry> = {
  PENDING: { labelKey: 'application.PENDING', tone: 'text-amber-700' },
  APPROVED: { labelKey: 'application.APPROVED', tone: 'text-emerald-700' },
  REJECTED: { labelKey: 'application.REJECTED', tone: 'text-red-700' },
}

function lookOf(map: Record<string, StatusEntry>, value: string, t: Translator): StatusLook {
  const entry = map[value]
  return entry === undefined ? { label: value, tone: UNKNOWN_TONE } : { label: t(entry.labelKey), tone: entry.tone }
}

export function commentStatusLook(status: string, t: Translator): StatusLook {
  return lookOf(COMMENT_STATUS, status, t)
}

export function userStatusLook(status: string, t: Translator): StatusLook {
  return lookOf(USER_STATUS, status, t)
}

export function authorApplicationStatusLook(status: string, t: Translator): StatusLook {
  return lookOf(AUTHOR_APPLICATION_STATUS, status, t)
}

export function roleLabel(role: string, t: Translator): string {
  const key = (USER_ROLE as Record<string, string | undefined>)[role]
  return key === undefined ? role : t(key)
}
