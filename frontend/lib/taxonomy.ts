import 'server-only'
import type { Locale } from '@/i18n/config'
import { ApiError, NotFoundError } from './api'
import type { Category, Tag } from './types'
import { apiBaseUrl } from '@/lib/api-base-url'

/**
 * The category and tag lists.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT `lib/api.ts`: lib/api.ts belongs to another
 * agent in this run and has no category or tag reader at all (grepped: nothing in the
 * tree calls /api/v1/categories or /api/v1/tags). Three pages need one — the writing
 * index for its filter strip, and both archives for the "unknown slug is a 404, not an
 * empty list" rule, which is only decidable against the real list. Inlining the fetch
 * three times was the alternative. This module should be folded into lib/api.ts by
 * whoever owns it; nothing here is intentionally distinct from `request` there except
 * that it cannot reach it (`request` is not exported).
 *
 * MEASURED SHAPES, not guessed. Against the running backend:
 *
 *   curl -s localhost:8080/api/v1/categories
 *   {"data":[{"id":"8cd0…","name":"How I work","slug":"cach-toi-lam-viec",
 *             "description":"Process, verification, …"},
 *            {"id":"69bf…","name":"Debugging","slug":"go-loi","description":null}, …]}
 *
 *   curl -s localhost:8080/api/v1/tags
 *   {"data":[{"id":"0481…","name":"AI","slug":"ai"},
 *            {"id":"de0c…","name":"Lessons","slug":"bai-hoc"}, …]}
 *
 * Two things fall out of that and are load-bearing below:
 *  - Neither answer carries a `pagination` key. These are complete lists, not pages,
 *    so there is no `size` to pass and no second page to miss. 6 categories, 16 tags.
 *  - `description` is nullable on a category and ABSENT from a tag entirely. A caller
 *    that renders `tag.description` would print nothing in dev and would be a type
 *    error here, which is the point of not sharing one type between the two.
 *  - A tag's `name` and `slug` differ whenever the name has diacritics, capitals or
 *    punctuation: "Lessons"/"bai-hoc" (the slug keeps the Vietnamese words, folded to ASCII), "CI/CD"/"ci-cd", "Spring Boot"/"spring-boot".
 *    Every link must be built from `slug`.
 */

const BASE_URL = apiBaseUrl()

type Envelope<T> = { data: T }
type ErrorEnvelope = { error?: { code?: string; message?: string } }

/**
 * Throws on a non-2xx rather than returning [].
 *
 * This is the single most important decision in this file, and it is a deliberate
 * refusal of the softer option. Both archive pages call these and `notFound()` when
 * the slug is not in the list. If a transport failure came back as an empty list,
 * EVERY category and tag archive would answer 404 for as long as the API was unwell —
 * a cache-poisoning 404 storm across every archive URL on the site, triggered by a
 * blip. An exception reaches app/error.tsx and tells the truth (500), and the pages
 * below deliberately do not catch it. There is a test for exactly this.
 */
async function getOne<T>(path: string, cacheTag: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    // Same 300s window as the post listings, under its own tag: creating a category
    // does not publish a post, so these must be sweepable without touching 'posts'
    // and vice versa.
    next: { revalidate: 300, tags: [cacheTag] },
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorEnvelope
    const code = body.error?.code
    const message = body.error?.message ?? `API responded ${res.status} for ${path}`
    if (res.status === 404) throw new NotFoundError(code, message)
    throw new ApiError(res.status, code, message)
  }

  return ((await res.json()) as Envelope<T>).data
}

async function getAll<T>(path: string, cacheTag: string): Promise<T[]> {
  const data = await getOne<T[] | null>(path, cacheTag)
  // `?? []` and not a bare `data`: a 200 with a missing or null `data` would
  // otherwise hand callers `undefined` and crash in `.find()` / `.map()` far from here.
  return data ?? []
}

function withLang(path: string, language?: Locale): string {
  return language ? `${path}?lang=${language}` : path
}

/** With a language, only the categories that have a published post in it, named in that language. */
export function getCategories(language?: Locale): Promise<Category[]> {
  return getAll<Category>(withLang('/api/v1/categories', language), 'categories')
}

/** With a language, only the tags that have a published post in it, named in that language. */
export function getTags(language?: Locale): Promise<Tag[]> {
  return getAll<Tag>(withLang('/api/v1/tags', language), 'tags')
}

/**
 * One category, localized when a language is given. Visible when it has a published post in ANY language, so a page
 * can show "no posts in this language yet" instead of a 404. An unknown slug is a NotFoundError.
 */
export async function getCategory(slug: string, language?: Locale): Promise<Category> {
  return getOne<Category>(withLang(`/api/v1/categories/${encodeURIComponent(slug)}`, language), 'categories')
}

/** One tag, see `getCategory`. */
export async function getTag(slug: string, language?: Locale): Promise<Tag> {
  return getOne<Tag>(withLang(`/api/v1/tags/${encodeURIComponent(slug)}`, language), 'tags')
}
