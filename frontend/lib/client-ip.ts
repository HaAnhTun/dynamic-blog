import { isIP } from 'node:net'

/**
 * The reader's IP for the IP-based rate limiters: GitHub login and the admin
 * password login in lib/rate-limit.ts, the view beacon in app/api/views/route.ts. The same value is forwarded to the
 * backend for its own per-address limits (`clientIpHeaders` below).
 *
 * The FIRST entry of X-Forwarded-For is something the client sends itself, forgeable at will. The trustworthy entry is the one
 * written by one's own proxy: the nginx in the README uses `$proxy_add_x_forwarded_for`, which APPENDS
 * `$remote_addr` to the end. So count from the right, skipping exactly the number of trusted proxies
 * (`TRUSTED_PROXY_HOPS`, 1–5, default 1; 2 when Cloudflare sits in front of nginx).
 *
 * The selected entry must be an IP address (node:net `isIP`: IPv4 with four numbers 0–255, IPv6 including
 * `::ffff:a.b.c.d`). Junk strings, `unknown`, an IP with a port or in square brackets all become null, meaning
 * "IP unknown" (the shared bucket of lib/rate-limit.ts), not a key of their own. If that entry is broken we
 * also do not fall back to another entry: every entry to its left was sent by the client. node:net rather than a
 * hand-written regex: this module only runs on Node, in route handlers, server pages and proxy.ts (Next 16's
 * proxy defaults to the Node.js runtime and rejects a `runtime` option); there is no edge route.
 *
 * If Next is exposed directly to the internet (no proxy) this key can still be forged: Next only fills XFF when it
 * is absent (base-server.js), and whatever XFF the client sends Next keeps. That is why compose only
 * publishes Next's port on 127.0.0.1, and the README requires nginx in front.
 */

const DEFAULT_HOPS = 1

/** Read at call time, not at module load: changing env needs no rebuild, and tests can change it. */
function trustedHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim() ?? ''
  return /^[1-5]$/.test(raw) ? Number(raw) : DEFAULT_HOPS
}

export function clientIp(request: Request): string | null {
  return clientIpFromHeaders(request.headers)
}

const warned = new Set<string>()

/**
 * Says once per process, in production only, that a request did not come through the proxy chain that TRUSTED_PROXY_HOPS describes
 * (issue 017): the header is missing, or has fewer entries than hops. That is Next reached without the proxy, a proxy that does not
 * append the address, or a number of hops that is too high; every such request counts as an unknown address. The line carries no
 * address, only the setting.
 */
function warnOnce(reason: 'missing' | 'short', hops: number): void {
  if (process.env.NODE_ENV !== 'production' || warned.has(reason)) return
  warned.add(reason)
  const what =
    reason === 'missing'
      ? 'a request arrived with no X-Forwarded-For'
      : 'an X-Forwarded-For has fewer entries than TRUSTED_PROXY_HOPS'
  console.warn(
    `[client-ip] ${what} (TRUSTED_PROXY_HOPS=${hops}): it did not come through the configured proxies, so its per-IP limits use the shared unknown address. ` +
      'Check the proxy (it must append the address to X-Forwarded-For) and the number of hops; this is said once.',
  )
}

/** Like `clientIp`, for server pages that read headers with `headers()` from next/headers (e.g. `/search`). */
export function clientIpFromHeaders(headers: Pick<Headers, 'get'>): string | null {
  const hops = trustedHops()
  const header = headers.get('x-forwarded-for')
  if (header === null) {
    warnOnce('missing', hops)
    return null
  }
  const entries = header.split(',').map((entry) => entry.trim())
  const index = entries.length - hops
  if (index < 0) {
    warnOnce('short', hops)
    return null
  }
  const ip = entries[index] ?? ''
  return isIP(ip) === 0 ? null : ip
}

/** The reader's address as Next worked it out, for the backend's per-address limits. */
export const CLIENT_IP_HEADER = 'x-client-ip'
/** The shared secret (`CLIENT_IP_TOKEN`) that proves to the backend that this server wrote `x-client-ip`. */
export const CLIENT_IP_TOKEN_HEADER = 'x-client-ip-token'

/**
 * The two headers that tell the backend which reader a request is made for, to merge into the headers of a backend call
 * that has a per-address limit there (contact, newsletter, sign-in, refresh, setup, search).
 *
 * `ip` is what `clientIp` returned for the visitor's own request, never something the visitor sent: the backend believes
 * the address only because the token comes with it (a constant-time compare on its side), and counts the socket address
 * when the token is missing or wrong. With a token but no address (`null`: the proxy chain gave none we trust) only the
 * token is sent, and the backend counts the request under one shared "unknown" key, kept apart from direct callers.
 *
 * Without `CLIENT_IP_TOKEN` (a dev stack) nothing is sent: the backend would ignore the address anyway, and it should not
 * travel without the secret that makes it believable. Read at call time, not at module load: changing the env needs no
 * rebuild, and tests can change it. The value is trimmed, because the backend trims the same variable.
 */
export function clientIpHeaders(ip: string | null): Record<string, string> {
  const token = process.env.CLIENT_IP_TOKEN?.trim() ?? ''
  if (token === '') return {}
  return ip === null ? { [CLIENT_IP_TOKEN_HEADER]: token } : { [CLIENT_IP_HEADER]: ip, [CLIENT_IP_TOKEN_HEADER]: token }
}
