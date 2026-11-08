/**
 * Fake GitHub for E2E: plain `node:http`, no dependencies, listening only on
 * 127.0.0.1. The site runs at `localhost`, the fake at `127.0.0.1`: two different sites, like github.com and
 * the real blog, so SameSite cookies and cross-site redirects are really exercised. (At `localhost:8089`
 * a SameSite=Strict cookie would slip through E2E and then break on github.com: SameSite ignores the port.)
 *
 * Playwright starts the fake through `webServer` (playwright.config.ts); the QA backend points its three provider
 * addresses here (`app.oauth.github.provider.*`). The fake never goes into the image: the Dockerfile only
 * copies the standalone build, static and public.
 *
 * Behaves like GitHub where the blog relies on it:
 * - `GET /login/oauth/authorize`: checks client_id, response_type, a redirect_uri exactly equal to the registered
 *   callback (a mismatch goes to the registered callback with `redirect_uri_mismatch`, like GitHub), a state and
 *   PKCE S256, scope exactly `read:user`. The last three are stricter than GitHub, on purpose: they are
 *   design decisions, and a regression that loses them would still sign in against
 *   real GitHub. With a `mock_user=<login>` cookie it agrees by itself (like GitHub with an already authorized
 *   app); without it it shows an account chooser page ("Continue with <login>", "Deny").
 * - `POST /login/oauth/access_token`: the client's HTTP Basic, a single-use code valid for 60 seconds,
 *   a redirect_uri equal to the authorize hop, the S256 hash of code_verifier. A wrong or used code gets
 *   **HTTP 200** with `{"error":"bad_verification_code"}`, exactly like real GitHub.
 * - `GET /user`: the profile for a Bearer token; 401 for an unknown token; 403 when User-Agent is missing (like GitHub).
 *
 * Controlled from tests (e2e/support/github.ts, the MockGithub class):
 * - `GET /__e2e/health`: ready (Playwright waits on this address);
 * - `POST /__e2e/reset`: back to the original user list, dropping every code, token and installed failure;
 * - `POST /__e2e/fail?endpoint=token|user&status=500|hang|bad_code&times=1`: the next `times` calls of that
 *   hop fail (a 4xx/5xx status; `hang` holds the connection without answering; `bad_code` is HTTP 200
 *   with `bad_verification_code`, only for the token hop);
 * - `PATCH /__e2e/users/:id` `{login?, name?, email?, avatarUrl?}`: change the profile, keeping the id.
 *
 * It never writes out a code, state, token or email: the log of an E2E run is scanned for them.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { buildRoster, githubProfile } from './users.mjs'

const HOST = '127.0.0.1'
const PORT = Number(process.env.MOCK_GITHUB_PORT || 8089)
const CLIENT_ID = process.env.MOCK_GITHUB_CLIENT_ID || 'e2emockclient'
const CLIENT_SECRET = process.env.MOCK_GITHUB_CLIENT_SECRET || 'e2emocksecret'
/** The OAuth app's registered callback: the callback of the SITE (Next), not of the backend. */
const CALLBACK = process.env.MOCK_GITHUB_CALLBACK || 'http://localhost:3100/api/auth/github/callback'
const ORIGIN = `http://${HOST}:${PORT}`

/** The only scope the blog asks for: the public profile, no email. */
const SCOPE = 'read:user'
/** An authorize code lives 60 seconds (GitHub gives 10 minutes; shorter so an error from holding a code too long shows up). */
const CODE_TTL_MS = 60_000
/** An authorize waiting for a person to click on the account chooser page. */
const PENDING_TTL_MS = 10 * 60_000
/** A connection held by a `hang` failure closes by itself after this long, if the backend has not given up (it reads for at most 10 s). */
const HANG_MAX_MS = 60_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_ENTRIES = 10_000
const DOCS = 'https://docs.github.com/apps/oauth-apps/maintaining-oauth-apps'

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  console.error(`MOCK_GITHUB_PORT is invalid: ${process.env.MOCK_GITHUB_PORT}`)
  process.exit(1)
}
try {
  new URL(CALLBACK)
} catch {
  console.error(`MOCK_GITHUB_CALLBACK must be an absolute URL: ${CALLBACK}`)
  process.exit(1)
}

/**
 * @typedef {import('./users.mjs').MockUser} MockUser
 * @typedef {{ redirectUri: string, state: string, codeChallenge: string, expiresAt: number }} AuthorizeRequest
 * @typedef {{ userId: number, redirectUri: string, codeChallenge: string, expiresAt: number }} Grant
 * @typedef {{ mode: number | 'hang' | 'bad_code', remaining: number }} Failure
 */

/** The fake's state; `/__e2e/reset` rebuilds it from scratch. */
const store = {
  /** @type {Map<number, MockUser>} GitHub id → user (a modifiable copy) */
  users: new Map(),
  /** @type {Map<string, AuthorizeRequest>} an authorize sitting on the account chooser page */
  pending: new Map(),
  /** @type {Map<string, Grant>} authorize codes not yet used */
  codes: new Map(),
  /** @type {Map<string, { userId: number, expiresAt: number }>} access token → user */
  tokens: new Map(),
  /** @type {Map<'token' | 'user', Failure>} the failure installed for each hop */
  failures: new Map(),
}

/** Responses being held (a `hang` failure): reset and the time limit can close them. */
const heldResponses = new Set()

function reset() {
  store.users = new Map(buildRoster().map((user) => [user.id, user]))
  store.pending.clear()
  store.codes.clear()
  store.tokens.clear()
  store.failures.clear()
  for (const entry of heldResponses) entry.release()
}

// --- Helpers --------------------------------------------------------------------------------------

/** A warning for the reader of the Playwright log (stderr is printed, with the webServer prefix). */
function warn(message) {
  console.error(message)
}

/**
 * Write an entry with an expiry: drop expired entries, and keep at most MAX_ENTRIES entries (dropping the oldest), so one
 * long run does not make the fake balloon.
 *
 * @template {{ expiresAt: number }} T
 * @param {Map<string, T>} map
 * @param {string} key
 * @param {T} value
 */
function remember(map, key, value) {
  const now = Date.now()
  for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k)
  while (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value)
  map.set(key, value)
}

/** Login is case-insensitive, like GitHub. */
function userByLogin(login) {
  const wanted = login.toLowerCase()
  for (const user of store.users.values()) if (user.login.toLowerCase() === wanted) return user
  return undefined
}

function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/** PKCE S256 (RFC 7636 section 4.2): base64url(SHA-256(ASCII(code_verifier))), no padding. */
function s256(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** Spring's `client_secret_basic` URL-encodes each part before joining (RFC 6749 section 2.3.1). */
function basicClient(authorization) {
  const match = /^Basic\s+(\S+)$/i.exec(authorization ?? '')
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon === -1) return null
  const part = (text) => decodeURIComponent(text.replace(/\+/g, ' '))
  try {
    return { id: part(decoded.slice(0, colon)), secret: part(decoded.slice(colon + 1)) }
  } catch {
    return null
  }
}

/** The request body, or null when over MAX_BODY_BYTES (still read to the end so the keep-alive connection survives). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function sendJson(res, status, body) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'content-length': 0 })
  res.end()
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-length': 0 })
  res.end()
}

/** The callback with parameters, as GitHub builds it: `redirect_uri?code=…&state=…`. */
function callbackUrl(redirectUri, params) {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

function escapeHtml(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(text).replace(/[&<>"']/g, (ch) => entities[ch])
}

/** An HTML page of the fake: in English, readable by a screen reader, fits a 320px screen. */
function page(res, status, title, body) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Fake GitHub (E2E)</title>
<style>
  body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #1f2328; background: #fff; }
  main { max-width: 28rem; margin: 0 auto; }
  ul { display: grid; gap: .5rem; margin: 0 0 1rem; padding: 0; list-style: none; }
  button { width: 100%; min-height: 2.75rem; padding: .5rem 1rem; border: 1px solid #d0d7de; border-radius: 6px;
    background: #f6f8fa; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
  button:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
  .deny { background: #fff; color: #a40e26; }
  [role="alert"] { padding: .5rem 1rem; border: 1px solid #a40e26; border-radius: 6px; color: #82071e; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
  send(res, status, 'text/html; charset=utf-8', html)
}

// --- GitHub: authorize ----------------------------------------------------------------------------

/** The reader clicks "Authorize" (or the app is already authorized): a new code, back to the callback with the state. */
function approve(res, request, user) {
  const code = randomBytes(10).toString('hex')
  remember(store.codes, code, {
    userId: user.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    expiresAt: Date.now() + CODE_TTL_MS,
  })
  redirect(res, callbackUrl(request.redirectUri, { code, state: request.state }))
}

/** The reader clicks "Cancel": GitHub returns to the callback with `error=access_denied` and the state. */
function deny(res, request) {
  redirect(
    res,
    callbackUrl(request.redirectUri, {
      error: 'access_denied',
      error_description: 'The user has denied your application access.',
      error_uri: `${DOCS}/troubleshooting-authorization-request-errors#access-denied`,
      state: request.state,
    }),
  )
}

function chooser(res, requestId, unknownLogin) {
  const choices = [...store.users.values()]
    .map(
      (user) =>
        `<li><button type="submit" name="login" value="${escapeHtml(user.login)}">Continue with ${escapeHtml(user.login)}</button></li>`,
    )
    .join('\n')
  const notice =
    unknownLogin === null
      ? ''
      : `<p role="alert">Cookie mock_user=${escapeHtml(unknownLogin)} does not match any fake user.</p>\n`
  page(
    res,
    200,
    'Authorize application',
    `<h1>Authorize the application</h1>
${notice}<p>The application <strong>${escapeHtml(CLIENT_ID)}</strong> wants to read your public profile (${SCOPE}).</p>
<form method="post" action="/login/oauth/authorize" aria-labelledby="choose-account">
<input type="hidden" name="request" value="${requestId}">
<h2 id="choose-account">Choose an account</h2>
<ul>
${choices}
</ul>
<button type="submit" name="decision" value="deny" class="deny">Deny</button>
</form>`,
  )
}

function authorize(req, res, url) {
  const query = url.searchParams
  if (query.get('client_id') !== CLIENT_ID) {
    // Real GitHub returns a 404 page for an unknown client_id, with no redirect anywhere.
    return page(
      res,
      404,
      'Application not found',
      '<h1>OAuth application not found</h1>\n<p>The client_id does not match the registered application.</p>',
    )
  }

  const state = query.get('state') ?? ''
  const redirectUri = query.get('redirect_uri') ?? CALLBACK
  if (redirectUri !== CALLBACK) {
    // Like GitHub: go to the REGISTERED callback, not the address just sent, with an error. In E2E this is almost always
    // the QA backend's SITE_URL not matching E2E_BASE_URL.
    warn(`redirect_uri differs from the registered callback: received ${redirectUri}, registered ${CALLBACK}`)
    return redirect(
      res,
      callbackUrl(CALLBACK, {
        error: 'redirect_uri_mismatch',
        error_description: 'The redirect_uri MUST match the registered callback URL for this application.',
        error_uri: `${DOCS}/troubleshooting-authorization-request-errors#redirect-uri-mismatch`,
        state,
      }),
    )
  }

  const problems = []
  if (query.get('response_type') !== 'code') problems.push('response_type must be "code".')
  if (state === '') problems.push('Missing state (the OAuth CSRF guard).')
  const codeChallenge = query.get('code_challenge') ?? ''
  if (codeChallenge === '' || query.get('code_challenge_method') !== 'S256') {
    problems.push('Missing PKCE S256 (code_challenge with code_challenge_method=S256).')
  }
  if (query.get('scope') !== SCOPE) problems.push(`scope must be exactly "${SCOPE}": the blog only reads the public profile.`)
  if (problems.length > 0) {
    warn(`authorize rejected: ${problems.join(' ')}`)
    const items = problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('\n')
    return page(res, 400, 'Invalid authorization request', `<h1>Invalid authorization request</h1>\n<ul>\n${items}\n</ul>`)
  }

  /** @type {AuthorizeRequest} */
  const request = { redirectUri, state, codeChallenge, expiresAt: Date.now() + PENDING_TTL_MS }
  const login = cookie(req, 'mock_user')
  const user = login === null ? undefined : userByLogin(login)
  if (user) return approve(res, request, user)
  if (login !== null) warn(`mock_user cookie does not match any fake user: ${login}`)

  const requestId = randomBytes(12).toString('hex')
  remember(store.pending, requestId, request)
  return chooser(res, requestId, login)
}

/** The buttons on the account chooser page. Each authorize can only be decided once. */
async function decide(req, res) {
  const body = await readBody(req)
  if (body === null) return page(res, 413, 'Request too large', '<h1>Request too large</h1>')
  const form = new URLSearchParams(body)
  const requestId = form.get('request') ?? ''
  const request = store.pending.get(requestId)
  store.pending.delete(requestId)
  if (!request || request.expiresAt <= Date.now()) {
    return page(
      res,
      400,
      'Request expired',
      '<h1>The authorization request expired</h1>\n<p>Go back to the blog and start signing in again.</p>',
    )
  }
  if (form.get('decision') === 'deny') return deny(res, request)
  const user = userByLogin(form.get('login') ?? '')
  if (!user) return page(res, 400, 'No such account', '<h1>No such fake account</h1>')
  return approve(res, request, user)
}

// --- GitHub: exchange a code for a token -----------------------------------------------------------

/** GitHub returns JSON when the client asks for it (`Accept: application/json`, like Spring), otherwise form-urlencoded. */
function tokenReply(res, accept, payload) {
  if (/json/i.test(accept)) return sendJson(res, 200, payload)
  return send(res, 200, 'application/x-www-form-urlencoded; charset=utf-8', new URLSearchParams(payload).toString())
}

/** An error of the token hop: GitHub returns it with HTTP 200, not 4xx. */
function tokenError(res, accept, error, description) {
  tokenReply(res, accept, {
    error,
    error_description: description,
    error_uri: `${DOCS}/troubleshooting-oauth-app-access-token-request-errors#${error.replace(/_/g, '-')}`,
  })
}

/** The body of the token hop: form-urlencoded (Spring), or JSON (GitHub accepts that too). */
function tokenForm(req, body) {
  if (!/json/i.test(req.headers['content-type'] ?? '')) return new URLSearchParams(body)
  try {
    const json = JSON.parse(body)
    if (json === null || typeof json !== 'object') return new URLSearchParams()
    return new URLSearchParams(Object.entries(json).filter(([, value]) => typeof value === 'string'))
  } catch {
    return new URLSearchParams()
  }
}

async function token(req, res) {
  const accept = req.headers.accept ?? ''
  if (injectFailure('token', req, res, accept)) return
  const body = await readBody(req)
  if (body === null) return sendJson(res, 413, { message: 'Payload Too Large' })
  const form = tokenForm(req, body)

  const client = basicClient(req.headers.authorization) ?? { id: form.get('client_id'), secret: form.get('client_secret') }
  if (client.id !== CLIENT_ID || client.secret !== CLIENT_SECRET) {
    return tokenError(res, accept, 'incorrect_client_credentials', 'The client_id and/or client_secret passed are incorrect.')
  }
  if (form.get('grant_type') !== 'authorization_code') {
    return tokenError(res, accept, 'unsupported_grant_type', 'The grant type is not supported.')
  }
  const code = form.get('code') ?? ''
  const grant = store.codes.get(code)
  // Single use, even when this attempt fails at a later step: GitHub does not allow retrying a code either.
  store.codes.delete(code)
  if (!grant || grant.expiresAt <= Date.now()) {
    return tokenError(res, accept, 'bad_verification_code', 'The code passed is incorrect or expired.')
  }
  // Spring sends the redirect_uri and code_verifier taken from the stored request: if missing or different,
  // the blob did not keep them.
  if (form.get('redirect_uri') !== grant.redirectUri) {
    return tokenError(
      res,
      accept,
      'redirect_uri_mismatch',
      'The redirect_uri MUST match the registered callback URL for this application.',
    )
  }
  const verifier = form.get('code_verifier') ?? ''
  if (verifier === '' || s256(verifier) !== grant.codeChallenge) {
    return tokenError(res, accept, 'bad_verification_code', 'The code_verifier does not match the code_challenge.')
  }

  const accessToken = `gho_e2e_${randomBytes(16).toString('hex')}`
  remember(store.tokens, accessToken, { userId: grant.userId, expiresAt: Number.POSITIVE_INFINITY })
  return tokenReply(res, accept, { access_token: accessToken, token_type: 'bearer', scope: SCOPE })
}

// --- GitHub: profile ------------------------------------------------------------------------------

function user(req, res) {
  if (injectFailure('user', req, res, '')) return
  if (!req.headers['user-agent']) {
    return sendJson(res, 403, {
      message: 'Request forbidden by administrative rules. Please make sure your request has a User-Agent header.',
    })
  }
  const match = /^(?:Bearer|token)\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  const grant = match ? store.tokens.get(match[1]) : undefined
  const found = grant ? store.users.get(grant.userId) : undefined
  if (!found)
    return sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' })
  return sendJson(res, 200, githubProfile(found))
}

// --- Control from tests ---------------------------------------------------------------------------

/** Hold the response without answering, like a hung GitHub: the backend gives up after a 10 second read. */
function hold(req, res) {
  req.resume()
  const entry = {
    release() {
      clearTimeout(timer)
      heldResponses.delete(entry)
      res.destroy()
    },
  }
  const timer = setTimeout(() => entry.release(), HANG_MAX_MS)
  heldResponses.add(entry)
  res.on('close', () => {
    clearTimeout(timer)
    heldResponses.delete(entry)
  })
}

/** The failure installed for this hop, if any attempts remain: answer in place of the real hop and return true. */
function injectFailure(endpoint, req, res, accept) {
  const failure = store.failures.get(endpoint)
  if (!failure) return false
  failure.remaining -= 1
  if (failure.remaining <= 0) store.failures.delete(endpoint)
  if (failure.mode === 'hang') {
    hold(req, res)
    return true
  }
  req.resume()
  if (failure.mode === 'bad_code') tokenError(res, accept, 'bad_verification_code', 'The code passed is incorrect or expired.')
  else sendJson(res, failure.mode, { message: failure.mode >= 500 ? 'Server Error' : 'Injected failure' })
  return true
}

function fail(res, url) {
  const endpoint = url.searchParams.get('endpoint')
  const status = url.searchParams.get('status') ?? ''
  const times = Number(url.searchParams.get('times') ?? '1')
  if (endpoint !== 'token' && endpoint !== 'user') return sendJson(res, 400, { message: 'endpoint must be token or user' })
  /** @type {Failure['mode']} */
  let mode
  if (status === 'hang') mode = 'hang'
  else if (status === 'bad_code' && endpoint === 'token') mode = 'bad_code'
  else if (/^[45]\d\d$/.test(status)) mode = Number(status)
  else return sendJson(res, 400, { message: 'status must be a 4xx/5xx code, hang, or bad_code (token only)' })
  if (!Number.isInteger(times) || times < 1 || times > 100)
    return sendJson(res, 400, { message: 'times must be an integer from 1 to 100' })
  store.failures.set(endpoint, { mode, remaining: times })
  return sendJson(res, 200, { endpoint, status: mode, times })
}

const PATCHABLE = new Set(['login', 'name', 'email', 'avatarUrl'])

/** Change a fake user's profile, keeping the id: the next sign-in must return to the same old account. */
async function patchUser(req, res, id) {
  const current = store.users.get(id)
  if (!current) return sendJson(res, 404, { message: `No fake user with id ${id}` })
  const body = await readBody(req)
  let patch
  try {
    patch = JSON.parse(body ?? '')
  } catch {
    return sendJson(res, 400, { message: 'The body must be a JSON object' })
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return sendJson(res, 400, { message: 'The body must be a JSON object' })
  }
  const unknown = Object.keys(patch).filter((key) => !PATCHABLE.has(key))
  if (unknown.length > 0) return sendJson(res, 400, { message: `Fields that cannot be changed: ${unknown.join(', ')}` })

  const next = { ...current }
  if ('login' in patch) {
    if (typeof patch.login !== 'string' || patch.login === '' || patch.login.length > 100) {
      return sendJson(res, 400, { message: 'login must be a string of 1-100 characters' })
    }
    const owner = userByLogin(patch.login)
    if (owner && owner.id !== id)
      return sendJson(res, 409, { message: `login ${patch.login} already belongs to another fake user` })
    next.login = patch.login
  }
  for (const field of ['name', 'email']) {
    if (!(field in patch)) continue
    if (patch[field] !== null && typeof patch[field] !== 'string')
      return sendJson(res, 400, { message: `${field} must be a string or null` })
    next[field] = patch[field]
  }
  if ('avatarUrl' in patch) {
    if (typeof patch.avatarUrl !== 'string') return sendJson(res, 400, { message: 'avatarUrl must be a string' })
    next.avatarUrl = patch.avatarUrl
  }
  store.users.set(id, next)
  return sendJson(res, 200, githubProfile(next))
}

// --- Routing --------------------------------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url ?? '/', ORIGIN)
  const method = req.method ?? 'GET'
  switch (url.pathname) {
    case '/login/oauth/authorize':
      if (method === 'GET') return authorize(req, res, url)
      if (method === 'POST') return decide(req, res)
      return methodNotAllowed(res, 'GET, POST')
    case '/login/oauth/access_token':
      return method === 'POST' ? token(req, res) : methodNotAllowed(res, 'POST')
    case '/user':
      return method === 'GET' ? user(req, res) : methodNotAllowed(res, 'GET')
    case '/__e2e/health':
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
      return sendJson(res, 200, { status: 'ok', clientId: CLIENT_ID, callback: CALLBACK })
    case '/__e2e/reset':
      if (method !== 'POST') return methodNotAllowed(res, 'POST')
      reset()
      res.writeHead(204)
      return res.end()
    case '/__e2e/fail':
      return method === 'POST' ? fail(res, url) : methodNotAllowed(res, 'POST')
  }
  const userPath = /^\/__e2e\/users\/(\d{1,15})$/.exec(url.pathname)
  if (userPath) return method === 'PATCH' ? patchUser(req, res, Number(userPath[1])) : methodNotAllowed(res, 'PATCH')
  return sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })
}

reset()

/** The path to log, never the query: the query of authorize and callback contains the state and code. */
function pathOf(req) {
  try {
    return new URL(req.url ?? '/', ORIGIN).pathname
  } catch {
    // The broken URL itself is the error being reported: throwing here would become an uncaught rejection and kill the fake.
    return '(unreadable URL)'
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    warn(`unexpected error at ${req.method} ${pathOf(req)}: ${error instanceof Error ? error.message : String(error)}`)
    if (!res.headersSent) sendJson(res, 500, { message: 'mock GitHub error' })
    else res.destroy()
  })
})
// The JDK HttpClient (backend) keeps an idle connection for 30 seconds. The server holds it longer than that so it never
// closes a connection just as the backend resends the token-exchange request on it (a POST is not resent).
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
server.on('error', (error) => {
  warn(
    error.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use by another process. Stop it, or let Playwright reuse the running fake.`
      : `The fake GitHub could not start: ${error.message}`,
  )
  process.exit(1)
})
server.listen(PORT, HOST, () => {
  console.log(`Fake GitHub ready at ${ORIGIN} (client ${CLIENT_ID}, callback ${CALLBACK})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const entry of heldResponses) entry.release()
    server.close()
    process.exit(0)
  })
}
