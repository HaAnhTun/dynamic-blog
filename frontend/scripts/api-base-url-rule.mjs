/**
 * The address of the backend API, from the run-time variable `API_BASE_URL`. One function for every caller: twenty modules used to read
 * `process.env.API_BASE_URL ?? 'http://localhost:8080'` themselves, so none of them could say anything about a bad value.
 *
 * Next sends bearer tokens, the views token and the client address (`CLIENT_IP_TOKEN`) to this URL, so in production (the only place
 * it is checked, the development server, the tests and the E2E stack all talk to `http://localhost:...`) it must not be plain `http` to
 * a host that other machines can sit between. Accepted:
 * - any `https` URL;
 * - `http` to the machine itself (`localhost`, `127.0.0.0/8`, `::1`);
 * - `http` to a single-label name such as `backend`: the service name of Docker Compose, resolved on its private network;
 * - anything else only with `API_ALLOW_PLAINTEXT=true`, the operator's statement that the link is a private network (a VPN, a VPC)
 *   he trusts. A public name or address over plain `http` is refused: the start then fails loudly instead of a split deployment
 *   (a platform such as Vercel or Koyeb in front of a backend elsewhere) quietly sending its tokens in the clear.
 *
 * The message names the host and the variable, never the rest of the value (it may carry credentials or a token).
 *
 * Plain JavaScript with no imports, because two places run it: the pages and route handlers (through lib/api-base-url.ts) and
 * scripts/start-check.mjs, which refuses to start the container before the server is up. Without the second one a bad value only showed
 * as a 500 on every route that talks to the API, while the healthcheck (/robots.txt) stayed green.
 */
const DEFAULT_API_BASE_URL = 'http://localhost:8080'

/** @typedef {Record<string, string | undefined>} Env */

/** @param {string} host */
function isLoopback(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * A name with no dot that is not an address: what Docker Compose and Kubernetes give a service on their private network.
 * @param {string} host
 */
function isServiceName(host) {
  return host !== '' && !host.includes('.') && !host.includes(':')
}

/**
 * @param {Env} [env]
 * @returns {string}
 */
export function apiBaseUrl(env = process.env) {
  const configured = env.API_BASE_URL?.trim()
  const value = configured ? configured : DEFAULT_API_BASE_URL
  if (env.NODE_ENV !== 'production') return value

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('API_BASE_URL is not a valid URL (expected https://host or http://service-name:port).')
  }
  if (url.protocol === 'https:') return value
  if (url.protocol !== 'http:') throw new Error('API_BASE_URL must be an http or https URL.')
  const host = url.hostname
  if (isLoopback(host) || isServiceName(host) || env.API_ALLOW_PLAINTEXT === 'true') return value
  throw new Error(
    `API_BASE_URL uses plain http to ${host}, which carries bearer tokens and the views token in the clear. ` +
      'Use https, or a service name on a private network (http://backend:8080), or set API_ALLOW_PLAINTEXT=true if the link is a ' +
      'private network you trust (docs/CONFIGURATION.md, "Split deployment").',
  )
}
