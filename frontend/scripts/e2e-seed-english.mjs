/**
 * E2E only: gives every published post of the default language an English translation (a copy of the text, published), so the
 * English journeys (`E2E_LOCALE=en`) have English posts to list, search and open. Run it against the E2E backend BEFORE the
 * frontend is built: the pages prerender from the data at build time.
 *
 *   E2E_API_URL=http://localhost:8082 node scripts/e2e-seed-english.mjs
 *
 * The stack's administrator must have been enrolled first (`node scripts/e2e-bootstrap.mjs`), because a password alone no longer signs in.
 */
import { API, adminToken } from './e2e-stack.mjs'

async function call(method, path, token, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  return response.status === 204 ? null : (await response.json()).data
}

// The administrator signs in through both steps: the authenticator that scripts/e2e-bootstrap.mjs recorded (e2e/.auth/admin-mfa.json).
const accessToken = await adminToken()
const posts = await call('GET', '/api/v1/posts?page=0&size=100&lang=vi', null)
let created = 0
for (const summary of posts) {
  if ((summary.translations ?? []).some((t) => t.language === 'en')) continue
  const post = await call('GET', `/api/v1/posts/${encodeURIComponent(summary.slug)}`, null)
  const draft = await call('POST', `/api/v1/admin/posts/${post.id}/translations`, accessToken, { language: 'en' })
  await call('PUT', `/api/v1/admin/posts/${draft.id}`, accessToken, {
    title: post.title,
    excerpt: post.excerpt,
    content: post.content,
    categoryId: post.category?.id ?? null,
    tagIds: post.tags.map((tag) => tag.id),
    slug: draft.slug,
    language: 'en',
  })
  await call('POST', `/api/v1/admin/posts/${draft.id}/publish`, accessToken)
  created += 1
}
console.log(`English translations created: ${created}`)
