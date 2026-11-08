import 'server-only'
import { cookies } from 'next/headers'
import type { Locale } from '@/i18n/config'
import { accessCookieName } from './auth-cookies'
import { ApiError } from './api'
import { isUuid } from './uuid'
import type {
  AdminComment,
  AdminUser,
  Category,
  CommentStatus,
  GalleryPhotoAdmin,
  LocalizedText,
  MfaStatus,
  Page,
  PageMeta,
  Post,
  PostSummary,
  SeriesAdmin,
  Tag,
  UserRole,
  UserStatus,
} from './types'

const BASE_URL = apiBaseUrl()

/**
 * Raised when the session is gone rather than when permission is missing. The two need
 * different handling and conflating them loops: redirecting a 403 to login sends the
 * author to a page they can log into successfully and be refused from again.
 */
export class SessionExpiredError extends ApiError {
  constructor(message = 'Your session has expired') {
    super(401, 'UNAUTHENTICATED', message)
    this.name = 'SessionExpiredError'
  }
}

type Envelope<T> = { data: T; pagination?: PageMeta }

/**
 * The 401 codes that mean "your proof is not enough", not "your session is gone": a wrong or reused code, a wrong current password,
 * and a sign-in older than the re-authentication window (`REAUTHENTICATION_REQUIRED`, docs/SECURITY.md).
 */
const STEP_UP_REFUSALS: ReadonlySet<string> = new Set(['MFA_CODE_INVALID', 'INVALID_CREDENTIALS', 'REAUTHENTICATION_REQUIRED'])

/**
 * An identifier as ONE path segment. Every id the admin API takes is a UUID (a `@PathVariable UUID` in the backend), so anything else is
 * refused here with a 400 before a request exists. `encodeURIComponent` is not enough: it leaves `.` and `..` alone and fetch collapses
 * dot segments, so an id of `..` would send the caller's own Bearer token to a parent or sibling endpoint. The value is not echoed in the
 * message: it came from a URL or a request body.
 */
function segment(id: string): string {
  if (!isUuid(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid identifier')
  return id
}

/**
 * Deliberately separate from lib/api.ts rather than an optional token argument there.
 * A reader's cached page and an author's uncached one are different operations, and a
 * shared function with a flag is how a public request starts sending an Authorization
 * header because an admin cookie happened to be in the jar.
 */
async function adminRequest<T>(path: string, init: RequestInit = {}): Promise<Envelope<T> | null> {
  const res = await adminFetch(path, init)
  // 204 has no body: `res.json()` on an empty string throws SyntaxError, so a successful delete
  // would show up as an error.
  if (res.status === 204) return null
  return (await res.json()) as Envelope<T>
}

/**
 * The call behind every admin request: the caller's token, no cache, and the failures as errors. Returns the response as it is,
 * so that `adminRequest` can read JSON from it and a download can pass the bytes on untouched.
 */
async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = (await cookies()).get(accessCookieName())?.value
  if (!token) {
    // No call: there is nothing to try. Middleware should have redirected already, so
    // reaching here means the cookie died inside this request.
    throw new SessionExpiredError()
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      // Only when the body is a string (JSON.stringify). With FormData, fetch sets
      // `multipart/form-data; boundary=…` itself; a hand-written content-type overrides the boundary
      // and the backend cannot split the parts of any upload.
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      authorization: `Bearer ${token}`,
    },
    // After the spread on purpose: a caller passing `cache` in `init` cannot override
    // it. Every admin response is per-author and must never be reused.
    cache: 'no-store',
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    const message = body.error?.message ?? `API responded ${res.status} for ${path}`
    // A 401 that is not about the session: the token was fine, the step-up proof (a code, a recent sign-in) was not. Treating it as
    // an expired session would clear the cookies and sign the person out for a mistyped code.
    if (res.status === 401 && !(body.error?.code !== undefined && STEP_UP_REFUSALS.has(body.error.code)))
      throw new SessionExpiredError(message)
    throw new ApiError(res.status, body.error?.code, message)
  }

  return res
}

/**
 * For every endpoint that returns data. A 204 here means the backend broke the contract, and letting it slip out
 * as `null` would make the error blow up as a TypeError where `.data` is read, far from the cause. Status 502 so that the
 * display layer treats it as a server-side error.
 */
async function adminBody<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
  const body = await adminRequest<T>(path, init)
  if (body === null) throw new ApiError(502, undefined, `API answered ${path} with no content`)
  return body
}

/** JSON body: the only place that calls JSON.stringify, so the content-type always goes along. */
function json(method: 'POST' | 'PUT' | 'PATCH', body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}

/** One page of an endpoint that returns `PagedResponse` (`data` + `pagination`). */
async function adminPage<T>(path: string, page: number, size: number): Promise<Page<T>> {
  const body = await adminBody<T[]>(path)
  return {
    items: body.data,
    meta: body.pagination ?? { page, size, totalElements: 0, totalPages: 0 },
  }
}

export type PostInput = {
  title: string
  content: string
  excerpt?: string
  slug?: string
  categoryId?: string
  tagIds?: string[]
  /** An enabled locale. Absent: a new post gets the default locale, an update keeps the current one. */
  language?: Locale
}

/** The raw per-locale texts of a category, tag or series. On update the map replaces the whole stored one; absent keeps it. */
export type TranslationsInput = Record<string, LocalizedText>

/** One member of a post's translation group as the admin endpoint lists it (every status the caller may see). */
export type AdminPostTranslation = {
  id: string
  language: string
  slug: string
  title: string
  status: string
}

/**
 * The role the BACKEND holds for the caller (`GET /auth/me` with the caller's token): the signature is checked there and the role and the
 * status are read from the database. For the places that would otherwise decide from the unverified claim of the cookie (lib/jwt.ts)
 * with no backend call of their own, such as a route handler that serves a file generated in the frontend. 401 is a
 * SessionExpiredError, 403 (a suspended account) an ApiError.
 */
export async function getVerifiedRole(): Promise<string | null> {
  const me = (await adminBody<{ role?: unknown }>('/api/v1/auth/me')).data
  return typeof me?.role === 'string' ? me.role : null
}

export async function listAdminPosts(params: { page: number; size: number }): Promise<Page<PostSummary>> {
  const query = new URLSearchParams({ page: String(params.page), size: String(params.size) })
  return adminPage<PostSummary>(`/api/v1/admin/posts?${query}`, params.page, params.size)
}

export async function getAdminPost(id: string): Promise<Post> {
  return (await adminBody<Post>(`/api/v1/admin/posts/${segment(id)}`)).data
}

/**
 * The SAVED post as the ZIP package the post import reads (`GET /admin/posts/{id}/export`), as the raw backend response: the caller
 * passes the body and the file name on to the browser. The backend checks that the caller may read the post.
 */
export async function fetchAdminPostExport(id: string): Promise<Response> {
  return adminFetch(`/api/v1/admin/posts/${segment(id)}/export`)
}

export async function createPost(input: PostInput): Promise<Post> {
  return (await adminBody<Post>('/api/v1/admin/posts', { method: 'POST', body: JSON.stringify(input) })).data
}

export async function updatePost(id: string, input: PostInput): Promise<Post> {
  return (
    await adminBody<Post>(`/api/v1/admin/posts/${segment(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  ).data
}

/**
 * 204: deletes the post entirely, with its cover image (the backend deletes it in the same transaction), views (cascade),
 * its place in a series and in the featured posts (those two are columns of the post itself). Returns null.
 */
export async function deletePost(id: string): Promise<null> {
  await adminRequest<never>(`/api/v1/admin/posts/${segment(id)}`, { method: 'DELETE' })
  return null
}

export async function publishPost(id: string): Promise<Post> {
  return (await adminBody<Post>(`/api/v1/admin/posts/${segment(id)}/publish`, { method: 'POST' })).data
}

/*
 * Translation groups of a post (the same article in another language). AUTHOR: own posts; ADMIN: any. Errors the editor shows:
 * 409 `TRANSLATION_CONFLICT` (the group already has that language), 409 `RESOURCE_CONFLICT` (the given slug is taken).
 */

const translations = (id: string) => `${post(id)}/translations`

/** The siblings of the post the caller may see (the post itself is not in the list). */
export async function listPostTranslations(id: string): Promise<AdminPostTranslation[]> {
  return (await adminBody<AdminPostTranslation[]>(translations(id))).data
}

/** A new DRAFT of the same article in `language`, empty content; a blank slug is not sent (the backend derives one). 201 with the new post. */
export async function createPostTranslation(id: string, input: { language: Locale; slug?: string }): Promise<Post> {
  return (await adminBody<Post>(translations(id), json('POST', input))).data
}

/** Put the two existing posts in one group. Already together: 200, nothing changes. Returns the post `id`. */
export async function linkPostTranslation(id: string, otherId: string): Promise<Post> {
  return (await adminBody<Post>(`${translations(id)}/${segment(otherId)}`, { method: 'PUT' })).data
}

/** 204: the post leaves its group. Returns null. */
export async function unlinkPostTranslation(id: string): Promise<null> {
  await adminRequest<never>(translations(id), { method: 'DELETE' })
  return null
}

export async function unpublishPost(id: string): Promise<Post> {
  return (await adminBody<Post>(`/api/v1/admin/posts/${segment(id)}/unpublish`, { method: 'POST' })).data
}

export async function listCategories(): Promise<Category[]> {
  return (await adminBody<Category[]>('/api/v1/admin/categories')).data
}

/** Optional description: the inline create box in the editor sends only the name, the Topics page sends the description too. */
export async function createCategory(
  name: string,
  description?: string | null,
  translations?: TranslationsInput,
): Promise<Category> {
  const body = {
    name,
    ...(description === undefined ? {} : { description }),
    ...(translations === undefined ? {} : { translations }),
  }
  return (await adminBody<Category>('/api/v1/admin/categories', { method: 'POST', body: JSON.stringify(body) })).data
}

export async function listTags(): Promise<Tag[]> {
  return (await adminBody<Tag[]>('/api/v1/admin/tags')).data
}

export async function createTag(name: string, translations?: TranslationsInput): Promise<Tag> {
  const body = translations === undefined ? { name } : { name, translations }
  return (await adminBody<Tag>('/api/v1/admin/tags', { method: 'POST', body: JSON.stringify(body) })).data
}

/*
 * Edit and delete categories/tags. ADMIN only. The slug does NOT change when renaming: it is the public URL
 * /categories/{slug}, /tags/{slug}.
 */

const category = (id: string) => `/api/v1/admin/categories/${segment(id)}`
const tag = (id: string) => `/api/v1/admin/tags/${segment(id)}`

/** Replace name and description (empty description → null). A name equal to another category → 409 `CATEGORY_ALREADY_EXISTS`. */
export async function updateCategory(
  id: string,
  input: { name: string; description: string | null; translations?: TranslationsInput },
): Promise<Category> {
  return (await adminBody<Category>(category(id), json('PUT', input))).data
}

/** 204. Still used by posts (any status) → 409 `CATEGORY_IN_USE`: a published post must have a category. */
export async function deleteCategory(id: string): Promise<null> {
  await adminRequest<never>(category(id), { method: 'DELETE' })
  return null
}

/**
 * Rename a tag. Not called `updateTag`: the action files already import `updateTag` from next/cache, and
 * two functions with the same name in one place are the easiest thing to call by mistake. A name equal to another tag → 409 `TAG_ALREADY_EXISTS`.
 */
export async function renameTag(id: string, name: string, translations?: TranslationsInput): Promise<Tag> {
  return (await adminBody<Tag>(tag(id), json('PUT', translations === undefined ? { name } : { name, translations }))).data
}

/** 204. The tag leaves every post carrying it by itself (post_tags ON DELETE CASCADE); the posts stay intact. */
export async function deleteTag(id: string): Promise<null> {
  await adminRequest<never>(tag(id), { method: 'DELETE' })
  return null
}

/* New endpoints. Upload is multipart (FormData, NO hand-set content-type);
   every other body is JSON through `json()`. */

const post = (id: string) => `/api/v1/admin/posts/${segment(id)}`
const series = (id: string) => `/api/v1/admin/series/${segment(id)}`
const galleryPhoto = (id: string) => `/api/v1/admin/gallery/${segment(id)}`

/**
 * Upload and attach a cover image in one call (the old cover image is deleted in the backend). `altText` is only sent
 * when present: the backend trims it and treats an empty string as null.
 */
export async function uploadPostCover(id: string, file: File, altText?: string | null): Promise<Post> {
  const body = new FormData()
  body.append('file', file, file.name)
  if (typeof altText === 'string') body.append('altText', altText)
  return (await adminBody<Post>(`${post(id)}/cover`, { method: 'POST', body })).data
}

/** Replace the whole cover image description; null clears it. A post without a cover image → 404 `MEDIA_NOT_FOUND`. */
export async function updatePostCoverAlt(id: string, altText: string | null): Promise<Post> {
  return (await adminBody<Post>(`${post(id)}/cover`, json('PUT', { altText }))).data
}

/** Detach and delete the cover image. Returns 200 with the post (not 204), idempotent. */
export async function deletePostCover(id: string): Promise<Post> {
  return (await adminBody<Post>(`${post(id)}/cover`, { method: 'DELETE' })).data
}

/**
 * Set the order of the featured posts: REPLACES THE WHOLE ranked list. Posts in the list become
 * featured, rank 1..n; featured posts absent from it keep the flag, only losing their rank. Returns every featured post, in every
 * status, by rank.
 *
 * Not a permutation like `reorderGallery`: any list made of existing posts is accepted,
 * even a stale list from another tab. 400 `POST_NOT_FOUND` only when an id is no longer
 * any post (a post was just deleted elsewhere); 400 `VALIDATION_ERROR` for a duplicate id or more than 50 posts. Two
 * overlapping saves do not become a 409: the backend makes the later one wait for the earlier one and then replaces everything.
 */
export async function setFeaturedOrder(postIds: string[]): Promise<PostSummary[]> {
  return (await adminBody<PostSummary[]>('/api/v1/admin/posts/featured-order', json('PUT', { postIds }))).data
}

export async function featurePost(id: string): Promise<Post> {
  return (await adminBody<Post>(`${post(id)}/feature`, { method: 'POST' })).data
}

/** Remove from the featured posts: clears both the flag and the rank. */
export async function unfeaturePost(id: string): Promise<Post> {
  return (await adminBody<Post>(`${post(id)}/unfeature`, { method: 'POST' })).data
}

/** `SeriesRequest`: with a blank `slug` the backend generates it from the name (on create) or keeps the old slug (on update). */
export type SeriesInput = {
  title: string
  slug?: string
  description?: string | null
  translations?: TranslationsInput
}

/** Every series, including series without posts, sorted by name. */
export async function listAdminSeries(): Promise<SeriesAdmin[]> {
  return (await adminBody<SeriesAdmin[]>('/api/v1/admin/series')).data
}

/** A duplicate name (case-insensitive) → 409 `SERIES_ALREADY_EXISTS`. */
export async function createSeries(input: SeriesInput): Promise<SeriesAdmin> {
  return (await adminBody<SeriesAdmin>('/api/v1/admin/series', json('POST', input))).data
}

export async function getAdminSeries(id: string): Promise<SeriesAdmin> {
  return (await adminBody<SeriesAdmin>(series(id))).data
}

export async function updateSeries(id: string, input: SeriesInput): Promise<SeriesAdmin> {
  return (await adminBody<SeriesAdmin>(series(id), json('PUT', input))).data
}

/**
 * The ONLY way to write series membership: replace the whole list, positions 1..n in the order
 * sent. A post that is in another series is moved over.
 */
export async function setSeriesPosts(id: string, postIds: string[]): Promise<SeriesAdmin> {
  return (await adminBody<SeriesAdmin>(`${series(id)}/posts`, json('PUT', { postIds }))).data
}

/** 204: removes the post from the series, then deletes. Returns null. */
export async function deleteSeries(id: string): Promise<null> {
  await adminRequest<never>(series(id), { method: 'DELETE' })
  return null
}

/** Every photo, not paged: reordering needs to send a permutation of EVERY photo. */
export async function listAdminGallery(): Promise<GalleryPhotoAdmin[]> {
  return (await adminBody<GalleryPhotoAdmin[]>('/api/v1/admin/gallery')).data
}

/** The text part of a gallery photo upload. A blank field is not sent. */
export type GalleryPhotoFields = {
  caption?: string | null
  altText?: string | null
  /** `yyyy-MM-dd`. If blank the backend uses the capture date from EXIF, otherwise null. */
  takenOn?: string | null
  /** Defaults to true in the backend. */
  published?: boolean
}

/**
 * One file per call. A blank string must not be sent: "blank" means "let the backend decide"
 * (capture date from EXIF, no caption). The backend also treats an empty `takenOn=` as not sent
 * (GalleryIT pins that), so this is to make that meaning visible in the request, not to avoid
 * a bug; a wrongly formatted date is still a 400.
 */
export async function uploadGalleryPhoto(file: File, fields: GalleryPhotoFields): Promise<GalleryPhotoAdmin> {
  const body = new FormData()
  body.append('file', file, file.name)
  for (const name of ['caption', 'altText', 'takenOn'] as const) {
    const value = fields[name]
    if (typeof value === 'string' && value.trim() !== '') body.append(name, value)
  }
  if (fields.published !== undefined) body.append('published', String(fields.published))
  return (await adminBody<GalleryPhotoAdmin>('/api/v1/admin/gallery', { method: 'POST', body })).data
}

/** `GalleryPhotoUpdateRequest`: replaces everything, so every field must be present. */
export type GalleryPhotoInput = {
  caption: string | null
  altText: string | null
  takenOn: string | null
  published: boolean
}

export async function updateGalleryPhoto(id: string, input: GalleryPhotoInput): Promise<GalleryPhotoAdmin> {
  return (await adminBody<GalleryPhotoAdmin>(galleryPhoto(id), json('PUT', input))).data
}

/** 204: deletes the photo along with its bytes. Returns null. */
export async function deleteGalleryPhoto(id: string): Promise<null> {
  await adminRequest<never>(galleryPhoto(id), { method: 'DELETE' })
  return null
}

/** Must be an exact permutation of EVERY photo; a stale or incomplete list → 400. */
export async function reorderGallery(photoIds: string[]): Promise<GalleryPhotoAdmin[]> {
  return (await adminBody<GalleryPhotoAdmin[]>('/api/v1/admin/gallery/order', json('PUT', { photoIds }))).data
}

/*
 * Comment moderation and user management. ADMIN only: the URL rule
 * `/api/v1/admin/comments/**`, `/api/v1/admin/users/**` in the backend. Any filter that is null or empty is
 * not sent: the backend treats absence as "no filter", while an unknown enum value is a 400.
 */

const adminComment = (id: string) => `/api/v1/admin/comments/${segment(id)}`
const adminUser = (id: string) => `/api/v1/admin/users/${segment(id)}`

export type AdminCommentQuery = {
  /** null means every status. */
  status: CommentStatus | null
  /** Search in the content, login and author name; '' means no search. */
  q: string
  /**
   * Only comments of this post (UUID); null or blank means every post. Not any post → empty page,
   * not 404.
   */
  postId?: string | null
  page: number
  size: number
}

/** Newest first, every post (including unpublished ones). The content is always there, even for hidden or deleted comments. */
export async function listAdminComments({ status, q, postId, page, size }: AdminCommentQuery): Promise<Page<AdminComment>> {
  const query = new URLSearchParams({ page: String(page), size: String(size) })
  if (status !== null) query.set('status', status)
  if (q !== '') query.set('q', q)
  if (postId) query.set('postId', postId)
  return adminPage<AdminComment>(`/api/v1/admin/comments?${query}`, page, size)
}

/**
 * Hide (`HIDDEN`) or show again (`VISIBLE`); setting the status it already has still returns 200. A deleted comment
 * → 409 `RESOURCE_CONFLICT` (DELETED is the final state); not found → 404 `COMMENT_NOT_FOUND`.
 */
export async function setCommentStatus(id: string, status: 'VISIBLE' | 'HIDDEN'): Promise<AdminComment> {
  return (await adminBody<AdminComment>(`${adminComment(id)}/status`, json('PATCH', { status }))).data
}

/** 204, soft delete: readers no longer see it, the content is kept for admin. Deleting again still returns 204. Returns null. */
export async function deleteAdminComment(id: string): Promise<null> {
  await adminRequest<never>(adminComment(id), { method: 'DELETE' })
  return null
}

export type AdminUserQuery = {
  /** Search in the GitHub login and display name; '' means no search. No search by email. */
  q: string
  role: UserRole | null
  status: UserStatus | null
  page: number
  size: number
}

/** Newest first. No email: the page only needs to recognize the person and their status. */
export async function listAdminUsers({ q, role, status, page, size }: AdminUserQuery): Promise<Page<AdminUser>> {
  const query = new URLSearchParams({ page: String(page), size: String(size) })
  if (q !== '') query.set('q', q)
  if (role !== null) query.set('role', role)
  if (status !== null) query.set('status', status)
  return adminPage<AdminUser>(`/api/v1/admin/users?${query}`, page, size)
}

/**
 * The signed-in account's two-step verification status (`GET /me/mfa`), for the Security page. Open to any signed-in account.
 */
export async function getMfaStatus(): Promise<MfaStatus> {
  return (await adminBody<MfaStatus>('/api/v1/me/mfa')).data
}

/**
 * An administrator resets the two-step verification of an AUTHOR who lost the device and the recovery codes (`POST
 * /admin/users/{id}/mfa/reset`, 204): the enrollment and the recovery codes go and the author's sessions end. Needs the caller's own
 * code (an authenticator code or a recovery code) and a sign-in within the re-authentication window. Never for an administrator.
 * Refusals the caller shows: 401 `MFA_CODE_INVALID`, 401 `REAUTHENTICATION_REQUIRED`, 429 `MFA_RATE_LIMITED`, 403 `MFA_FROZEN`,
 * 403 `FORBIDDEN`, 404 `USER_NOT_FOUND`.
 */
export async function resetAuthorMfa(id: string, code: string): Promise<null> {
  await adminRequest<never>(`${adminUser(id)}/mfa/reset`, json('POST', { code }))
  return null
}

/**
 * Suspend (`SUSPENDED`, revokes all of that person's refresh tokens) or unsuspend (`ACTIVE`). Only
 * accounts with the USER role, and never the caller themselves: otherwise 409 `USER_NOT_SUSPENDABLE`; not found
 * → 404 `USER_NOT_FOUND`.
 */
export async function setUserStatus(id: string, status: UserStatus): Promise<AdminUser> {
  return (await adminBody<AdminUser>(`${adminUser(id)}/status`, json('PATCH', { status }))).data
}

/**
 * Change role; the role it already has returns 200 and does nothing. A real change revokes all of that person's refresh tokens.
 * A change to or from ADMIN, or a reader becoming AUTHOR, also needs the CALLER's own `code` (an authenticator code or a recovery
 * code) and a sign-in within the re-authentication window, and a promotion to ADMIN removes the person's two-step enrollment so that
 * they enroll again with the operator's enrollment code (audit 111): 401 `MFA_CODE_INVALID` (also when the code is missing), 401
 * `REAUTHENTICATION_REQUIRED`, 429 `MFA_RATE_LIMITED`, 403 `MFA_FROZEN`. 409 `LAST_ADMIN` when the site would be left without an
 * active admin; 429 `RATE_LIMITED` (per calling admin); 404 `USER_NOT_FOUND`.
 */
export async function setUserRole(id: string, role: UserRole, code?: string): Promise<AdminUser> {
  return (await adminBody<AdminUser>(`${adminUser(id)}/role`, json('PATCH', code === undefined ? { role } : { role, code }))).data
}

// Editor: images in the post body and revisions. Same permission rules as every route naming a post
// (ADMIN any post, AUTHOR their own). Imported separately here so the shared import block at the top of the file is untouched.
import type { MediaRef, PostRevision, PostRevisionSummary } from './types'

/**
 * Upload an image for the post body; returns the image (200). Not attached anywhere: the editor inserts `/media/<fileName>` into the
 * content itself. Same checks as the cover image (413/415/422, shared quota `MEDIA_QUOTA_EXCEEDED`); a missing post →
 * 404 `POST_NOT_FOUND`. `altText` is only sent when present (the backend trims it, maximum 300 characters).
 */
export async function uploadPostImage(id: string, file: File, altText?: string | null): Promise<MediaRef> {
  const body = new FormData()
  body.append('file', file, file.name)
  if (typeof altText === 'string') body.append('altText', altText)
  return (await adminBody<MediaRef>(`${post(id)}/images`, { method: 'POST', body })).data
}

/** Images in the post body, newest first. */
export async function listPostImages(id: string): Promise<MediaRef[]> {
  return (await adminBody<MediaRef[]>(`${post(id)}/images`)).data
}

/** Delete an image in the post body along with its bytes; returns 200 with the remaining images. An image not belonging to the post → 404 `MEDIA_NOT_FOUND`. */
export async function deletePostImage(id: string, mediaId: string): Promise<MediaRef[]> {
  return (await adminBody<MediaRef[]>(`${post(id)}/images/${segment(mediaId)}`, { method: 'DELETE' })).data
}

/** The post's history, newest first, at most 20 revisions, without content. */
export async function listPostRevisions(id: string): Promise<PostRevisionSummary[]> {
  return (await adminBody<PostRevisionSummary[]>(`${post(id)}/revisions`)).data
}

/** One full revision. Missing (or already pruned) → 404 `REVISION_NOT_FOUND`. */
export async function getPostRevision(id: string, revisionId: string): Promise<PostRevision> {
  return (await adminBody<PostRevision>(`${post(id)}/revisions/${segment(revisionId)}`)).data
}

/**
 * Restore the title, description and content of a revision; returns the post. The backend saves the current text as a revision first, so
 * a restore can itself be undone.
 */
export async function restorePostRevision(id: string, revisionId: string): Promise<Post> {
  return (await adminBody<Post>(`${post(id)}/revisions/${segment(revisionId)}/restore`, { method: 'POST' })).data
}

// Admin: merge categories/tags, media usage, filter comments by post. Imported separately
// here so the shared import block at the top of the file is untouched. All three groups are ADMIN only in the backend.
import type { MediaUsage, TopicMerge } from './types'

/**
 * Merge tag `id` into `targetId`: every post carrying `id` carries `targetId` (exactly once, even a post that already had it),
 * then `id` is deleted; the post's `updatedAt` does not change. Merging into itself → 400 `VALIDATION_ERROR`; a missing
 * target → 400 `TAG_NOT_FOUND`; a missing source → 404 `TAG_NOT_FOUND`.
 */
export async function mergeTag(id: string, targetId: string): Promise<TopicMerge<Tag>> {
  return (await adminBody<TopicMerge<Tag>>(`${tag(id)}/merge`, json('POST', { targetId }))).data
}

/**
 * "Move posts then delete": every post of category `id` (any status) to `targetId`, then `id` is deleted. The same
 * error codes as mergeTag, with `CATEGORY_NOT_FOUND`.
 */
export async function mergeCategory(id: string, targetId: string): Promise<TopicMerge<Category>> {
  return (await adminBody<TopicMerge<Category>>(`${category(id)}/merge`, json('POST', { targetId }))).data
}

/** Image storage used versus the quota. Backend without the endpoint → 404 `ENDPOINT_NOT_FOUND` (ApiError). */
export async function getMediaUsage(): Promise<MediaUsage> {
  return (await adminBody<MediaUsage>('/api/v1/admin/media/usage')).data
}

// Author applications. ADMIN only (URL rule `/api/v1/admin/author-applications/**`).
import type { AdminAuthorApplication, AuthorApplicationStatus } from './types'

const authorApplication = (id: string) => `/api/v1/admin/author-applications/${segment(id)}`

/** One status per call; the oldest pending application first. The applicant comes without an email. */
export async function listAuthorApplications({
  status,
  page,
  size,
}: {
  status: AuthorApplicationStatus
  page: number
  size: number
}): Promise<Page<AdminAuthorApplication>> {
  const query = new URLSearchParams({ status, page: String(page), size: String(size) })
  return adminPage<AdminAuthorApplication>(`/api/v1/admin/author-applications?${query}`, page, size)
}

/**
 * Approve: the applicant becomes AUTHOR through the same role-change service (their sessions are revoked). Making a reader an author
 * needs the CALLER's own `code` and a recent sign-in, like a role change (audit 111): 401 `MFA_CODE_INVALID`, 401
 * `REAUTHENTICATION_REQUIRED`, 429 `MFA_RATE_LIMITED`, 403 `MFA_FROZEN`. An approved application returns 200 and
 * does nothing; a rejected application → 409 `AUTHOR_APPLICATION_DECIDED`; one's own application → 403 `FORBIDDEN`; an applicant
 * who is suspended → 409 `ROLE_TARGET_SUSPENDED`; 429 `RATE_LIMITED` (shares the limit with role change).
 */
export async function approveAuthorApplication(id: string, code?: string): Promise<AdminAuthorApplication> {
  return (
    await adminBody<AdminAuthorApplication>(
      `${authorApplication(id)}/approve`,
      code === undefined ? { method: 'POST' } : json('POST', { code }),
    )
  ).data
}

/** Reject: an already rejected application returns 200 and does nothing; an approved application → 409 `AUTHOR_APPLICATION_DECIDED`. */
export async function rejectAuthorApplication(id: string): Promise<AdminAuthorApplication> {
  return (await adminBody<AdminAuthorApplication>(`${authorApplication(id)}/reject`, { method: 'POST' })).data
}

// Analytics: views per day, most-read posts, sources. ADMIN sees the whole site, AUTHOR only their own posts: the backend filters
// in the SQL query. Imported separately here so the shared import block at the top of the file is untouched.
import type { Analytics } from './types'

/**
 * `from`, `to` are `YYYY-MM-DD`; when absent they are not sent (the backend takes the 30 days up to today in its own time zone). A bad format,
 * `from` after `to`, or longer than 366 days → 400 `VALIDATION_ERROR`.
 */
export async function getAnalytics({ from, to }: { from?: string; to?: string } = {}): Promise<Analytics> {
  const query = new URLSearchParams()
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  const search = query.toString()
  return (await adminBody<Analytics>(`/api/v1/admin/analytics${search === '' ? '' : `?${search}`}`)).data
}

// Newsletter: subscriber count, the latest sends and failures by code. ADMIN only (URL rule
// `/api/v1/admin/newsletter/**`). Imported separately here so the shared import block at the top of the file is untouched.
import type { HeldNewsletterIssue, NewsletterStats } from './types'

/** Counts: the endpoint returns no address, and no endpoint lists addresses. */
export async function getNewsletterStats(): Promise<NewsletterStats> {
  return (await adminBody<NewsletterStats>('/api/v1/admin/newsletter')).data
}

/** The newsletters of posts that an AUTHOR published, waiting for an administrator, oldest first. */
export async function getHeldNewsletterIssues(): Promise<HeldNewsletterIssue[]> {
  return (await adminBody<HeldNewsletterIssue[]>('/api/v1/admin/newsletter/held')).data
}

const newsletterIssue = (postId: string) => `/api/v1/admin/newsletter/issues/${encodeURIComponent(postId)}`

/**
 * 204. `version` is the one the held list returned for this post, which stands for the text the administrator read. A newsletter
 * that is not waiting (decided already, or queued by an administrator) → 404 `NEWSLETTER_ISSUE_NOT_FOUND`; a post that changed since
 * the list was loaded → 409 `NEWSLETTER_ISSUE_CHANGED`, and nothing is released.
 */
export async function releaseNewsletterIssue(postId: string, version: string): Promise<null> {
  await adminRequest<never>(`${newsletterIssue(postId)}/release`, json('POST', { version }))
  return null
}

/** 204. Same 404 as `releaseNewsletterIssue`. */
export async function discardNewsletterIssue(postId: string): Promise<null> {
  await adminRequest<never>(`${newsletterIssue(postId)}/discard`, { method: 'POST' })
  return null
}

// Contact inbox (ADMIN only, `/api/v1/admin/contact/**`). Messages hold a visitor's name, email and text: never log them.
import type { ContactMessage } from './types'
import { apiBaseUrl } from '@/lib/api-base-url'

/** Newest first. */
export async function listContactMessages(page: number, size: number): Promise<Page<ContactMessage>> {
  return adminPage<ContactMessage>(
    `/api/v1/admin/contact/messages?${new URLSearchParams({ page: String(page), size: String(size) })}`,
    page,
    size,
  )
}

/** The unread messages over the whole inbox, not only the page being shown. */
export async function getContactUnreadCount(): Promise<number> {
  return (await adminBody<{ count: number }>('/api/v1/admin/contact/unread-count')).data.count
}

const contactMessage = (id: string) => `/api/v1/admin/contact/messages/${segment(id)}`

/** 204, idempotent: marking a read message again still succeeds. Unknown id → 404. */
export async function markContactMessageRead(id: string): Promise<null> {
  await adminRequest<never>(`${contactMessage(id)}/read`, { method: 'POST' })
  return null
}

/** 204. Unknown id → 404. */
export async function deleteContactMessage(id: string): Promise<null> {
  await adminRequest<never>(contactMessage(id), { method: 'DELETE' })
  return null
}
