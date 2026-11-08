/**
 * Environment variables of the E2E suite other than the ones described in playwright.config.ts. The defaults match the isolated stack in the README.
 */

/** The frontend under test (`E2E_BASE_URL`, default the local QA stack); playwright.config.ts uses it as `baseURL`. */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100'

/** The backend of the SAME stack the frontend points to: tests compare before/after numbers through it. */
export const API_URL = (process.env.E2E_API_URL ?? 'http://localhost:8081').replace(/\/+$/, '')

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@blog.local'
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin12345'

/** A real phone photo to upload; null → e2e/support/photos.ts generates a photo with the same characteristics. */
export const PHONE_PHOTO = process.env.E2E_PHONE_PHOTO?.trim() || null

/** The search engine the QA backend is running: only `meilisearch` enables the opt-in spec `search-meili.spec.ts`. */
export const SEARCH_ENGINE = process.env.E2E_SEARCH_ENGINE?.trim() || 'postgres'

/**
 * The fake GitHub (e2e/mock-github/server.mjs), listening only on 127.0.0.1: playwright.config.ts starts
 * it on this port. The QA backend must point its three `app.oauth.github.provider.*` addresses at EXACTLY this port (the
 * "QA backend" command in the README uses 8089): change one side and forget the other and every sign-in breaks.
 */
export const MOCK_GITHUB_PORT = Number(process.env.MOCK_GITHUB_PORT || 8089)
export const MOCK_GITHUB_URL = `http://127.0.0.1:${MOCK_GITHUB_PORT}`
