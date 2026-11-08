// @vitest-environment node
import { describe, expectTypeOf, it } from 'vitest'
import type {
  AdminComment,
  AdminUser,
  ApiErrorBody,
  CommentAuthor,
  CommentPage,
  CommentStatus,
  CommentThread,
  GalleryPhoto,
  GalleryPhotoAdmin,
  LikeState,
  MediaRef,
  NotificationActor,
  NotificationPage,
  NotificationType,
  Post,
  PostAuthor,
  PostSummary,
  PublicComment,
  SeriesAdmin,
  SeriesAdminPost,
  SeriesDetail,
  SeriesPartRef,
  SeriesRef,
  SeriesSummary,
  SessionUser,
  SiteStats,
  UnreadCount,
  UserNotification,
  UserProfile,
  UserRole,
  UserStatus,
} from './types'

/**
 * The type contract with the backend records.
 *
 * `expectTypeOf` does nothing at run time: these asserts are checked by `npm run typecheck`
 * (tsc reads every test file). At run time Vitest only sees empty green `it`s — the real red is in tsc.
 * Each fixture below is exactly the JSON shape the backend returns for the matching record, so a field
 * renamed or with changed nullability on one side goes red here before it becomes `undefined` on a page.
 */
describe('lib/types: the contract with the backend', () => {
  it('the new fields on PostSummary are all optional, because many test files build PostSummary fixtures', () => {
    expectTypeOf<PostSummary['cover']>().toEqualTypeOf<MediaRef | null | undefined>()
    expectTypeOf<PostSummary['series']>().toEqualTypeOf<SeriesRef | null | undefined>()
    expectTypeOf<PostSummary['featuredRank']>().toEqualTypeOf<number | null | undefined>()
    expectTypeOf<PostSummary['viewCount']>().toEqualTypeOf<number | undefined>()

    // An old-style fixture is still valid: none of the four new fields.
    expectTypeOf({
      id: 'p1',
      title: 't',
      slug: 's',
      excerpt: null,
      status: 'PUBLISHED',
      category: null,
      tags: [],
      featured: false,
      readingMinutes: 1,
      publishedAt: null,
    }).toExtend<PostSummary>()
  })

  it('Post inherits the new fields through the intersection, not redeclared', () => {
    expectTypeOf<Post['cover']>().toEqualTypeOf<PostSummary['cover']>()
    expectTypeOf<Post['series']>().toEqualTypeOf<PostSummary['series']>()
    expectTypeOf<Post['viewCount']>().toEqualTypeOf<PostSummary['viewCount']>()
  })

  it('author: optional on PostSummary, inherited on Post; no id, email or role', () => {
    expectTypeOf<PostSummary['author']>().toEqualTypeOf<PostAuthor | undefined>()
    expectTypeOf<Post['author']>().toEqualTypeOf<PostSummary['author']>()
    expectTypeOf<PostAuthor>().toEqualTypeOf<{
      displayName: string
      githubLogin: string | null
      avatarUrl: string | null
      siteOwner: boolean
      profileSlug?: string | null
    }>()
  })

  it('UserProfile: a public profile, no id, email, role or status', () => {
    expectTypeOf<UserProfile>().toEqualTypeOf<{
      slug: string
      displayName: string
      githubLogin: string | null
      avatarUrl: string | null
      siteOwner: boolean
      joinedAt: string
      publishedPosts: number
    }>()
  })

  it('updatedAt: optional on PostSummary, still required on Post', () => {
    // The post list only has `updatedAt` from a certain version on, and an older backend does not send it: the reader must treat
    // `undefined` as "unknown". The full post (`PostResponse`) has it from the start, and the intersection keeps it
    // required: `(string | undefined) & string` is `string`, not `never`.
    expectTypeOf<PostSummary['updatedAt']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Post['updatedAt']>().toEqualTypeOf<string>()
  })

  it('MediaRef = MediaResponse(id, fileName, width, height, altText, dominantColor)', () => {
    expectTypeOf<MediaRef>().toEqualTypeOf<{
      id: string
      fileName: string
      width: number
      height: number
      altText: string | null
      dominantColor: string | null
    }>()
  })

  it('SeriesRef carries nullable partNumber/partCount, separate from position', () => {
    // "Part n/m" is built only from partNumber/partCount (counted over the published parts), never
    // from position (which may have gaps). Both are null when the post is not published.
    expectTypeOf<SeriesRef>().toEqualTypeOf<{
      id: string
      slug: string
      title: string
      position: number
      partNumber: number | null
      partCount: number | null
    }>()
  })

  it('SeriesSummary has the list of parts in reading order, so the /series page avoids N+1', () => {
    expectTypeOf<SeriesPartRef>().toEqualTypeOf<{ slug: string; title: string }>()
    expectTypeOf<SeriesSummary>().toEqualTypeOf<{
      id: string
      title: string
      slug: string
      description: string | null
      postCount: number
      readingMinutes: number
      latestPublishedAt: string
      parts: SeriesPartRef[]
    }>()
    expectTypeOf<SeriesDetail>().toEqualTypeOf<{
      id: string
      title: string
      slug: string
      description: string | null
      posts: PostSummary[]
    }>()
  })

  it('GalleryPhoto and its admin version', () => {
    expectTypeOf<GalleryPhoto>().toEqualTypeOf<{
      id: string
      image: MediaRef
      caption: string | null
      takenOn: string | null
    }>()
    expectTypeOf<GalleryPhotoAdmin>().toExtend<GalleryPhoto>()
    expectTypeOf<Omit<GalleryPhotoAdmin, keyof GalleryPhoto>>().toEqualTypeOf<{
      published: boolean
      sortOrder: number
      originalFilename: string | null
      byteSize: number
      createdAt: string
      updatedAt: string
    }>()
  })

  it('SiteStats and the admin type of series', () => {
    expectTypeOf<SiteStats>().toEqualTypeOf<{
      publishedPosts: number
      totalViews: number
      seriesCount: number
      galleryPhotos: number
    }>()
    expectTypeOf<SeriesAdminPost>().toEqualTypeOf<{
      id: string
      title: string
      slug: string
      status: string
      position: number
    }>()
    expectTypeOf<SeriesAdmin>().toEqualTypeOf<{
      id: string
      title: string
      slug: string
      description: string | null
      posts: SeriesAdminPost[]
      createdAt: string
      updatedAt: string
    }>()
  })
})

/**
 * The reader account, comment and like contract. The matching backend records
 * are the user, comment and like responses; `SessionUser` is a shape built by /api/session itself, not a backend
 * record.
 */
describe('lib/types: reader account, comments, likes', () => {
  it('role and status are closed sets, matching the backend enums', () => {
    expectTypeOf<UserRole>().toEqualTypeOf<'ADMIN' | 'AUTHOR' | 'USER'>()
    expectTypeOf<UserStatus>().toEqualTypeOf<'ACTIVE' | 'SUSPENDED'>()
    expectTypeOf<CommentStatus>().toEqualTypeOf<'VISIBLE' | 'HIDDEN' | 'DELETED'>()
  })

  it('SessionUser carries no id, email, status or token', () => {
    expectTypeOf<SessionUser>().toEqualTypeOf<{
      displayName: string
      githubLogin: string | null
      avatarUrl: string | null
      role: UserRole
      joinedAt: string
      canAccessAdmin: boolean
    }>()
    // The reverse test: adding one of the forbidden fields makes it no longer equal to the type above.
    expectTypeOf<SessionUser>().not.toHaveProperty('id')
    expectTypeOf<SessionUser>().not.toHaveProperty('email')
    expectTypeOf<SessionUser>().not.toHaveProperty('status')
    expectTypeOf<SessionUser>().not.toHaveProperty('accessToken')
  })

  it('PublicComment = CommentResponse; content and author may be null once no longer VISIBLE', () => {
    // `siteOwner`: the writer is the site owner (the seeded admin). A flag computed by the server, not a role:
    // the reader still does not know who is an AUTHOR or a USER.
    expectTypeOf<CommentAuthor>().toEqualTypeOf<{
      displayName: string
      githubLogin: string | null
      avatarUrl: string | null
      siteOwner: boolean
      profileSlug?: string | null
    }>()
    expectTypeOf<CommentAuthor>().not.toHaveProperty('role')
    expectTypeOf<PublicComment>().toEqualTypeOf<{
      id: string
      status: CommentStatus
      content: string | null
      author: CommentAuthor | null
      createdAt: string
      edited: boolean
      mine: boolean
      editedAt: string | null
      likeCount: number | null
      likedByMe: boolean
    }>()
    expectTypeOf<CommentThread>().toEqualTypeOf<{ comment: PublicComment; replies: PublicComment[] }>()
    expectTypeOf<CommentPage>().toEqualTypeOf<{ threads: CommentThread[]; nextCursor: string | null }>()
    expectTypeOf<LikeState>().toEqualTypeOf<{ liked: boolean; count: number }>()
  })

  it('AdminComment = CommentAdminResponse: only a few fields of the post, never the post content', () => {
    expectTypeOf<AdminComment>().toEqualTypeOf<{
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
    }>()
  })

  it('AdminUser = UserAdminResponse, has no email', () => {
    expectTypeOf<AdminUser>().toEqualTypeOf<{
      id: string
      displayName: string
      githubLogin: string | null
      avatarUrl: string | null
      role: UserRole
      status: UserStatus
      createdAt: string
      lastLoginAt: string | null
    }>()
    expectTypeOf<AdminUser>().not.toHaveProperty('email')
  })

  it('ApiErrorBody = ErrorResponse(ErrorBody(code, message, traceId))', () => {
    expectTypeOf<ApiErrorBody>().toEqualTypeOf<{ error: { code: string; message: string; traceId?: string } }>()
  })
})

/** The notification contract: the reader's notification inbox. */
describe('lib/types: notifications', () => {
  it('four types, matching the CHECK of the notifications table', () => {
    expectTypeOf<NotificationType>().toEqualTypeOf<'POST_LIKED' | 'POST_COMMENTED' | 'COMMENT_REPLIED' | 'COMMENT_LIKED'>()
  })

  it('UserNotification = NotificationResponse; the actor carries no id, email, role or status', () => {
    expectTypeOf<NotificationActor>().toEqualTypeOf<{
      displayName: string
      githubLogin: string | null
      avatarUrl: string | null
    }>()
    expectTypeOf<NotificationActor>().not.toHaveProperty('id')
    expectTypeOf<NotificationActor>().not.toHaveProperty('email')
    expectTypeOf<NotificationActor>().not.toHaveProperty('role')
    expectTypeOf<NotificationActor>().not.toHaveProperty('status')
    expectTypeOf<UserNotification>().toEqualTypeOf<{
      id: string
      type: NotificationType
      createdAt: string
      read: boolean
      actor: NotificationActor
      post: { slug: string; title: string }
      commentId: string | null
      excerpt: string | null
    }>()
  })

  it('NotificationPage has a headCursor for "mark all as read"; every write returns UnreadCount', () => {
    expectTypeOf<NotificationPage>().toEqualTypeOf<{
      items: UserNotification[]
      nextCursor: string | null
      headCursor: string | null
    }>()
    expectTypeOf<UnreadCount>().toEqualTypeOf<{ count: number }>()
  })
})
