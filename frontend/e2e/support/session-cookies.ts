/**
 * The names of the session cookies of the stack under test (lib/auth-cookies.ts). The E2E stack is a production build, where the
 * names carry the `__Host-` prefix and the cookies are Secure (Chrome accepts Secure and `__Host-` on http://localhost, like the
 * `__Host-oauth_flow` cookie of the GitHub sign-in). The names of the releases before the prefix are what an upgrade deletes.
 */
export const ACCESS_COOKIE = '__Host-access_token'
export const REFRESH_COOKIE = '__Host-refresh_token'
export const SESSION_COOKIES = [ACCESS_COOKIE, REFRESH_COOKIE]
/** The names the cookies had before the prefix: deleted by every response that sets or clears the session in production. */
export const LEGACY_SESSION_COOKIES = ['access_token', 'refresh_token']
