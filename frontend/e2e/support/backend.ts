import type { APIRequestContext, APIResponse } from '@playwright/test'
import type {
  AdminComment,
  AdminUser,
  Category,
  CommentPage,
  CommentStatus,
  GalleryPhoto,
  GalleryPhotoAdmin,
  LikeState,
  Post,
  PostSummary,
  PublicComment,
  SeriesAdmin,
  SeriesDetail,
  SeriesSummary,
  Tag,
  UserRole,
  UserStatus,
} from '../../lib/types'
import { adminAccessToken, roleChangeProof } from './admin-session'
import { E2E_LOCALE } from './i18n'

type Envelope<T> = { data: T }

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** An access token lives 15 minutes: the admin token is reused for up to 10 minutes, then signs in again. */
const ADMIN_TOKEN_REUSE_MS = 10 * 60_000

/** The `data` part of a 2xx response; any other status is an error, with the head of the body so the cause can be read. */
async function dataOf<T>(response: APIResponse, what: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${what}: HTTP ${response.status()} ${(await response.text()).slice(0, 300)}`)
  }
  return ((await response.json()) as Envelope<T>).data
}

async function expectOk(response: APIResponse, what: string): Promise<void> {
  if (!response.ok()) throw new Error(`${what}: HTTP ${response.status()} ${(await response.text()).slice(0, 300)}`)
}

/** A query string from the parameters that have a value (undefined is dropped), with `?` when there is one. */
function queryOf(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value))
  const text = query.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * `GET /api/v1/auth/me` (`CurrentUserResponse`). Different from the `SessionUser` the browser sees through
 * /api/session: it has the id, email (null for a GitHub reader) and status.
 */
export type CurrentUser = {
  id: string
  email: string | null
  displayName: string
  role: UserRole
  githubLogin: string | null
  avatarUrl: string | null
  status: UserStatus
  createdAt: string
}

export type AdminCommentQuery = { status?: CommentStatus; q?: string; page?: number; size?: number }
export type AdminUserQuery = { q?: string; role?: UserRole; status?: UserStatus; page?: number; size?: number }

/**
 * The backend called with the access token of ONE person: the token comes from the cookie after
 * loginWithGitHub (e2e/support/github.ts), or the admin's through `Backend.asAdmin()`.
 *
 * The typed methods return the `data` part and throw on any non-2xx status: used to build data and
 * read the truth. A test that needs the error status itself (403 on someone else's comment, 401 for a guest, 4xx for a
 * forged body) uses `request`, which returns the response untouched.
 *
 * Writing straight to the backend does not make public pages show stale data: comments and likes are not in
 * any data Next caches; the post page loads them through the `no-store` BFF route.
 */
export class UserApi {
  constructor(
    private readonly http: APIRequestContext,
    readonly token: string,
  ) {}

  /** Any request carrying this person's Bearer; returns the response untouched, including 4xx. */
  request(method: Method, path: string, body?: unknown): Promise<APIResponse> {
    return this.http.fetch(path, {
      method,
      headers: { authorization: `Bearer ${this.token}` },
      ...(body === undefined ? {} : { data: body }),
    })
  }

  /** This person according to the backend; a suspended person gets 403 USER_SUSPENDED (thrown here). */
  me(): Promise<CurrentUser> {
    return this.request('GET', '/api/v1/auth/me').then((r) => dataOf<CurrentUser>(r, 'GET auth/me'))
  }

  /** A page of root comments with their replies, as this person sees them (`mine` is true for their own comments). */
  comments(slug: string, after?: string): Promise<CommentPage> {
    return this.request('GET', `/api/v1/posts/${encodeURIComponent(slug)}/comments${queryOf({ after })}`).then((r) =>
      dataOf<CommentPage>(r, `GET comments ${slug}`),
    )
  }

  addComment(slug: string, content: string): Promise<PublicComment> {
    return this.request('POST', `/api/v1/posts/${encodeURIComponent(slug)}/comments`, { content }).then((r) =>
      dataOf<PublicComment>(r, `POST comment ${slug}`),
    )
  }

  reply(commentId: string, content: string): Promise<PublicComment> {
    return this.request('POST', `/api/v1/comments/${encodeURIComponent(commentId)}/replies`, { content }).then((r) =>
      dataOf<PublicComment>(r, `POST reply ${commentId}`),
    )
  }

  editComment(id: string, content: string): Promise<PublicComment> {
    return this.request('PUT', `/api/v1/comments/${encodeURIComponent(id)}`, { content }).then((r) =>
      dataOf<PublicComment>(r, `PUT comment ${id}`),
    )
  }

  /** Delete one's own comment (a soft delete). */
  async deleteComment(id: string): Promise<void> {
    await expectOk(await this.request('DELETE', `/api/v1/comments/${encodeURIComponent(id)}`), `DELETE comment ${id}`)
  }

  likes(slug: string): Promise<LikeState> {
    return this.request('GET', `/api/v1/posts/${encodeURIComponent(slug)}/like`).then((r) =>
      dataOf<LikeState>(r, `GET like ${slug}`),
    )
  }

  like(slug: string): Promise<LikeState> {
    return this.request('PUT', `/api/v1/posts/${encodeURIComponent(slug)}/like`).then((r) =>
      dataOf<LikeState>(r, `PUT like ${slug}`),
    )
  }

  unlike(slug: string): Promise<LikeState> {
    return this.request('DELETE', `/api/v1/posts/${encodeURIComponent(slug)}/like`).then((r) =>
      dataOf<LikeState>(r, `DELETE like ${slug}`),
    )
  }

  /* Moderation and users: ADMIN only (anyone else gets 403, thrown here; use `request` to check the 403). */

  /** Newest comments first, every post, every status (unless filtered). */
  adminComments(query: AdminCommentQuery = {}): Promise<AdminComment[]> {
    return this.request('GET', `/api/v1/admin/comments${queryOf(query)}`).then((r) =>
      dataOf<AdminComment[]>(r, 'GET admin comments'),
    )
  }

  /** Hide (`HIDDEN`) or unhide (`VISIBLE`) a comment. */
  setCommentStatus(id: string, status: 'VISIBLE' | 'HIDDEN'): Promise<AdminComment> {
    return this.request('PATCH', `/api/v1/admin/comments/${encodeURIComponent(id)}/status`, { status }).then((r) =>
      dataOf<AdminComment>(r, `PATCH comment status ${id}`),
    )
  }

  /** Delete (soft) any comment; repeating still gives 204. */
  async adminDeleteComment(id: string): Promise<void> {
    await expectOk(await this.request('DELETE', `/api/v1/admin/comments/${encodeURIComponent(id)}`), `DELETE admin comment ${id}`)
  }

  /** Newest users first; `q` searches by login or display name. */
  adminUsers(query: AdminUserQuery = {}): Promise<AdminUser[]> {
    return this.request('GET', `/api/v1/admin/users${queryOf(query)}`).then((r) => dataOf<AdminUser[]>(r, 'GET admin users'))
  }

  /** Suspend (`SUSPENDED`) or unsuspend (`ACTIVE`) a reader; a non-USER account gets 409. */
  setUserStatus(id: string, status: UserStatus): Promise<AdminUser> {
    return this.request('PATCH', `/api/v1/admin/users/${encodeURIComponent(id)}/status`, { status }).then((r) =>
      dataOf<AdminUser>(r, `PATCH user status ${id}`),
    )
  }

  /**
   * Change role: revokes every refresh token of that person, so they must sign in again to get a token carrying the new
   * role. Changing to the role they already have gives 200 and does nothing. A change to or from ADMIN, or a reader becoming an
   * author, wants a sign-in from the last 10 minutes and the administrator's own code (audit 111). Most changes want nothing, and
   * a code taken from the suite's file for a change that did not need it would be missing on the server's side, so the change is
   * tried plain first: one that needs the proof answers 401 (`REAUTHENTICATION_REQUIRED` or `MFA_CODE_INVALID`) before anything is
   * written or counted, and is then repeated with a session that signed in minutes ago and a recovery code (`roleChangeProof`,
   * e2e/support/admin-session.ts). Only for the administrator's UserApi.
   */
  async setUserRole(id: string, role: UserRole): Promise<AdminUser> {
    const path = `/api/v1/admin/users/${encodeURIComponent(id)}/role`
    const plain = await this.request('PATCH', path, { role })
    if (plain.status() !== 401) return dataOf<AdminUser>(plain, `PATCH user role ${id}`)
    const refusal = ((await plain.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code
    if (refusal !== 'REAUTHENTICATION_REQUIRED' && refusal !== 'MFA_CODE_INVALID') {
      throw new Error(`PATCH user role ${id}: HTTP 401 ${refusal ?? ''}`.trim())
    }
    const { accessToken, code } = await roleChangeProof()
    const response = await this.http.fetch(path, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${accessToken}` },
      data: { role, code },
    })
    return dataOf<AdminUser>(response, `PATCH user role ${id}`)
  }
}

/**
 * The QA stack's backend, called directly rather than through Next. Three jobs, no more:
 *
 * - Read the truth to compare against: views before/after a beacon, the curated order, the stored image size. The public
 *   pages read through Next's cache (revalidate 300), so only the backend can say "has it been written yet".
 * - Clean up temporary data when an admin test breaks midway. The main path always goes through the admin UI (a Server
 *   Action calls `updateTag`, public pages see it immediately); cleaning up via the API is only a safety net so the shared
 *   stack is not left with a stray series or a reversed curated order.
 * - Play a person: `asUser(token)` and `asAdmin()` call the comment, like, moderation
 *   and user APIs with that person's token (the UserApi above); `refresh(token)` asks whether a refresh
 *   token is still alive.
 *
 * Never use it to CREATE or PUBLISH content for the public pages (posts, series, photos): writing straight to
 * the backend does not invalidate Next's cache, and the page would show stale data for up to 5 minutes. A
 * draft is fine (`createDraftPost`): a draft is in no cache, and the publish step goes through the admin UI
 * (admin.ts, createTemporaryPost).
 */
export class Backend {
  private token: string | null = null
  /** When `token` was obtained. */
  private tokenAt = 0

  constructor(private readonly http: APIRequestContext) {}

  private data<T>(response: APIResponse, what: string): Promise<T> {
    return dataOf<T>(response, what)
  }

  /** A published post, with `viewCount`, `cover`, `series`, `featuredRank`. */
  post(slug: string): Promise<Post> {
    return this.http.get(`/api/v1/posts/${encodeURIComponent(slug)}`).then((r) => this.data<Post>(r, `GET post ${slug}`))
  }

  /**
   * A page of comments of a post as a GUEST sees it (no Bearer: `mine` is always false). Read straight from the backend,
   * not through Next: comments are in no cache, so this is the current truth.
   */
  comments(slug: string, after?: string): Promise<CommentPage> {
    return this.http
      .get(`/api/v1/posts/${encodeURIComponent(slug)}/comments${queryOf({ after })}`)
      .then((r) => this.data<CommentPage>(r, `GET comments ${slug}`))
  }

  /** The likes of a post as a GUEST sees them (`liked` is always false): the number every reader sees. */
  likes(slug: string): Promise<LikeState> {
    return this.http
      .get(`/api/v1/posts/${encodeURIComponent(slug)}/like`)
      .then((r) => this.data<LikeState>(r, `GET like ${slug}`))
  }

  /** Every published post, newest first (the order PostNav uses to find the previous/next post). */
  publishedPosts(): Promise<PostSummary[]> {
    return this.http.get(`/api/v1/posts?page=0&size=100&lang=${E2E_LOCALE}`).then((r) => this.data<PostSummary[]>(r, 'GET posts'))
  }

  /**
   * The OLDEST published post: always a sample post prerendered at build time (a real ISR page, with
   * `x-nextjs-prerender`), never the temporary post of another spec. For READING only: write tests (comments,
   * likes) use the temporary post (admin.ts, createTemporaryPost).
   */
  async prerenderedPost(): Promise<PostSummary> {
    const post = (await this.publishedPosts()).at(-1)
    if (!post) throw new Error('The QA stack has no published post')
    return post
  }

  /** "Best posts" by `featured_rank`. */
  featured(): Promise<PostSummary[]> {
    return this.http
      .get(`/api/v1/posts?featured=true&page=0&size=50&lang=${E2E_LOCALE}`)
      .then((r) => this.data<PostSummary[]>(r, 'GET featured'))
  }

  /** Public series (with at least one published post), in the order the /series page lists them. */
  seriesList(): Promise<SeriesSummary[]> {
    return this.http.get(`/api/v1/series?lang=${E2E_LOCALE}`).then((r) => this.data<SeriesSummary[]>(r, 'GET series'))
  }

  /** Published photos, in the order the /gallery page shows them (100 is the API's `size` ceiling). */
  gallery(): Promise<GalleryPhoto[]> {
    return this.http.get('/api/v1/gallery?page=0&size=100').then((r) => this.data<GalleryPhoto[]>(r, 'GET gallery'))
  }

  /** The detail of a public series; null on 404 (an unknown slug or no published part left). */
  async series(slug: string): Promise<SeriesDetail | null> {
    const response = await this.http.get(`/api/v1/series/${encodeURIComponent(slug)}?lang=${E2E_LOCALE}`)
    if (response.status() === 404) return null
    return this.data<SeriesDetail>(response, `GET series ${slug}`)
  }

  /**
   * A still-usable admin token; with `renew` it is made again regardless. The administrator cannot sign in with a password alone: the
   * token comes from the API session that the global setup made and that support/admin-session.ts keeps alive, refreshing it or
   * signing in again with a recovery code when the stack ended it.
   */
  private async adminToken(renew = false): Promise<string> {
    if (!renew && this.token !== null && Date.now() - this.tokenAt <= ADMIN_TOKEN_REUSE_MS) return this.token
    const token = await adminAccessToken({ force: renew })
    this.token = token
    this.tokenAt = Date.now()
    return token
  }

  /**
   * Call the admin API with a Bearer token. The token lives 15 minutes; if it expires mid-run it signs in again
   * exactly once instead of letting a cleanup error look like an app error.
   */
  private async admin(method: Method, path: string, body?: unknown): Promise<APIResponse> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.adminToken(attempt === 1)
      const response = await this.http.fetch(path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { data: body }),
      })
      if (response.status() !== 401) return response
    }
    throw new Error(`${method} ${path}: 401 after signing in again`)
  }

  /** Call the backend with a person's access token (the `access_token` cookie after loginWithGitHub). */
  asUser(accessToken: string): UserApi {
    return new UserApi(this.http, accessToken)
  }

  /**
   * Like asUser, with the token of the administrator account (`E2E_ADMIN_EMAIL`, signed in through both steps): moderate comments,
   * suspend and unsuspend readers, search users. Fetch it fresh each time it is needed, do not hold it across tests: the token
   * only lives 15 minutes.
   */
  async asAdmin(): Promise<UserApi> {
    return new UserApi(this.http, await this.adminToken())
  }

  /**
   * `POST /auth/refresh` with a refresh token, returning the response untouched: the sign-out test checks the old token
   * gets 401. A success is a ROTATION: the token passed in is revoked, and the browser holding it loses
   * its session at the next refresh. The response body contains the new token: do not print it.
   */
  refresh(refreshToken: string): Promise<APIResponse> {
    return this.http.post('/api/v1/auth/refresh', { data: { refreshToken } })
  }

  /** Every post (any status) — to find an id by slug. */
  adminPosts(): Promise<PostSummary[]> {
    return this.admin('GET', '/api/v1/admin/posts?page=0&size=100').then((r) => this.data<PostSummary[]>(r, 'GET admin posts'))
  }

  /** The newsletters that wait for an administrator: the first publication of a post by an author. */
  heldNewsletterIssues(): Promise<{ postId: string; title: string }[]> {
    return this.admin('GET', '/api/v1/admin/newsletter/held').then((r) =>
      this.data<{ postId: string; title: string }[]>(r, 'GET held newsletters'),
    )
  }

  /** Refuses a held newsletter, so that a test leaves nothing waiting for the next run of the stack. */
  async discardNewsletterIssue(postId: string): Promise<void> {
    const response = await this.admin('POST', `/api/v1/admin/newsletter/issues/${encodeURIComponent(postId)}/discard`)
    if (response.status() !== 204) throw new Error(`discard newsletter ${postId}: ${response.status()}`)
  }

  /**
   * A new DRAFT, for the temporary post of the comment and like specs (admin.ts, createTemporaryPost).
   * A draft is in no cached public data, so creating it directly here is harmless; publishing goes
   * through the admin UI. With no category it takes the first category: publishing a post needs a category.
   */
  async createDraftPost(input: {
    title: string
    content: string
    excerpt?: string
    categoryId?: string
    language?: string
  }): Promise<Post> {
    const categoryId = input.categoryId ?? (await this.adminCategories())[0]?.id
    if (!categoryId) throw new Error('At least one category is needed to create a publishable temporary post')
    const response = await this.admin('POST', '/api/v1/admin/posts', {
      ...input,
      language: input.language ?? E2E_LOCALE,
      categoryId,
      tagIds: [],
    })
    return this.data<Post>(response, 'POST admin posts')
  }

  adminGallery(): Promise<GalleryPhotoAdmin[]> {
    return this.admin('GET', '/api/v1/admin/gallery').then((r) => this.data<GalleryPhotoAdmin[]>(r, 'GET admin gallery'))
  }

  adminSeries(): Promise<SeriesAdmin[]> {
    return this.admin('GET', '/api/v1/admin/series').then((r) => this.data<SeriesAdmin[]>(r, 'GET admin series'))
  }

  async deleteGalleryPhoto(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/api/v1/admin/gallery/${id}`)
    if (!response.ok() && response.status() !== 404) throw new Error(`DELETE gallery ${id}: ${response.status()}`)
  }

  async deleteSeries(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/api/v1/admin/series/${id}`)
    if (!response.ok() && response.status() !== 404) throw new Error(`DELETE series ${id}: ${response.status()}`)
  }

  adminCategories(): Promise<Category[]> {
    return this.admin('GET', '/api/v1/admin/categories').then((r) => this.data<Category[]>(r, 'GET admin categories'))
  }

  adminTags(): Promise<Tag[]> {
    return this.admin('GET', '/api/v1/admin/tags').then((r) => this.data<Tag[]>(r, 'GET admin tags'))
  }

  /** Only to clean up the temporary category of the Topics test (a category with no posts yet). */
  async deleteCategory(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/api/v1/admin/categories/${id}`)
    if (!response.ok() && response.status() !== 404) throw new Error(`DELETE category ${id}: ${response.status()}`)
  }

  async deleteTag(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/api/v1/admin/tags/${id}`)
    if (!response.ok() && response.status() !== 404) throw new Error(`DELETE tag ${id}: ${response.status()}`)
  }

  /** The backend's public search (the same contract the palette and /search use). */
  async search(params: Record<string, string>): Promise<{
    query: string
    engine: string
    degraded: boolean
    groups: Array<{ type: string; total: number; items: Array<{ id: string; href: string }> }>
  }> {
    const response = await this.http.get(`/api/v1/search?${new URLSearchParams({ lang: E2E_LOCALE, ...params })}`)
    return this.data(response, 'GET search')
  }

  /** Rebuild the Meilisearch index (ADMIN), a dry run or for real. */
  async searchReindex(dryRun = false): Promise<Record<string, unknown>> {
    const response = await this.admin('POST', `/api/v1/admin/search/reindex?dryRun=${dryRun}`)
    return this.data(response, 'POST admin search reindex')
  }

  /** The search status (ADMIN): engine, index, document counts by kind compared with Postgres, outbox. */
  async searchStatus(): Promise<Record<string, unknown>> {
    const response = await this.admin('GET', '/api/v1/admin/search/status')
    return this.data(response, 'GET admin search status')
  }

  /**
   * Change the slug of a post through the API, keeping every other field. The old slug stays in the backend's slug history,
   * so a request for it answers 308. Only for the temporary post of a spec: the public lists are not refreshed.
   */
  async renamePostSlug(id: string, slug: string): Promise<void> {
    const post = await this.data<Post>(await this.admin('GET', `/api/v1/admin/posts/${id}`), `GET admin post ${id}`)
    const response = await this.admin('PUT', `/api/v1/admin/posts/${id}`, {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      categoryId: post.category?.id,
      tagIds: post.tags.map((tag) => tag.id),
      slug,
    })
    await expectOk(response, `PUT admin post ${id}`)
  }

  /**
   * Delete a post outright (and its cover image, comments, likes). Only to clean up temporary posts: the post-editing test's,
   * or the comment spec's temporary post when deleting through the UI fails. 404 (already deleted) is not an error.
   */
  async deletePost(id: string): Promise<void> {
    const response = await this.admin('DELETE', `/api/v1/admin/posts/${id}`)
    if (!response.ok() && response.status() !== 404) throw new Error(`DELETE post ${id}: ${response.status()}`)
  }

  async deleteCover(postId: string): Promise<void> {
    const response = await this.admin('DELETE', `/api/v1/admin/posts/${postId}/cover`)
    if (!response.ok()) throw new Error(`DELETE cover ${postId}: ${response.status()}`)
  }

  async setFeaturedOrder(postIds: string[]): Promise<void> {
    const response = await this.admin('PUT', '/api/v1/admin/posts/featured-order', { postIds })
    if (!response.ok()) throw new Error(`PUT featured-order: ${response.status()} ${await response.text()}`)
  }
}
