/** One locale of a taxonomy row; blank or missing means "not translated" (the base text is used). Series titles live in `name`. */
export type LocalizedText = { name?: string | null; description?: string | null }

/**
 * `name` and `description` are already localized when the request named a language (`lang`) and for taxonomy embedded in a post
 * (the post's language), with fallback to the base text. `translations` is the raw map and only the admin API fills it.
 */
export type Category = {
  id: string
  name: string
  slug: string
  description: string | null
  translations?: Record<string, LocalizedText>
}

export type Tag = {
  id: string
  name: string
  slug: string
  translations?: Record<string, LocalizedText>
}

/** A published sibling of a post (another language of the same article). Never a draft in a public response. */
export type PostTranslation = {
  language: string
  slug: string
  title: string
  status: string
}

/**
 * The public author of a post: no id, email or role. `siteOwner` is computed by the server: true if and
 * only if the author is the site owner's account (the seeded admin), not every ADMIN.
 *
 * `profileSlug`: the public, immutable handle of the /u/<slug> page; null while that person is temporarily locked. Optional
 * because an older backend does not send it. Missing or null means the name does not become a link (lib/profile.ts `profileHref`).
 */
export type PostAuthor = {
  displayName: string
  githubLogin: string | null
  avatarUrl: string | null
  siteOwner: boolean
  profileSlug?: string | null
}

export type PostSummary = {
  id: string
  title: string
  slug: string
  excerpt: string | null
  status: string
  category: Category | null
  tags: Tag[]
  /**
   * Whether the author marked this post to lead the homepage. Independent of `status`: a
   * draft can be featured and simply will not appear anywhere until it is published.
   */
  featured: boolean
  /**
   * Estimated read time in whole minutes, never below 1. Computed by the backend from the
   * body, so it is present on every item of every listing — verified against the running
   * API, not assumed.
   *
   * Both of these were missing here while the API returned them on every item, and five
   * separate components worked around it by re-declaring the field locally as optional.
   * A type that does not describe its payload makes every consumer invent its own
   * guesses about what is there.
   */
  readingMinutes: number
  publishedAt: string | null
  /*
   * The four fields below are returned by the backend on EVERY post, but here they are optional, on
   * purpose: nearly twenty test files build `PostSummary` fixtures by hand, and making them
   * required would mean editing every file just to add `cover: null`. Readers must treat `undefined`
   * as an empty value.
   */
  /** The cover image, or null when the post has none (the UI draws generated cover art instead). */
  cover?: MediaRef | null
  /** The series the post belongs to, or null. */
  series?: SeriesRef | null
  /** Rank in "Featured posts" (1 is the top), or null when there is no rank. */
  featuredRank?: number | null
  /** Counted views. An approximate number; only shown once past a threshold. */
  viewCount?: number
  /**
   * The post's most recent write (an ISO-8601 instant), present on the list from a certain version on. Optional because an
   * older backend does not send it, and JSON is not checked at run time: whoever reads it must tolerate missing or broken — see
   * `modifiedOf` in app/sitemap.ts. `Post` redeclares it as required; the intersection
   * `(string | undefined) & string` is `string`, so the two declarations do not become `never`.
   */
  updatedAt?: string
  /** An older backend does not send it: then the blog had a single writer, so missing means the site owner. */
  author?: PostAuthor
  /** The language of the post (an enabled locale). Optional for the same reason as the fields above: hand-built fixtures. */
  language?: string
  /** The other published languages of the same article (never the post itself, never a draft); empty or missing when none. */
  translations?: PostTranslation[]
}

/**
 * `status` is NOT redeclared here. It lives on `PostSummary` and is inherited through
 * the intersection. Declaring it in both places is legal TypeScript and harmless right
 * up until the two declarations differ, at which point the intersection of the two
 * property types silently becomes `never` and the error surfaces nowhere near the cause.
 *
 * `updatedAt` is the one deliberate exception: optional on `PostSummary` (older backends do
 * not send it on listings), required here, where `PostResponse` has always carried it. The
 * two types are compatible — the intersection is plain `string` — and lib/types.test.ts pins
 * that, so a change that turned it into `never` would fail there first.
 */
export type Post = PostSummary & {
  content: string
  createdAt: string
  updatedAt: string
}

export type PageMeta = {
  page: number
  size: number
  totalElements: number
  totalPages: number
}

export type Page<T> = {
  items: T[]
  meta: PageMeta
}

/**
 * An uploaded image (`MediaResponse` in the backend). The bytes are served same-origin at
 * `/media/${fileName}` through app/media/[file]/route.ts; build that path only with
 * `mediaPath()` in lib/media.ts — next/image rejects a local src with a query string.
 */
export type MediaRef = {
  id: string
  /** `<uuid>.jpg` or `<uuid>.png`: the extension matches the stored type, exactly one URL per image. */
  fileName: string
  width: number
  height: number
  altText: string | null
  /** Lower case `#rrggbb`: the placeholder background colour while the image is loading. */
  dominantColor: string | null
}

/**
 * A reference to a series from a post (`SeriesRefResponse`).
 *
 * `position` is the stored position (starting at 1, may have gaps): use it to sort, NOT to write
 * "Part n". "Part n/m" is built only from `partNumber`/`partCount`, counted over the published parts;
 * both are null when the post is not published.
 */
export type SeriesRef = {
  id: string
  slug: string
  title: string
  position: number
  partNumber: number | null
  partCount: number | null
}

/** A part of a series in the series list (`SeriesPartRef`), in reading order. */
export type SeriesPartRef = {
  slug: string
  title: string
}

/** A series in `GET /api/v1/series` (`SeriesSummaryResponse`): only a series with at least
 *  one published post, so `latestPublishedAt` always has a value. */
export type SeriesSummary = {
  id: string
  title: string
  slug: string
  description: string | null
  postCount: number
  readingMinutes: number
  latestPublishedAt: string
  /** The published parts in reading order, so the /series page does not make one more call per series. */
  parts: SeriesPartRef[]
}

/** `GET /api/v1/series/{slug}` (`SeriesDetailResponse`): only the published parts, in
 *  reading order. */
export type SeriesDetail = {
  id: string
  title: string
  slug: string
  description: string | null
  posts: PostSummary[]
}

/** A photo in the public gallery (`GalleryPhotoResponse`). */
export type GalleryPhoto = {
  id: string
  image: MediaRef
  caption: string | null
  /** `yyyy-MM-dd`, no time zone: the day taken, not a moment in time. */
  takenOn: string | null
}

/** `GET /api/v1/stats` (`StatsResponse`). `seriesCount` counts only series that have published posts;
 *  `galleryPhotos` counts only the photos being shown. */
export type SiteStats = {
  publishedPosts: number
  totalViews: number
  seriesCount: number
  galleryPhotos: number
}

/* Admin-only types. */

/** A post in a series on the admin screen (`SeriesAdminPostResponse`), every status. */
export type SeriesAdminPost = {
  id: string
  title: string
  slug: string
  status: string
  position: number
}

/** `SeriesAdminResponse`: includes drafts, in `position` order. */
export type SeriesAdmin = {
  id: string
  title: string
  slug: string
  description: string | null
  posts: SeriesAdminPost[]
  createdAt: string
  updatedAt: string
}

/** `GalleryPhotoAdminResponse`: a gallery photo with the part only the admin sees. */
export type GalleryPhotoAdmin = GalleryPhoto & {
  published: boolean
  sortOrder: number
  /** The original file name, sanitized (basename only). Only the admin sees it. */
  originalFilename: string | null
  byteSize: number
  createdAt: string
  updatedAt: string
}

/* Reader accounts, comments, likes. */

export type UserRole = 'ADMIN' | 'AUTHOR' | 'USER'
export type UserStatus = 'ACTIVE' | 'SUSPENDED'

/**
 * What `/api/session` gives the browser: no id, no email, no token.
 * `canAccessAdmin` = ADMIN or AUTHOR (an AUTHOR enters /admin with a reduced menu).
 * `githubLogin` is null for an account that only signs in with a password: never print "@null".
 */
export type SessionUser = {
  displayName: string
  githubLogin: string | null
  avatarUrl: string | null
  role: UserRole
  joinedAt: string
  canAccessAdmin: boolean
}

export type CommentStatus = 'VISIBLE' | 'HIDDEN' | 'DELETED'

/**
 * The writer of a comment (`CommentAuthorResponse`): no id, email or role.
 *
 * `siteOwner`: computed by the server, true if and only if the writer is the site owner (the seeded admin) — the "Site owner" label
 * reads exactly this flag, never comparing a name or login (the display name follows the GitHub profile, anyone can set it).
 * If the backend does not have this field yet, the payload reader (comment-state.ts) fills in false.
 *
 * `profileSlug`: as in `PostAuthor`; when missing, the writer's name does not become a link.
 */
export type CommentAuthor = {
  displayName: string
  githubLogin: string | null
  avatarUrl: string | null
  siteOwner: boolean
  profileSlug?: string | null
}

/**
 * `GET /api/v1/users/{slug}`: only what a comment already made public, plus the join date and the number of posts
 * published. No id, email, role or status. `publishedPosts` > 0 means an author.
 */
export type UserProfile = {
  slug: string
  displayName: string
  githubLogin: string | null
  avatarUrl: string | null
  siteOwner: boolean
  /** ISO-8601 instant when the account was created. */
  joinedAt: string
  publishedPosts: number
}

/** `CommentResponse`. `content`/`author` are null when the comment is no longer VISIBLE (only a placeholder
 *  for the replies); `mine` is then always false.
 *
 *  The last three fields exist from a later backend version. An older backend does not send them:
 *  the payload reader (components/site/comments/comment-state.ts) fills in the old value for a missing field. */
export type PublicComment = {
  id: string
  status: CommentStatus
  content: string | null
  author: CommentAuthor | null
  createdAt: string
  edited: boolean
  mine: boolean
  /** The most recent edit. null when never edited, when no longer VISIBLE, or when an older backend does not send this field. */
  editedAt: string | null
  /** null: an older backend has no comment likes yet (not restarted); no like button is drawn. */
  likeCount: number | null
  /** The current reader has liked it. Always false for an anonymous visitor and when no longer VISIBLE. */
  likedByMe: boolean
}

export type CommentThread = { comment: PublicComment; replies: PublicComment[] }

/** A page of root comments by keyset; `nextCursor` is null at the end. */
export type CommentPage = { threads: CommentThread[]; nextCursor: string | null }

export type LikeState = { liked: boolean; count: number }

/** `CommentAdminResponse`: the content is always present, even for a hidden or deleted comment (moderation history). */
export type AdminComment = {
  id: string
  content: string
  status: CommentStatus
  reply: boolean
  createdAt: string
  editedAt: string | null
  postId: string
  postSlug: string
  postTitle: string
  postStatus: string
  authorId: string
  authorDisplayName: string
  authorGithubLogin: string | null
  authorAvatarUrl: string | null
  authorRole: UserRole
  authorStatus: UserStatus
}

/**
 * `MfaStatusResponse`, `GET /me/mfa`: what the Security page needs to know about the signed-in account, and nothing that identifies a
 * secret. `required`: every administrator, and an author once enrolled. `hasPassword`: the account has a password (authors have none).
 * `passwordManagedByEnvironment`: `ADMIN_PASSWORD` is set and applies to this account, so a password changed in the app would be undone
 * at the next start and the backend refuses it (409).
 */
export type MfaStatus = {
  enrolled: boolean
  required: boolean
  recoveryCodesRemaining: number
  hasPassword: boolean
  passwordManagedByEnvironment: boolean
}

/** `UserAdminResponse`: has no email. */
export type AdminUser = {
  id: string
  displayName: string
  githubLogin: string | null
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
  createdAt: string
  lastLoginAt: string | null
}

/* Applications to become an author. */

export type AuthorApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

/** One application, as the applicant sees it. `motivation`: trimmed, at most 500 characters, null when left empty. */
export type AuthorApplication = {
  id: string
  status: AuthorApplicationStatus
  motivation: string | null
  createdAt: string
  /** null while still PENDING. */
  decidedAt: string | null
}

/**
 * `GET /api/v1/me/author-application`: the caller's own latest application (never anyone else's), whether one can be submitted,
 * and when resubmitting is allowed after a rejection (30 days after `decidedAt`; null when there is no wait).
 */
export type MyAuthorApplication = {
  application: AuthorApplication | null
  canApply: boolean
  reapplyAfter: string | null
}

/** The applicant, as the admin sees them: no email. */
export type AuthorApplicant = {
  id: string
  displayName: string
  githubLogin: string | null
  avatarUrl: string | null
  role: UserRole
  status: UserStatus
}

/** One application at `GET /api/v1/admin/author-applications` (pending applications: oldest first). */
export type AdminAuthorApplication = AuthorApplication & { applicant: AuthorApplicant }

/** The common error body of the backend (`ErrorResponse`) and of the BFF route handlers. */
export type ApiErrorBody = { error: { code: string; message: string; traceId?: string } }

/* The reader's notifications. */

export type NotificationType = 'POST_LIKED' | 'POST_COMMENTED' | 'COMMENT_REPLIED' | 'COMMENT_LIKED'

/** The actor of a notification (`NotificationActorResponse`): enough to display, no id, email, role or status. */
export type NotificationActor = { displayName: string; githubLogin: string | null; avatarUrl: string | null }

/**
 * `NotificationResponse`. Not named `Notification`: it collides with the global DOM type.
 *
 * `post` is a post being published, read at answer time (a slug that just changed still gives the right link). `commentId` is a
 * comment that is still VISIBLE, already public; `excerpt` is the plain text of that same comment, at most 120 code points
 * plus "…" when cut. Both are null for `POST_LIKED`.
 */
export type UserNotification = {
  id: string
  type: NotificationType
  createdAt: string
  read: boolean
  actor: NotificationActor
  post: { slug: string; title: string }
  commentId: string | null
  excerpt: string | null
}

/**
 * A page of notifications, newest first. `nextCursor` is null at the end. `headCursor` exists only on a non-empty first page:
 * sent back as `before` of "mark all as read", so notifications that arrived after loading stay unread.
 */
export type NotificationPage = { items: UserNotification[]; nextCursor: string | null; headCursor: string | null }

/** `UnreadCountResponse`: 0..100, the server caps at 100 (the bell only shows "99+"). */
export type UnreadCount = { count: number }

// Editor — post revisions. Images in the post body use `MediaRef` above.

/**
 * One version in a post's history (`PostRevisionSummaryResponse`): has no content. Newest first, at most 20.
 * `createdAt` is when that text was replaced by a save (or a restore).
 */
export type PostRevisionSummary = {
  id: string
  title: string
  createdAt: string
}

/** A full revision (`PostRevisionResponse`): the text of the post at that time. */
export type PostRevision = PostRevisionSummary & {
  excerpt: string | null
  content: string
}

// Admin — image storage size and merging categories/tags.

/**
 * `GET /api/v1/admin/media/usage` (`MediaUsageResponse`): the total bytes of EVERY stored image (cover, gallery, post
 * body) — exactly the number the backend compares against the limit at upload time —, the configured limit (`app.media.max-total-size`)
 * and the image count.
 */
export type MediaUsage = { usedBytes: number; maxBytes: number; count: number }

/**
 * The result of merging a category or tag into another (`POST …/{id}/merge`): the target as the backend returns it, and the number of
 * posts that carried the source (every status, including posts that already carried the target). The source was deleted.
 */
export type TopicMerge<T> = { target: T; moved: number }

// Bookmarks

/** `GET`, `PUT`, `DELETE /api/v1/me/bookmarks/{slug}`: whether the post is in the caller's own saved list. */
export type BookmarkState = { bookmarked: boolean }

// Analytics

/** One day (`YYYY-MM-DD` in the backend's time zone) and the number of views recorded, the total across all sources. */
export type AnalyticsDay = { day: string; views: number }

export type AnalyticsTopPost = { id: string; slug: string; title: string; status: string; views: number }

/** `source`: one of six fixed groups (direct, search, social, github, internal, other). */
export type AnalyticsSource = { source: string; views: number }

/**
 * `GET /api/v1/admin/analytics`: ADMIN for the whole site, AUTHOR only for their own posts. Dates are `YYYY-MM-DD` in `timeZone`;
 * `daily` has every day of the range, `topPosts` at most 10, `sources` all six groups. `since`: the first day with daily
 * figures (null when there are none), before that there is only the `allTimeViews` total.
 */
export type Analytics = {
  from: string
  to: string
  timeZone: string
  since: string | null
  totals: { views: number; allTimeViews: number }
  daily: AnalyticsDay[]
  topPosts: AnalyticsTopPost[]
  sources: AnalyticsSource[]
}

// Newsletter

/** One send (a post's first publication): the number of mails by delivery status. `status` is the status of the send itself. */
export type NewsletterIssue = {
  postId: string
  slug: string
  title: string
  createdAt: string
  status: string
  sent: number
  retrying: number
  dead: number
  pending: number
}

/**
 * A newsletter waiting for an administrator (`GET /api/v1/admin/newsletter/held`): the first publication of a post by an AUTHOR.
 * `title` and `excerpt` are what a subscriber would read if it is released now; `published` is false while the post is taken
 * down (the mail then waits for it to be published again); `recipients` counts the confirmed subscribers of the post language.
 * The backend returns at most 100 of them, oldest first.
 */
export type HeldNewsletterIssue = {
  postId: string
  slug: string
  title: string
  excerpt: string | null
  language: string
  authorName: string | null
  heldAt: string
  published: boolean
  recipients: number
  /** Stands for the text shown (address, subject, excerpt, language): sent back with the release, which the backend refuses when the post changed since. */
  version: string
}

/** `GET /api/v1/admin/newsletter`: counts only, never addresses. `reason` is a safe error code. */
export type NewsletterStats = {
  subscribers: { pending: number; confirmed: number }
  suppressed: number
  issues: NewsletterIssue[]
  failures: { reason: string; count: number }[]
}

/**
 * One message of the contact inbox (`GET /api/v1/admin/contact/messages`). Holds a visitor's personal data: shown on the
 * ADMIN-only inbox page, never logged. `readAt` is null while unread.
 */
export type ContactMessage = {
  id: string
  name: string
  email: string
  subject: string | null
  message: string
  locale: string | null
  createdAt: string
  readAt: string | null
}
