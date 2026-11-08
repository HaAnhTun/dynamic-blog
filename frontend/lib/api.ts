import 'server-only'
import type { Locale } from '@/i18n/config'
import { clientIpHeaders } from './client-ip'
import type { BackendSearchResponse, SearchScope } from './search-contract'
import type { Page, PageMeta, Post, PostSummary, UserProfile } from './types'
import { apiBaseUrl } from '@/lib/api-base-url'

const BASE_URL = apiBaseUrl()

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export class NotFoundError extends ApiError {
  constructor(code: string | undefined, message: string) {
    super(404, code, message)
    this.name = 'NotFoundError'
  }
}

type Envelope<T> = { data: T; pagination?: PageMeta }
type ErrorEnvelope = { error?: { code?: string; message?: string } }

/**
 * fetch resolves rather than throws on 4xx/5xx, and the backend answers errors with
 * an {"error":{...}} body — so anything that reads `.data` before checking the status
 * gets `undefined` and fails later with a confusing TypeError.
 */
async function request<T>(path: string, init: RequestInit): Promise<Envelope<T>> {
  const res = await fetch(`${BASE_URL}${path}`, init)

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorEnvelope
    const code = body.error?.code
    // The path carries no query string: the error may be logged (Next logs uncaught errors), and `?q=` is the text
    // the reader typed into the search box (search queries must not leak into logs).
    const message = body.error?.message ?? `API responded ${res.status} for ${path.split('?')[0]}`
    if (res.status === 404) throw new NotFoundError(code, message)
    throw new ApiError(res.status, code, message)
  }

  return (await res.json()) as Envelope<T>
}

export async function getPosts(params: {
  page: number
  size: number
  category?: string
  /** A tag **slug**, not a name — see the note on `PostSummary.tags`. */
  tag?: string
  /**
   * Narrows to the featured posts. Optional and tri-state on purpose: absent means
   * "every post", `true` means "the featured ones", and `false` is treated as absent
   * rather than sent — see the guard below.
   */
  featured?: boolean
  /** The author's `profileSlug`: only that person's published posts; an unknown slug is an empty page. */
  author?: string
  /** Only posts written in this language; absent means every language. */
  language?: Locale
}): Promise<Page<PostSummary>> {
  const query = new URLSearchParams({
    page: String(params.page),
    size: String(params.size),
  })
  if (params.category) query.set('category', params.category)
  if (params.tag) query.set('tag', params.tag)
  if (params.author) query.set('author', params.author)
  if (params.language) query.set('lang', params.language)
  // `=== true`, and never an `if (params.featured !== undefined)` that would forward
  // false.
  //
  // Measured against the running backend, not assumed: /posts?size=1 and
  // /posts?size=1&featured=false both answer totalElements 12, while featured=true
  // answers 4. So `featured=false` is NOT an error today — PostService.listPublished
  // tests `Boolean.TRUE.equals(featured)` and collapses false into absent. That is
  // precisely why forwarding it is a latent bug rather than a visible one: the
  // parameter is a boxed `Boolean` with no default specifically so that absent and
  // false STAY distinguishable (PostController says so), so the day that branch grows
  // an `isFalse` arm for an admin filter, every caller that passed `featured={flag}`
  // with flag false silently inverts — and nothing on this site wants the
  // not-featured set. Sending only what we mean costs one `=== true`.
  if (params.featured === true) query.set('featured', 'true')

  const body = await request<PostSummary[]>(`/api/v1/posts?${query}`, {
    next: { revalidate: 300, tags: ['posts'] },
  })

  return {
    items: body.data,
    meta: body.pagination ?? { page: params.page, size: params.size, totalElements: 0, totalPages: 0 },
  }
}

/**
 * Next rejects a cache tag longer than 256 characters: it logs
 * `invalid tags passed to fetch … exceeded max length of 256` and drops the tag, so a
 * later `revalidateTag` for that post would silently do nothing. The slug comes from the
 * URL, so a reader chooses this string — `/posts/<2000 a's>` was enough to trigger it
 * once `/posts/[slug]` existed. Truncating keeps the tag valid; two absurdly long slugs
 * sharing a prefix would share a tag, which is a better failure than no tag at all.
 */
export function postTag(slug: string): string {
  return `post-${slug}`.slice(0, 256)
}

/** Cache tag of a profile, cut at 256 characters like `postTag`. */
export function userTag(slug: string): string {
  return `user-${slug}`.slice(0, 256)
}

/**
 * The public profile of a person. 404 USER_NOT_FOUND (missing, or suspended) is a NotFoundError.
 *
 * Rebuilt with only the contract's fields: an unknown field the backend happens to send (email, role) does not travel on into the page.
 */
export async function getUserProfile(slug: string): Promise<UserProfile> {
  const body = await request<UserProfile>(`/api/v1/users/${encodeURIComponent(slug)}`, {
    // 'posts': publishedPosts (the badge, index or noindex) changes on every publish, unpublish, delete of a post.
    next: { revalidate: 300, tags: ['users', 'posts', userTag(slug)] },
  })
  const { displayName, githubLogin, avatarUrl, siteOwner, joinedAt, publishedPosts } = body.data
  return { slug: body.data.slug, displayName, githubLogin, avatarUrl, siteOwner, joinedAt, publishedPosts }
}

/** Like `callApi` (lib/user-api.ts): when the backend hangs, search reports an error instead of hanging along. */
const SEARCH_TIMEOUT_MS = 10_000

export type ContentSearchParams = {
  q: string
  type?: SearchScope
  /** Rows per group (1–10); with `type: 'post'` use `page`/`size`. */
  limit?: number
  page?: number
  size?: number
  category?: string
  tags?: string[]
  series?: string
  language?: Locale
}

/**
 * Shared search client of the quick search palette and `/search`: `GET /api/v1/search`, where the backend chooses the
 * engine by `SEARCH_ENGINE` and falls back to Postgres by itself (`degraded`). Not through the data cache (the query is text the reader
 * typed, which must not be cached), has a timeout; errors carry no query string (`request`). Filters only go with `type: 'post'`.
 */
export async function searchContent(
  params: ContentSearchParams,
  options: {
    signal?: AbortSignal
    /** The visitor's address (lib/client-ip.ts, `null` when unknown) for the backend's per-address search limit. */
    clientIp?: string | null
  } = {},
): Promise<BackendSearchResponse<PostSummary>> {
  const query = new URLSearchParams()
  const q = params.q.trim()
  if (q !== '') query.set('q', q)
  query.set('type', params.type ?? 'all')
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.page !== undefined) query.set('page', String(params.page))
  if (params.size !== undefined) query.set('size', String(params.size))
  if (params.category) query.set('category', params.category)
  for (const tag of params.tags ?? []) if (tag !== '') query.append('tag', tag)
  if (params.series) query.set('series', params.series)
  if (params.language) query.set('lang', params.language)

  const body = await request<BackendSearchResponse<PostSummary>>(`/api/v1/search?${query}`, {
    cache: 'no-store',
    signal: options.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    // Without a visitor (undefined) no header is sent. The query itself stays in the URL, as before.
    ...(options.clientIp === undefined ? {} : { headers: clientIpHeaders(options.clientIp) }),
  })
  return body.data
}

export async function getPost(slug: string): Promise<Post> {
  const body = await request<Post>(`/api/v1/posts/${encodeURIComponent(slug)}`, {
    next: { revalidate: 300, tags: ['posts', postTag(slug)] },
  })
  return body.data
}

/**
 * The current slug of a published post that once had the path `slug`, or null when there is none.
 *
 * The backend records the old slug whenever the slug of a published post changes, and answers
 * `GET /api/v1/posts/{slug}/redirect` with `{"data":{"slug":"<current slug>"}}` ONLY when that post
 * is published; every other case is 404 POST_NOT_FOUND. The post page calls this when getPost has
 * returned 404, then redirects with 308 to the new slug.
 *
 * Same cache as getPost — 300 seconds, tag 'posts' and the tag of the slug asked about — so that one save
 * in admin (updateTag('posts')) refreshes this answer together with the post: changing the slug again,
 * or changing back to the old slug, does not let the old redirect live five more minutes.
 *
 * Every 404 is null, including ENDPOINT_NOT_FOUND from a backend that does not have this endpoint yet (frontend shipping
 * before the backend): an unknown slug is then still a 404 as before, not a 500. Other errors pass through
 * intact, like getPost: an incident must not look like "the post does not exist", which a crawler would cache.
 *
 * A returned body without a non-empty slug is also null: a redirect to `/posts/` or
 * `/posts/undefined` is another 404 page, arriving after a useless redirect.
 */
export async function getPostRedirect(slug: string): Promise<string | null> {
  let body: Envelope<{ slug?: unknown } | null>
  try {
    body = await request<{ slug?: unknown } | null>(`/api/v1/posts/${encodeURIComponent(slug)}/redirect`, {
      next: { revalidate: 300, tags: ['posts', postTag(slug)] },
    })
  } catch (error) {
    if (error instanceof NotFoundError) return null
    throw error
  }
  const target = body.data?.slug
  return typeof target === 'string' && target !== '' ? target : null
}
