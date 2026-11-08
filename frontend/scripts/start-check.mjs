// Starts the Next standalone server of the production image, after one check.
//
// NEXT_PUBLIC_SITE_URL is compiled into the bundle when the image is built, and `headers()` of next.config.ts decides then whether the
// site sends Strict-Transport-Security. An image built for another address than the one it runs under (the default of a plain build is
// http://localhost:3000, and `SITE_URL` in .env changed without `docker compose up -d --build`) serves canonical URLs, Open Graph tags
// and a sitemap that all name the wrong site, and no HSTS, without a single error. The Dockerfile records the address it was built for
// in BAKED_SITE_URL, compose gives the container the SITE_URL of .env, and this file refuses to start when the two differ.
//
// No SITE_URL in the environment (a plain `docker run` for a trial on localhost) means there is nothing to compare: it starts.
// ALLOW_SITE_URL_MISMATCH=true starts anyway, with the same text as a warning.
//
// The second check is API_BASE_URL (api-base-url-rule.mjs, the rule of lib/api-base-url.ts): plain `http` to a host other machines can
// sit between carries the bearer tokens in the clear, and without this check the server would start, answer /robots.txt for the
// healthcheck and fail every page that talks to the API with a 500. API_ALLOW_PLAINTEXT=true is the operator's way to accept it.
//
// Plain JavaScript, no imports from the app: the image has node, the standalone server and the one rule file copied next to this one.
// Tested by start-check.test.ts.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { apiBaseUrl } from './api-base-url-rule.mjs'

/** `scheme://host[:port]` in lower case, or null for a value that is not a URL. Only this is ever printed: never a path or credentials. */
function originOf(value) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return null
  }
}

/**
 * @param {{ nodeEnv?: string, baked?: string, runtime?: string, allow?: string }} input
 * @returns {{ level: 'ok' | 'warn' | 'fatal', message: string }}
 */
export function siteUrlProblem({ nodeEnv, baked, runtime, allow }) {
  if (nodeEnv !== 'production') return { level: 'ok', message: '' }
  const wanted = (runtime ?? '').trim()
  if (wanted === '') return { level: 'ok', message: '' }
  const built = (baked ?? '').trim()
  const builtOrigin = originOf(built)
  const wantedOrigin = originOf(wanted)
  if (builtOrigin !== null && builtOrigin === wantedOrigin) return { level: 'ok', message: '' }

  const message =
    `This image was built for ${builtOrigin ?? 'an unknown address'} but SITE_URL says ${wantedOrigin ?? 'a value that is not a URL'}. ` +
    'The address is compiled into the site when the image is built: its canonical URLs, Open Graph tags and sitemap would name the ' +
    'wrong site, and an https site would send no Strict-Transport-Security header. Rebuild the frontend image with your SITE_URL ' +
    '(docker compose up -d --build). Set ALLOW_SITE_URL_MISMATCH=true to start anyway.'
  return { level: allow === 'true' ? 'warn' : 'fatal', message }
}

/** The message of the rule for API_BASE_URL, or '' when the value is acceptable. Only the host is ever in it, never the rest of the value. */
export function apiBaseUrlProblem(env) {
  try {
    apiBaseUrl(env)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Was this file started directly (`node start-check.mjs`), as opposed to imported by a test? Node resolves symlinks of the entry file, a
 * Windows short path (ADMINI~1) stays as typed: so both spellings of argv[1] are compared. */
function isEntryPoint() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href || import.meta.url === pathToFileURL(realpathSync(entry)).href
}

const isMain = isEntryPoint()
if (isMain) {
  const result = siteUrlProblem({
    nodeEnv: process.env.NODE_ENV,
    baked: process.env.BAKED_SITE_URL,
    runtime: process.env.SITE_URL,
    allow: process.env.ALLOW_SITE_URL_MISMATCH,
  })
  if (result.level === 'fatal') {
    console.error(result.message)
    process.exit(1)
  }
  if (result.level === 'warn') console.error(result.message)
  const apiProblem = apiBaseUrlProblem(process.env)
  if (apiProblem !== '') {
    console.error(apiProblem)
    process.exit(1)
  }
  // Built from the URL of this file, so that a bundler (Vitest reads this file for its tests) does not try to resolve a server.js that
  // only exists next to it inside the image.
  await import(/* @vite-ignore */ new URL('./server.js', import.meta.url).href)
}
