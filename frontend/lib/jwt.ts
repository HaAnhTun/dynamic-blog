export type JwtPayload = Record<string, unknown> & { exp?: unknown; role?: unknown }

/**
 * Decodes the payload WITHOUT verifying the signature, and that is correct here: this
 * runs in middleware, which is deciding whether to spend a refresh call, not whether to
 * trust the token. The backend verifies the signature on every request, and that is the
 * check that matters. Nothing in the frontend may make an authorization decision about
 * DATA from this — see `roleOf`'s note.
 *
 * Now the role claim also gates UI NAVIGATION — proxy.ts and the layout of
 * (shell) send a non-ADMIN to /admin/login?reason=forbidden. That is still a decision about
 * the screen, not about data: a forged claim only opens an empty admin shell, because all data goes through the
 * backend, where the signature is checked.
 *
 * Returns null rather than throwing for anything malformed. A cookie can hold a
 * truncated value or a leftover from an older format, and middleware runs on every
 * /admin request, so a throw here is a 500 on every admin page.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null

  try {
    // base64url, not base64: the JWT spec uses - and _ where base64 uses + and /, and
    // atob rejects those outright. Padding is stripped in a JWT and must be restored.
    const base64 = segments[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    // Decode as UTF-8. atob yields one char per byte, so a multi-byte character — every
    // Vietnamese letter with a diacritic — comes out mojibake without this step.
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as JwtPayload
  } catch {
    return null
  }
}

/**
 * True when the token is already expired, will expire within `marginSeconds`, or cannot
 * be read at all. Failing closed on an unreadable token means it gets refreshed; the
 * alternative is treating it as valid forever and letting the author be logged out at
 * the API with no way to recover.
 */
export function isExpiringWithin(token: string, marginSeconds: number): boolean {
  const exp = decodeJwtPayload(token)?.exp
  if (typeof exp !== 'number') return true
  return exp - marginSeconds <= Math.floor(Date.now() / 1000)
}

/**
 * The role as the token asserts it, for deciding what to render, never what is permitted.
 * The backend re-reads the current role from the database for ADMIN/AUTHOR claims
 * and a role change revokes the refresh token, so a stale claim lasts at most one access
 * token (15 minutes) and only shows controls the API then refuses with a 403.
 *
 * "What to render" includes which screens a visitor may route to: /admin admits ADMIN and
 * AUTHOR in proxy.ts and the (shell) layout. Still UX routing, never a data decision.
 */
export function roleOf(token: string): string | null {
  const role = decodeJwtPayload(token)?.role
  return typeof role === 'string' ? role : null
}

/**
 * The token's `sub`: the user id (UUID) the backend writes (TokenService). The Users page uses it to
 * recognize the row of the logged-in user and not draw the suspend button there — still only a matter of drawing:
 * the backend itself rejects an admin suspending themselves (409 USER_NOT_SUSPENDABLE), whatever the claim says.
 */
export function subjectOf(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub
  return typeof sub === 'string' && sub !== '' ? sub : null
}
